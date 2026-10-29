import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNetworkError,
  normalizeNetworkCode,
  networkErrorMessage,
  readErrorPage,
  watchMainDocumentFailure,
} from '../lib/network.mjs';

test('normalizeNetworkCode strips net:: and ERR_ prefixes', () => {
  assert.equal(normalizeNetworkCode('net::ERR_PROXY_CONNECTION_FAILED'), 'PROXY_CONNECTION_FAILED');
  assert.equal(normalizeNetworkCode('ERR_TIMED_OUT'), 'TIMED_OUT');
  assert.equal(normalizeNetworkCode('connectionClosed'), 'CONNECTIONCLOSED');
  assert.equal(normalizeNetworkCode(''), null);
  assert.equal(normalizeNetworkCode(null), null);
});

test('classifyNetworkError groups proxy, connection and timeout codes', () => {
  assert.equal(classifyNetworkError('net::ERR_PROXY_CONNECTION_FAILED').kind, 'proxy');
  assert.equal(classifyNetworkError('ERR_TUNNEL_CONNECTION_FAILED').kind, 'proxy');
  assert.equal(classifyNetworkError('net::ERR_CONNECTION_CLOSED').kind, 'connection');
  assert.equal(classifyNetworkError('ERR_CONNECTION_REFUSED').kind, 'connection');
  assert.equal(classifyNetworkError('net::ERR_TIMED_OUT').kind, 'timeout');
  assert.equal(classifyNetworkError('ERR_NAME_NOT_RESOLVED').kind, 'dns');
  assert.equal(classifyNetworkError('ERR_INTERNET_DISCONNECTED').kind, 'offline');
});

test('classifyNetworkError marks unrecognized codes as unknown', () => {
  const c = classifyNetworkError('ERR_SOMETHING_NEW');
  assert.equal(c.kind, 'unknown');
  assert.equal(c.code, 'ERR_SOMETHING_NEW');
  assert.equal(classifyNetworkError(''), null);
});

test('networkErrorMessage includes the code and actionable hint', () => {
  const msg = networkErrorMessage(classifyNetworkError('net::ERR_PROXY_CONNECTION_FAILED'));
  assert.match(msg, /代理/);
  assert.match(msg, /ERR_PROXY_CONNECTION_FAILED/);
});

test('readErrorPage classifies a chrome-error page and null otherwise', async () => {
  const errorPage = { evaluate: async () => 'ERR_CONNECTION_CLOSED' };
  const net = await readErrorPage(errorPage);
  assert.equal(net.kind, 'connection');
  const normalPage = { evaluate: async () => null };
  assert.equal(await readErrorPage(normalPage), null);
  assert.equal(await readErrorPage(null), null);
});

test('watchMainDocumentFailure resolves on a Document failure and ignores other types', async () => {
  let handler = null;
  const client = {
    on(method, h, sid) {
      assert.equal(method, 'Network.loadingFailed');
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  const watch = watchMainDocumentFailure(client, 'sid');
  handler({ type: 'Image', errorText: 'net::ERR_CONNECTION_CLOSED' });
  handler({ type: 'Document', errorText: 'net::ERR_PROXY_CONNECTION_FAILED' });
  const net = await watch.promise;
  assert.equal(net.kind, 'proxy');
});

test('watchMainDocumentFailure returns a never-resolving watcher for clients without on', async () => {
  const watch = watchMainDocumentFailure({}, 'sid');
  let settled = false;
  watch.promise.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  watch.stop();
});
