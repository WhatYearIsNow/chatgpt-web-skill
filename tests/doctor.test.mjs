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

const navigateClient = (navigateResult) => {
  const closed = { value: false };
  return {
    closed,
    createTarget: async () => 'target-1',
    session: async () => 'sid-1',
    on: () => () => {},
    call: async (method) => {
      if (method === 'Network.enable') return {};
      if (method === 'Page.navigate') return navigateResult;
      return {};
    },
    close: async () => {
      closed.value = true;
    },
  };
};

test('doctor reports network-unreachable when navigation fails immediately', async () => {
  const client = navigateClient({ errorText: 'net::ERR_PROXY_CONNECTION_FAILED' });
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'dedicated', dedicatedPort: 9230 }),
      ensureDedicatedBrowser: async () => ({ client }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-unreachable');
  assert.equal(result.network.kind, 'proxy');
  assert.match(result.hint, /代理/);
  assert.equal(client.closed.value, true);
});

test('doctor reports network-unreachable from the chrome-error page', async () => {
  const client = navigateClient({ frameId: 'frame-1' });
  const result = await doctor(
    {},
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'unknown',
      readErrorPage: async () => ({ kind: 'connection', code: 'ERR_CONNECTION_CLOSED' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-unreachable');
  assert.equal(result.network.kind, 'connection');
});

test('doctor image contract works through the default probe (no injection)', async () => {
  const client = mockClient();
  const result = await doctor(
    { imageContract: 'https://chat.example.invalid/c/00000000-0000-0000-0000-000000000000' },
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'ready',
      // 不注入 imageContractProbe：走默认接线（回归 2026-11-12 缺省漏接）。
      Page: class {
        async close() {}
        async evaluate(expression) {
          const vm = await import('node:vm');
          const image = { src: 'http://fixture.invalid/i', alt: 'Generated image 1' };
          const assistant = { querySelectorAll: () => [image] };
          const documentMock = {
            querySelectorAll: (selector) => {
              if (selector === '[data-chatgpt-search-unit-key$=":user"]')
                return [{ getAttribute: () => 'u:user' }];
              if (selector === '[data-chatgpt-search-unit-key$=":assistant"]') return [assistant];
              if (selector === '[data-talvt-turn-state]') return [{ querySelectorAll: () => [] }];
              if (selector === 'img') return [image];
              throw new Error(`Unknown selector ${selector}`);
            },
          };
          return vm.runInNewContext(expression, { document: documentMock, location: { pathname: '/c/x' } });
        }
        async waitForFunction() {}
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.imageContract.ok, true);
  assert.equal(result.imageContract.scopeCount, 1);
  assert.equal(result.imageContract.docCount, 1);
});

test('doctor image contract passes on a healthy conversation', async () => {
  const client = mockClient();
  const result = await doctor(
    { imageContract: 'https://chat.example.invalid/c/00000000-0000-0000-0000-000000000000' },
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'ready',
      imageContractProbe: async () => ({ scopeCount: 1, docCount: 1 }),
      Page: class {
        async close() {}
        async evaluate() {}
        async waitForFunction() {}
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.imageContract.ok, true);
  assert.equal(result.imageContract.drift, false);
});

test('doctor image contract flags drift and flips ok to false with an actionable reason', async () => {
  const client = mockClient();
  const result = await doctor(
    { imageContract: 'https://chat.example.invalid/c/00000000-0000-0000-0000-000000000000' },
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'ready',
      imageContractProbe: async () => ({ scopeCount: 0, docCount: 2 }),
      Page: class {
        async close() {}
        async evaluate() {}
        async waitForFunction() {}
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.imageContract.drift, true);
  assert.equal(result.reason, 'image-contract-drift');
});

test('doctor image contract reports unavailable when the probe throws', async () => {
  const client = mockClient();
  const result = await doctor(
    { imageContract: 'https://chat.example.invalid/c/00000000-0000-0000-0000-000000000000' },
    {
      ...baseOverrides,
      resolveBrowserOptions: async () => ({ mode: 'endpoint', endpoint: 'http://127.0.0.1:9222' }),
      connectToUserChrome: async () => client,
      loginState: async () => 'ready',
      imageContractProbe: async () => {
        throw new Error('probe exploded');
      },
      Page: class {
        async close() {}
        async evaluate() {}
        async waitForFunction() {}
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image-contract-unavailable');
});
