import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  switchAccount,
  AccountError,
  createAccountDriver,
  ACCOUNT_STATE_JS,
  ACCOUNT_IDENTITY_JS,
} from '../lib/account.mjs';
import { SEL } from '../lib/selectors.mjs';

const target = 'target@example.com';
function harness({
  current = 'old@example.com',
  final = target,
  manual = null,
  google = false,
  listed = true,
  stall = false,
} = {}) {
  const calls = [];
  let now = 0;
  let phase = current ? 'authenticated' : 'logged-out';
  let afterLogin = false;
  const clock = {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(1, ms);
    },
  };
  const driver = {
    async probe() {
      calls.push('probe');
      return {
        authenticated: phase === 'authenticated',
        loginReady: ['logged-out', 'form'].includes(phase),
        emailInput: phase === 'form',
        google: phase === 'form',
        chooser: phase === 'chooser',
        manual: phase === 'manual' ? manual : null,
      };
    },
    async openSettings() {
      calls.push('settings');
      phase = 'settings';
    },
    async readIdentity() {
      calls.push('identity');
      return afterLogin ? final : current;
    },
    async logout() {
      calls.push('logout');
      phase = 'logged-out';
    },
    async openLogin() {
      calls.push('login');
      phase = 'form';
      return true;
    },
    async submitEmail(email) {
      calls.push(['submit', email]);
      afterLogin = true;
      phase = manual ? 'manual' : stall ? 'pending' : 'authenticated';
    },
    async continueGoogle() {
      calls.push('google');
      afterLogin = true;
      phase = manual ? 'manual' : google ? 'chooser' : 'authenticated';
      return true;
    },
    async chooseGoogle(email) {
      calls.push(['choose', email]);
      if (listed) phase = 'authenticated';
      return listed;
    },
  };
  return { calls, driver, clock };
}
const run = (h, options = {}) =>
  switchAccount(null, null, null, {
    email: target,
    driver: h.driver,
    clock: h.clock,
    ...options,
  });

test('account validates exact email and provider before any browser action', async () => {
  for (const opts of [
    { email: null },
    { email: 'display-name' },
    { provider: 'other' },
    { timeoutMs: NaN },
    { timeoutMs: 0 },
    { timeoutMs: 2147483648 },
  ]) {
    const h = harness();
    await assert.rejects(run(h, opts), { code: 'ACCOUNT_INVALID_ARGUMENT' });
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  const result = await run(h, { email: null, provider: 'google' });
  assert.equal(result.email, target);
  assert.equal(result.identityMatch, 'observed');
});

test('account short-circuits only on the verified settings email', async () => {
  const h = harness({ current: 'TARGET@EXAMPLE.COM' });
  const result = await run(h);
  assert.deepEqual(result, { email: target, provider: 'email', changed: false, verified: true });
  assert.ok(h.calls.includes('settings'));
  assert.ok(!h.calls.includes('logout'));
  assert.ok(!h.calls.some((c) => Array.isArray(c) && c[0] === 'submit'));
});

test('account verifies the email after a different account was signed out', async () => {
  const h = harness();
  assert.equal((await run(h)).changed, true);
  assert.ok(h.calls.includes('logout'));
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'submit').length, 1);
  assert.deepEqual(
    h.calls.find((c) => Array.isArray(c)),
    ['submit', target],
  );
  assert.equal(h.calls.filter((c) => c === 'settings').length, 2);
  assert.ok(!h.calls.some((c) => /close|targets|password|code/i.test(String(c))));
});

test('account never accepts a mismatched signed-in email', async () => {
  const h = harness({ final: 'someone-else@example.com' });
  await assert.rejects(run(h), { code: 'ACCOUNT_MISMATCH' });
});

test('account cannot report success when the final settings email is unavailable', async () => {
  const h = harness({ current: null, final: null });
  await assert.rejects(run(h), { code: 'ACCOUNT_IDENTITY_UNVERIFIED' });
});

