import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAction } from '../lib/browser-command.mjs';

test('browser actions route to the managed lifecycle under the shared browser lock', async () => {
  const calls = [];
  const client = {
    close() {
      calls.push('client-close');
    },
    createTarget: async () => {
      calls.push('create-tab');
      return 'tab-1';
    },
  };
  const d = {
    resolveBrowserOptions: async () => ({ mode: 'managed', chromePath: null, headless: false }),
    acquireLock: async (task) => {
      calls.push(['lock', task]);
      return async () => calls.push('release');
    },
    browserStatus: async (options) => {
      calls.push(['status', options.executable]);
      return { running: false };
    },
    ensureManagedBrowser: async (options) => {
      calls.push(['ensure', options.headless, options.executable]);
      return {
        client,
        reused: false,
        endpoint: 'ws://127.0.0.1:1/devtools/browser/x',
        executable: 'chrome',
        dir: 'managed-dir',
      };
    },
    closeManagedBrowser: async () => {
      calls.push('stop');
      return { stopped: true, endpoint: 'ws://127.0.0.1:1/devtools/browser/x' };
    },
    Page: class {
      constructor(cdp, targetId) {
        this.targetId = targetId;
      }
      async close() {
        calls.push(['tab-close', this.targetId]);
      }
    },
    waitForLogin: async (page) => {
      calls.push(['wait-login', page.targetId]);
      return true;
    },
  };

  assert.equal((await browserAction({ action: 'status', chrome: 'C:\\chrome.exe' }, d)).running, false);
  assert.deepEqual(calls.shift(), ['status', 'C:\\chrome.exe']);

  const start = await browserAction(
    { action: 'start', headless: true, chrome: null, lockTimeoutMs: 100, timeoutMs: 1000 },
    d,
  );
  assert.equal(start.reused, false);
  assert.equal(start.dataDir, 'managed-dir');
  assert.deepEqual(
    calls.filter((c) => Array.isArray(c) && c[0] === 'lock').map((c) => c[1]),
    ['browser'],
  );
  assert.ok(calls.includes('release') && calls.includes('client-close'));

  calls.length = 0;
  const login = await browserAction(
    { action: 'login', headless: false, chrome: null, lockTimeoutMs: 100, timeoutMs: 1000 },
    d,
  );
  assert.equal(login.loggedIn, true);
  assert.deepEqual(
    calls.filter((c) => Array.isArray(c)).map((c) => c[0]),
    ['lock', 'ensure', 'wait-login', 'tab-close'],
  );
  for (const event of ['create-tab', 'client-close', 'release'])
    assert.ok(calls.includes(event), `login must record ${event}`);

  calls.length = 0;
  const stop = await browserAction({ action: 'stop', lockTimeoutMs: 100 }, d);
  assert.equal(stop.stopped, true);
  assert.ok(calls.includes('stop'));
});

test('configured browser commands never launch or close the managed browser', async () => {
  const calls = [];
  const selected = { mode: 'endpoint', endpoint: 'ws://127.0.0.1:9333', profilePath: '/expected/profile' };
  const d = {
    resolveBrowserOptions: async () => selected,
    acquireLock: async () => {
      calls.push('lock');
      return () => calls.push('release');
    },
    ensureManagedBrowser: async () => assert.fail('must not launch'),
    closeManagedBrowser: async () => assert.fail('must not stop another browser'),
    browserStatus: async () => assert.fail('must not report a different browser'),
    connectToUserChrome: async (options) => {
      assert.equal(options.endpoint, selected.endpoint);
      assert.equal(options.profilePath, selected.profilePath);
      calls.push('connect');
      return {
        createTarget: async (url) => {
          calls.push(url);
          return 'owned';
        },
        close: () => calls.push('disconnect'),
      };
    },
    Page: class {
      async close() {
        calls.push('close-owned');
      }
    },
    waitForLogin: async () => true,
  };
  const status = await browserAction({ action: 'status' }, d);
  assert.equal(status.mode, 'endpoint');
  assert.equal(status.running, null);
  assert.equal(status.profileVerified, false);
  assert.deepEqual(calls, [], 'status must not connect or open a tab');
  assert.equal((await browserAction({ action: 'stop' }, d)).reason, 'external-browser');
  assert.deepEqual(calls, []);
  const result = await browserAction({ action: 'start' }, d);
  assert.equal(result.endpoint, selected.endpoint);
  assert.equal(result.profileVerified, true);
  assert.deepEqual(calls, ['lock', 'connect', 'about:blank', 'close-owned', 'disconnect', 'release']);
  calls.length = 0;
  assert.equal((await browserAction({ action: 'login' }, d)).loggedIn, true);
  assert.deepEqual(calls, [
    'lock',
    'connect',
    'https://chatgpt.com/',
    'close-owned',
    'disconnect',
    'release',
  ]);
  calls.length = 0;
  await assert.rejects(browserAction({ action: 'start', headless: true }, d), {
    code: 'ERR_BROWSER_CONFIGURATION',
  });
  d.connectToUserChrome = async () => {
    throw new Error('endpoint unavailable');
  };
  await assert.rejects(browserAction({ action: 'start' }, d), /endpoint unavailable/);
  assert.deepEqual(calls, ['lock', 'release'], 'failed connection must not fall back to launch');
});

test('explicit managed mode bypasses saved connections; disabled mode fails without launching', async () => {
  let launched = false;
  const d = {
    resolveBrowserOptions: async () => ({ mode: 'disabled' }),
    acquireLock: async () => async () => {},
    ensureManagedBrowser: async () => {
      launched = true;
      return { client: { close() {} }, endpoint: 'ws://127.0.0.1:1' };
    },
  };
  await assert.rejects(browserAction({ action: 'start' }, d), { code: 'ERR_CDP_CONFIGURATION' });
  assert.equal(launched, false);
  d.resolveBrowserOptions = async () => assert.fail('explicit managed mode must bypass saved configuration');
  assert.equal((await browserAction({ action: 'start', managed: true }, d)).mode, 'managed');
  assert.equal(launched, true);
});

test('failed external login still closes its owned tab, disconnects and releases the lock', async () => {
  const calls = [];
  await assert.rejects(
    browserAction(
      { action: 'login' },
      {
        resolveBrowserOptions: async () => ({ mode: 'adapter', browserModule: '/adapter.mjs' }),
        acquireLock: async () => () => calls.push('release'),
        connectToUserChrome: async () => ({
          createTarget: async () => 'owned',
          close: () => calls.push('disconnect'),
        }),
        Page: class {
          async close() {
            calls.push('close-owned');
          }
        },
        waitForLogin: async () => {
          throw new Error('login timeout');
        },
      },
    ),
    /login timeout/,
  );
  assert.deepEqual(calls, ['close-owned', 'disconnect', 'release']);
});
