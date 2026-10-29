import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loginState } from '../lib/chatgpt.mjs';

function mockPage({
  url = 'https://chatgpt.com/',
  textarea = false,
  contenteditable = false,
  loginHref = false,
  controls = [],
}) {
  const parsed = new URL(url);
  const location = { hostname: parsed.hostname, href: parsed.href, pathname: parsed.pathname };
  const document = {
    querySelector(selector) {
      if (selector === 'textarea[placeholder="Ask ChatGPT"]') return textarea ? {} : null;
      if (selector === 'div.ProseMirror[contenteditable="true"], [contenteditable="true"]')
        return contenteditable ? {} : null;
      if (selector === 'a[href*="/auth/login"]') return loginHref ? {} : null;
      throw new Error(`unexpected selector: ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === 'a,button')
        return controls.map((text) => ({ innerText: text, getAttribute: () => null }));
      return [];
    },
  };
  return {
    async evaluate(expression) {
      return vm.runInNewContext(expression, { document, location });
    },
  };
}

test('fresh landing page with a login/register control is detected as auth', async () => {
  for (const controls of [['Log in'], ['Sign up'], ['Get started'], ['登录']])
    assert.equal(await loginState(mockPage({ controls })), 'auth');
});

test('login link with a query string is detected as auth', async () => {
  assert.equal(await loginState(mockPage({ loginHref: true })), 'auth');
});

test('auth domain and in-site auth path are detected as auth', async () => {
  const authDomain = await loginState(mockPage({ url: 'https://auth.openai.com/' }));
  assert.equal(authDomain, 'auth');
  const authPath = await loginState(mockPage({ url: 'https://chatgpt.com/auth/login' }));
  assert.equal(authPath, 'auth');
});

test('composer (textarea or contenteditable) is detected as ready', async () => {
  assert.equal(await loginState(mockPage({ textarea: true })), 'ready');
  assert.equal(await loginState(mockPage({ contenteditable: true })), 'ready');
});

test('composer wins over a stray login control', async () => {
  assert.equal(await loginState(mockPage({ textarea: true, controls: ['Log in'] })), 'ready');
});

test('a transient page with no login control and no composer is unknown', async () => {
  // e.g. Cloudflare / "browser check" interstitial
  assert.equal(await loginState(mockPage({ controls: ['Verify you are human'] })), 'unknown');
});