test('account can switch when the old settings email cannot be read', async () => {
  const h = harness();
  const realRead = h.driver.readIdentity;
  let reads = 0;
  h.driver.readIdentity = async () => (++reads <= 26 ? null : realRead());
  const result = await run(h);
  assert.equal(result.verified, true);
  assert.ok(h.calls.includes('logout'));
});

test('Google chooses only the requested exact email and verifies it after SSO', async () => {
  const h = harness({ google: true });
  const result = await run(h, { provider: 'google' });
  assert.equal(result.verified, true);
  assert.deepEqual(h.calls.filter(Array.isArray), [['choose', target]]);
  assert.ok(!h.calls.some((c) => Array.isArray(c) && c[0] === 'submit'));
});

test('Google account selection requires manual action if the requested account is absent', async () => {
  const h = harness({ google: true, listed: false });
  await assert.rejects(run(h, { provider: 'google' }), { code: 'ACCOUNT_GOOGLE_SELECTION_REQUIRED' });
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'choose').length, 1);
});

test('password, verification, signup and challenge states stop without another login action', async () => {
  for (const manual of ['PASSWORD', 'VERIFICATION', 'SIGNUP', 'REGION', 'CHALLENGE']) {
    const h = harness({ manual });
    await assert.rejects(run(h), { code: `ACCOUNT_${manual}_REQUIRED` });
    assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'submit').length, 1);
    assert.equal(h.calls.filter((c) => c === 'settings').length, 1);
  }
});

test('an incomplete SSO flow times out without automatically retrying login', async () => {
  const h = harness({ current: null, stall: true });
  await assert.rejects(run(h, { timeoutMs: 1000 }), { code: 'ACCOUNT_TIMEOUT' });
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'submit').length, 1);
});

function element({ text = '', value = '', attrs = {}, visible = true } = {}) {
  return {
    textContent: text,
    innerText: text,
    value,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: visible ? 20 : 0,
      height: visible ? 10 : 0,
    }),
    getAttribute: (name) => attrs[name] ?? null,
    scrollIntoView() {},
  };
}

test('settings identity probe ignores body emails and unlabelled/login email inputs', () => {
  const loginEmail = element({ value: target });
  const document = {
    body: { innerText: `Display name ${target}` },
    querySelectorAll: () => [],
    getElementById: () => loginEmail,
  };
  const location = { hostname: 'chatgpt.com', pathname: '/settings/account', hash: '' };
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
  location.pathname = '/';
  document.querySelectorAll = () => [{ ...element(), querySelectorAll: () => [loginEmail] }];
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
});

test('settings identity probe reads a scoped account email field or associated label control', () => {
  const field = element({ text: ' TARGET@EXAMPLE.COM ' });
  const scope = {
    ...element(),
    querySelectorAll: (selector) => (selector.startsWith('[data-testid=') ? [field] : []),
  };
  const document = { querySelectorAll: () => [scope], getElementById: () => null };
  const location = { hostname: 'chatgpt.com', pathname: '/', hash: '#settings/Account' };
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), target);
  const label = element({ text: 'Email address' });
  label.control = element({ value: target });
  scope.querySelectorAll = (selector) => (selector.startsWith('label,') ? [label] : []);
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), target);
});

test('settings identity probe refuses editable email fields and hidden cached settings', () => {
  const field = { ...element({ value: target }), tagName: 'INPUT', readOnly: false, disabled: false };
  const scope = { ...element(), querySelectorAll: () => [field] };
  const document = { querySelectorAll: () => [scope], getElementById: () => null };
  const location = { hostname: 'chatgpt.com', pathname: '/settings/account', hash: '' };
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
  field.readOnly = true;
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), target);
  scope.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
});

