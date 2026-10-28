import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../lib/doctor.mjs';

const mockClient = () => {
  const closed = { value: false };
  return {
    closed,
    createTarget: async () => 'target-1',
    session: async () => 'sid-1',
    close: async () => {
      closed.value = true;
    },
  };
};
class MockPage {
  async close() {}
}
const baseOverrides = {
  Page: MockPage,
  activatePage: async () => {},
  getDataDir: () => 'data-dir',
};

test('doctor reports not-configured when no connection is resolved', async () => {
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'disabled' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'disabled');
  assert.equal(result.reason, 'not-configured');
});

test('doctor returns ok for an external adapter with a ready login', async () => {
  const client = mockClient();
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({
        mode: 'adapter',
        browserModule: 'browser.mjs',
        profilePath: 'Profile 4',
      }),
      connectToUserChrome: async () => client,
      loginState: async () => 'ready',
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.loginState, 'ready');
  assert.equal(client.closed.value, true);
});

test('doctor returns ok=false for an external adapter on the login page', async () => {
  const client = mockClient();
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'auth',
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.loginState, 'auth');
  assert.match(result.hint, /browser login/);
});

test('doctor launches the managed browser and verifies login', async () => {
  const client = mockClient();
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'managed', headless: true, chromePath: 'chrome.exe' }),
      ensureManagedBrowser: async () => ({ client }),
      loginState: async () => 'ready',
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'managed');
});
