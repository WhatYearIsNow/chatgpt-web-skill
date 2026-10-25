import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAction } from '../lib/browser-command.mjs';

test('browser actions route to the managed lifecycle under the shared browser lock', async () => {
  const calls = [];
  const client = {
    close() { calls.push('client-close'); },
    createTarget: async () => { calls.push('create-tab'); return 'tab-1'; },
  };
  const d = {
    acquireLock: async (task) => { calls.push(['lock', task]); return async () => calls.push('release'); },
    browserStatus: async (options) => { calls.push(['status', options.executable]); return { running: false }; },
    ensureManagedBrowser: async (options) => {
      calls.push(['ensure', options.headless, options.executable]);
      return { client, reused: false, endpoint: 'ws://127.0.0.1:1/devtools/browser/x', executable: 'chrome', dir: 'managed-dir' };
    },
    closeManagedBrowser: async () => { calls.push('stop'); return { stopped: true, endpoint: 'ws://127.0.0.1:1/devtools/browser/x' }; },
    Page: class { constructor(cdp, targetId) { this.targetId = targetId; } async close() { calls.push(['tab-close', this.targetId]); } },
    waitForLogin: async (page) => { calls.push(['wait-login', page.targetId]); return true; },
  };

  assert.equal((await browserAction({ action: 'status', chrome: 'C:\\chrome.exe' }, d)).running, false);
  assert.deepEqual(calls.shift(), ['status', 'C:\\chrome.exe']);

  const start = await browserAction({ action: 'start', headless: true, chrome: null, lockTimeoutMs: 100, timeoutMs: 1000 }, d);
  assert.equal(start.reused, false);
  assert.equal(start.dataDir, 'managed-dir');
  assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === 'lock').map((c) => c[1]), ['browser']);
  assert.ok(calls.includes('release') && calls.includes('client-close'));

  calls.length = 0;
  const login = await browserAction({ action: 'login', headless: false, chrome: null, lockTimeoutMs: 100, timeoutMs: 1000 }, d);
  assert.equal(login.loggedIn, true);
  assert.deepEqual(calls.filter((c) => Array.isArray(c)).map((c) => c[0]), ['lock', 'ensure', 'wait-login', 'tab-close']);
  for (const event of ['create-tab', 'client-close', 'release']) assert.ok(calls.includes(event), `login must record ${event}`);

  calls.length = 0;
  const stop = await browserAction({ action: 'stop', lockTimeoutMs: 100 }, d);
  assert.equal(stop.stopped, true);
  assert.ok(calls.includes('stop'));
});