test('state probe detects manual password state without reading the password value', () => {
  const password = element();
  Object.defineProperty(password, 'value', {
    get() {
      throw new Error('Password read');
    },
  });
  const document = {
    body: { innerText: 'Log in' },
    querySelectorAll: (selector) => (selector === 'input[type="password"]' ? [password] : []),
    querySelector: () => null,
  };
  const location = { hostname: 'auth.openai.com', pathname: '/log-in/password' };
  assert.equal(vm.runInNewContext(ACCOUNT_STATE_JS, { document, location }).manual, 'PASSWORD');
});

test('state probe recognizes both supported composer shapes through the shared selector', () => {
  const seen = [];
  const document = {
    querySelectorAll: () => [],
    querySelector: (selector) => {
      seen.push(selector);
      return [SEL.profile, SEL.composerAll].includes(selector) ? {} : null;
    },
  };
  const location = { hostname: 'chatgpt.com', pathname: '/' };
  assert.equal(vm.runInNewContext(ACCOUNT_STATE_JS, { document, location }).authenticated, true);
  assert.ok(seen.includes(SEL.composerAll));
});

test('production email driver uses native clicks and verifies input before Continue', async () => {
  const input = element();
  let submitted = false;
  const button = element({ text: 'Continue' });
  const document = {
    querySelectorAll: (selector) => (selector.startsWith('input') ? [input] : [button]),
  };
  const events = [];
  const page = { evaluate: async (expression) => vm.runInNewContext(expression, { document }) };
  const cdp = {
    async call(method, event, sid) {
      assert.equal(sid, 'own-session');
      events.push([method, event]);
      if (method === 'Input.insertText') input.value = event.text;
      if (method === 'Input.dispatchMouseEvent' && event.type === 'mouseReleased' && input.value)
        submitted = true;
    },
  };
  const driver = createAccountDriver(page, cdp, 'own-session', { sleep: async () => {} });
  await driver.submitEmail(target);
  assert.equal(submitted, true);
  assert.equal(events.filter(([method]) => method === 'Input.insertText').length, 1);
  assert.ok(events.every(([method]) => method.startsWith('Input.')));
});

test('production email driver refuses to Continue if native input did not take effect', async () => {
  const input = element({ value: 'old@example.com' });
  const button = element({ text: 'Continue' });
  let clicks = 0;
  const document = { querySelectorAll: (selector) => (selector.startsWith('input') ? [input] : [button]) };
  const page = { evaluate: async (expression) => vm.runInNewContext(expression, { document }) };
  const cdp = {
    async call(method, event) {
      if (method === 'Input.dispatchMouseEvent' && event.type === 'mouseReleased') clicks++;
    },
  };
  const driver = createAccountDriver(page, cdp, 'own-session', { sleep: async () => {} });
  await assert.rejects(
    driver.submitEmail(target),
    (error) => error instanceof AccountError && error.code === 'ACCOUNT_INPUT_FAILED',
  );
  assert.equal(clicks, 1, 'Only the email input was clicked; Continue was untouched');
});

test('production Google chooser skips hidden duplicates and matches complete emails', async () => {
  const choices = [
    element({ attrs: { 'data-identifier': target }, visible: false }),
    element({ attrs: { 'data-identifier': 'other-target@example.com' } }),
    element({ attrs: { 'data-identifier': 'opaque-google-id', 'data-email': target } }),
  ];
  const document = { querySelectorAll: () => choices };
  const page = { evaluate: async (expression) => vm.runInNewContext(expression, { document }) };
  let clicks = 0;
  const cdp = {
    async call(method, event) {
      if (method === 'Input.dispatchMouseEvent' && event.type === 'mouseReleased') clicks++;
    },
  };
  const driver = createAccountDriver(page, cdp, 'own-session', { sleep: async () => {} });
  assert.equal(await driver.chooseGoogle(target), true);
  assert.equal(clicks, 1);
  assert.equal(await driver.chooseGoogle('absent@example.com'), false);
  assert.equal(clicks, 1);
});

test('existing Google SSO verifies the resulting settings email without choosing an arbitrary account', async () => {
  const h = harness({ google: true });
  await assert.rejects(run(h, { email: undefined, provider: 'google' }), {
    code: 'ACCOUNT_GOOGLE_SELECTION_REQUIRED',
  });
  assert.ok(!h.calls.some(Array.isArray));
});

test('full-page account settings reads only the visible labelled Change email control', () => {
  const control = element({ attrs: { 'aria-label': 'Change email: TARGET@EXAMPLE.COM' } });
  const document = { querySelectorAll: (selector) => (selector.startsWith('main button') ? [control] : []) };
  const location = { hostname: 'chatgpt.com', pathname: '/settings/account', hash: '' };
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), target);
  control.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
  location.pathname = '/c/example';
  assert.equal(vm.runInNewContext(ACCOUNT_IDENTITY_JS, { document, location }), null);
});

test('account state tolerates an auth document before body creation and marks navigation as loading', () => {
  const document = {
    readyState: 'loading',
    body: null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const location = { hostname: 'auth.openai.com', pathname: '/log-in' };
  const state = vm.runInNewContext(ACCOUNT_STATE_JS, { document, location });
  assert.equal(state.loading, true);
  assert.equal(state.manual, null);
});

test('account probe reattaches its owned target once after a lost read session', async () => {
  let reads = 0;
  const events = [];
  const page = {
    targetId: 'owned',
    evaluate: async () => {
      if (++reads === 1) throw Object.assign(new Error('lost session'), { code: 'ERR_CDP_DETACHED' });
      return { authenticated: true };
    },
  };
  const cdp = {
    call: async (method, params) => events.push([method, params]),
    forgetSession: (id) => events.push(['forget', id]),
    session: async (id) => {
      events.push(['attach', id]);
      return 'fresh';
    },
  };
  assert.equal((await createAccountDriver(page, cdp, 'old').probe()).authenticated, true);
  assert.equal(reads, 2);
  assert.deepEqual(events, [
    ['Target.detachFromTarget', { sessionId: 'old' }],
    ['forget', 'owned'],
    ['attach', 'owned'],
  ]);
});
test('account reconciles a committed navigation timeout without navigating twice', async () => {
  let navigations = 0;
  const page = { targetId: 'owned', evaluate: async () => 'https://chatgpt.com/settings/account' };
  const cdp = {
    call: async (method) => {
      if (method === 'Page.navigate') {
        navigations++;
        throw Object.assign(new Error('timeout'), { code: 'ERR_BROWSER_TIMEOUT' });
      }
    },
    forgetSession: () => {},
    session: async () => 'fresh',
  };
  await createAccountDriver(page, cdp, 'old').openSettings();
  assert.equal(navigations, 1);
});

test('logout waits for loaded login controls before attempting to open the form', async () => {
  const h = harness();
  const logout = h.driver.logout,
    probe = h.driver.probe,
    open = h.driver.openLogin;
  let loadingReads = 0;
  h.driver.logout = async () => {
    await logout();
    loadingReads = 2;
  };
  h.driver.probe = async () => ({ ...(await probe()), loading: loadingReads > 0 && !!loadingReads-- });
  h.driver.openLogin = async () => {
    assert.equal(loadingReads, 0, 'A button from a still-loading logout document must not be clicked');
    return open();
  };
  assert.equal((await run(h)).verified, true);
});

test('an unhydrated form opener can be reobserved and retried without repeating submission', async () => {
  const h = harness({ current: null });
  const open = h.driver.openLogin;
  let attempts = 0;
  h.driver.openLogin = async () => (++attempts === 1 ? true : open());
  const result = await run(h);
  assert.equal(result.verified, true);
  assert.equal(attempts, 2);
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'submit').length, 1);
});
test('a permanently inert form opener is bounded and never submits an email', async () => {
  const h = harness({ current: null });
  let attempts = 0;
  h.driver.openLogin = async () => {
    attempts++;
    return true;
  };
  await assert.rejects(run(h), { code: 'ACCOUNT_TIMEOUT' });
  assert.equal(attempts, 4);
  assert.ok(!h.calls.some(Array.isArray));
});
