// Account switching is an explicit operation on the caller's own page. The caller
// owns the connection, task lock and page lifecycle. No account list is bundled.
import { SEL } from './selectors.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_TEXT = ['Log in', 'Login', '登录'];
const CONTINUE_TEXT = ['Continue', '继续'];
const GOOGLE_TEXT = ['Continue with Google', '使用 Google 继续', '通过 Google 继续'];

// These probes return state, never password/code values or whole-page contents.
export const ACCOUNT_STATE_JS = `(() => {
  const visible = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const buttons = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const emailInput = [...document.querySelectorAll('input[type="email"],input[placeholder="Email address"]')].some(visible);
  const login = buttons.some(b => ${JSON.stringify(LOGIN_TEXT)}.includes((b.innerText || '').trim()));
  const google = buttons.some(b => ${JSON.stringify(GOOGLE_TEXT)}.some(t => (b.innerText || '').trim().includes(t)));
  const auth = location.hostname === 'auth.openai.com' || location.hostname === 'accounts.google.com';
  const path = location.pathname;
  const text = auth ? (document.body?.innerText || '') : '';
  let manual = null;
  if ([...document.querySelectorAll('input[type="password"]')].some(visible)) manual = 'PASSWORD';
  else if ([...document.querySelectorAll('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]')].some(visible)
      || (auth && /email-verification|verify-email|challenge\\/|verification/i.test(path))) manual = 'VERIFICATION';
  else if (auth && (/signup|create-account/i.test(path) || /create your account/i.test(text))) manual = 'SIGNUP';
  else if (auth && /unsupported_country_region_territory|unsupported country/i.test(text)) manual = 'REGION';
  else if (auth && /verify you are human|checking your browser/i.test(text)) manual = 'CHALLENGE';
  const chooser = location.hostname === 'accounts.google.com'
    && !!document.querySelector('[data-identifier],[data-email]');
  return { manual, loading: ['loading', 'interactive'].includes(document.readyState), authenticated: location.hostname === 'chatgpt.com'
      && !!document.querySelector(${JSON.stringify(SEL.profile)})
      && !!document.querySelector(${JSON.stringify(SEL.composerAll)}),
    loginReady: login || emailInput || google, emailInput, google, chooser };
})()`;

// An email must come from a labelled account-settings field, not a display name,
// arbitrary body text, conversation contents or the login form just filled in.
export const ACCOUNT_IDENTITY_JS = `(() => {
  if (location.hostname !== 'chatgpt.com'
      || !(/^\\/settings\\/account\\/?$/i.test(location.pathname)
        || /settings[\\/=-]account/i.test(location.hash))) return null;
  const valid = value => {
    const s = String(value || '').trim().toLowerCase();
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s) ? s : null;
  };
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const value = el => {
    if (!visible(el)) return null;
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName || '') && !el.readOnly && !el.disabled) return null;
    return valid(el.value || el.textContent);
  };
  if (/^\\/settings\\/account\\/?$/i.test(location.pathname)) {
    for (const control of document.querySelectorAll('main button[aria-label^="Change email:"],main button[aria-label^="更改电子邮件："]')) {
      if (!visible(control)) continue;
      const label = control.getAttribute?.('aria-label') || '';
      const found = valid(label.replace(/^(?:Change email:|更改电子邮件：)\\s*/i, ''));
      if (found) return found;
    }
  }
  const scopes = [...document.querySelectorAll('[data-testid="account-settings"],[data-testid="settings-account"],section[data-settings-section="account"],[role="dialog"],[role="tabpanel"][data-state="active"]')].filter(visible);
  for (const scope of scopes) {
    for (const field of scope.querySelectorAll('[data-testid="account-email"],[data-testid="settings-email"],input[type="email"][readonly],input[type="email"][disabled],[aria-label="Email"],[aria-label="Email address"],[aria-label="电子邮件"]')) {
      const found = value(field); if (found) return found;
    }
    for (const label of scope.querySelectorAll('label,dt,[data-testid="email-label"]')) {
      if (!/^(email|email address|邮箱|电子邮件)[:：]?$/i.test((label.textContent || '').trim())) continue;
      const control = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
      const found = value(control) || value(label.nextElementSibling);
      if (found) return found;
    }
  }
  return null;
})()`;

/** A small injectable boundary makes the actual state machine independently testable. */
export function createAccountDriver(page, cdp, sid, { sleep = delay } = {}) {
  const recoverable = (error) =>
    ['ERR_BROWSER_TIMEOUT', 'ERR_CDP_DETACHED', 'ACCOUNT_UI_TIMEOUT', -32001].includes(error?.code) ||
    /context.*destroyed|session.*not found|CDP.*超时/i.test(error?.message || '');
  async function refreshSession() {
    if (!page.targetId || typeof cdp.forgetSession !== 'function' || typeof cdp.session !== 'function')
      return false;
    // Reattach only this owned target. Navigation and login are never repeated.
    await cdp.call('Target.detachFromTarget', { sessionId: sid }, null, 2000).catch(() => {});
    cdp.forgetSession(page.targetId);
    sid = await cdp.session(page.targetId, 8000);
    return true;
  }
  async function evaluateOnce(expression) {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(expression, 8000),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new AccountError('ACCOUNT_UI_TIMEOUT', 'Account page did not respond')),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function evaluate(expression) {
    try {
      return await evaluateOnce(expression);
    } catch (error) {
      if (!recoverable(error) || !(await refreshSession())) throw error;
      return evaluateOnce(expression); // A single read-only retry on a fresh session.
    }
  }
  async function nativeClick(expression) {
    const rect = await evaluate(`(() => {
      const el = ${expression}; if (!el) return null;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
      el.scrollIntoView({block:'center'}); const p = el.getBoundingClientRect();
      return {x:Math.round(p.left+p.width/2),y:Math.round(p.top+p.height/2)};
    })()`);
    if (!rect) return false;
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect }, sid);
    await cdp.call(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 },
      sid,
    );
    await sleep(50);
    await cdp.call(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 },
      sid,
    );
    return true;
  }
  const button = (texts) => `[...document.querySelectorAll('button,a,[role="button"]')].find(e => {
    const r=e.getBoundingClientRect(); return r.width>0 && r.height>0
      && ${JSON.stringify(texts)}.includes((e.innerText||'').trim()); })`;
  const input = `[...document.querySelectorAll('input[type="email"],input[placeholder="Email address"]')].find(e => {
    const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && !e.disabled && !e.readOnly; })`;
  const navigate = async (url) => {
    let result;
    try {
      result = await cdp.call('Page.navigate', { url }, sid, 10000);
    } catch (error) {
      if (!recoverable(error) || !(await refreshSession())) throw error;
      // A timeout can follow an already committed navigation. Reconcile, never resend.
      if ((await evaluateOnce('location.href')) === url) return;
      throw error;
    }
    if (result?.errorText)
      throw new AccountError('ACCOUNT_NAVIGATION_FAILED', `Account navigation failed: ${result.errorText}`);
  };
  return {
    probe: () => evaluate(ACCOUNT_STATE_JS),
    readIdentity: () => evaluate(ACCOUNT_IDENTITY_JS),
    openSettings: () => navigate('https://chatgpt.com/settings/account'),
    logout: () => navigate('https://chatgpt.com/auth/logout'),
    openLogin: () => nativeClick(button(LOGIN_TEXT)),
    continueGoogle: () => nativeClick(button(GOOGLE_TEXT)),
    chooseGoogle: (email) =>
      nativeClick(`[...document.querySelectorAll('[data-identifier],[data-email]')].find(e => {
      const r=e.getBoundingClientRect();
      return r.width>0 && r.height>0 && ['data-identifier','data-email'].some(key =>
        (e.getAttribute(key)||'').trim().toLowerCase() === ${JSON.stringify(email)}); })`),
    async submitEmail(email) {
      if (!(await nativeClick(input))) throw new AccountError('ACCOUNT_UI_CHANGED', 'No visible email input');
      for (const event of [
        { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
        { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
        { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      ])
        await cdp.call('Input.dispatchKeyEvent', event, sid);
      await cdp.call('Input.insertText', { text: email }, sid);
      await sleep(150);
      const actual = await evaluate(`(${input})?.value || ''`);
      if (normalizeEmail(actual) !== email)
        throw new AccountError('ACCOUNT_INPUT_FAILED', 'Email input did not match; login was not submitted');
      if (!(await nativeClick(button(CONTINUE_TEXT))))
        throw new AccountError('ACCOUNT_UI_CHANGED', 'No visible Continue button');
    },
  };
}

function assertNoManual(state) {
  if (!state.manual) return;
  const messages = {
    PASSWORD: 'Password required; complete login manually',
    VERIFICATION: 'Verification required; complete login manually',
    SIGNUP: 'Registration required; complete account setup manually',
    REGION: 'Login unavailable in the current region; inspect the browser manually',
    CHALLENGE: 'Browser challenge requires manual interaction',
  };
  throw new AccountError(
    `ACCOUNT_${state.manual}_REQUIRED`,
    messages[state.manual] || 'Manual login required',
  );
}

/**
 * Switch using an existing email/Google SSO session and verify the settings email.
 * Never reads or fills passwords/verification codes, creates an account, closes
 * pages, or changes any target other than the page supplied by the caller.
 */
export async function switchAccount(
  page,
  cdp,
  sid,
  {
    email,
    provider = 'email',
    timeoutMs = 120000,
    log = () => {},
    driver,
    clock = { now: Date.now, sleep: delay },
  } = {},
) {
  email = normalizeEmail(email);
  if (
    (!EMAIL.test(email) && !(provider === 'google' && !email)) ||
    !['email', 'google'].includes(provider) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647
  )
    throw new AccountError(
      'ACCOUNT_INVALID_ARGUMENT',
      'An exact email (optional for Google), email/google provider and positive timeout are required',
    );
  const ui = driver || createAccountDriver(page, cdp, sid, { sleep: clock.sleep });
  const deadline = clock.now() + timeoutMs;
  const remaining = () => deadline - clock.now();
  async function poll(predicate, label, limitMs = remaining()) {
    const until = Math.min(deadline, clock.now() + limitMs);
    do {
      const state = await ui.probe();
      assertNoManual(state);
      const value = await predicate(state);
      if (value) return value;
      if (clock.now() >= until) break;
      await clock.sleep(Math.min(400, until - clock.now()));
    } while (clock.now() <= until);
    throw new AccountError('ACCOUNT_TIMEOUT', `Timed out waiting for ${label}`);
  }
  async function identity({ required }) {
    await ui.openSettings();
    try {
      return await poll(
        async () => {
          const actual = normalizeEmail(await ui.readIdentity());
          return EMAIL.test(actual) ? actual : null;
        },
        'the labelled account email',
        Math.min(10000, remaining()),
      );
    } catch (error) {
      if (error.code !== 'ACCOUNT_TIMEOUT') throw error;
      if (!required) return null;
      throw new AccountError(
        'ACCOUNT_IDENTITY_UNVERIFIED',
        'Signed in, but the exact account email could not be verified in account settings',
      );
    }
  }

  const initial = await poll(
    (s) => (!s.loading && (s.authenticated || s.loginReady) ? s : null),
    'loaded login state',
  );
  if (initial.authenticated) {
    const current = await identity({ required: false });
    if (email && current === email) {
      log('Already signed in to the verified target account');
      return { email, provider, changed: false, verified: true };
    }
    if (remaining() <= 0) throw new AccountError('ACCOUNT_TIMEOUT', 'Timed out before switching accounts');
    await ui.logout();
    await poll((s) => !s.loading && !s.authenticated && s.loginReady, 'logout to complete');
    log('Signed out; using the requested SSO login');
  }

  let state = await poll((s) => (!s.loading && s.loginReady ? s : null), 'loaded login controls');
  const formReady = (s) => !s.loading && (s.emailInput || (provider === 'google' && s.google));
  if (!formReady(state)) {
    // Server-rendered login buttons may precede their event handlers. Only the
    // harmless form opener can be tried again; credentials/SSO submit remain once.
    for (let attempt = 0; attempt < 4; attempt++) {
      state = await poll((s) => (!s.loading && s.loginReady ? s : null), 'loaded login controls');
      if (formReady(state)) break;
      const clicked = await ui.openLogin();
      try {
        state = await poll((s) => (formReady(s) ? s : null), 'login form', Math.min(8000, remaining()));
        break;
      } catch (error) {
        if (error.code !== 'ACCOUNT_TIMEOUT' || remaining() <= 0) throw error;
        if (attempt === 3) {
          if (!clicked) throw new AccountError('ACCOUNT_UI_CHANGED', 'No working visible Log in button');
          throw error;
        }
        log('Login form is not ready; rechecking the form opener');
      }
    }
  }
  if (provider === 'google') {
    if (!(await ui.continueGoogle()))
      throw new AccountError('ACCOUNT_UI_CHANGED', 'No visible Continue with Google button');
  } else await ui.submitEmail(email);

  let chosenGoogle = false;
  await poll(async (s) => {
    if (s.loading) return false;
    if (s.authenticated) return true;
    if (provider === 'google' && s.chooser && !chosenGoogle) {
      if (!email)
        throw new AccountError(
          'ACCOUNT_GOOGLE_SELECTION_REQUIRED',
          'Google shows multiple accounts; choose the intended account manually or specify --email',
        );
      if (!(await ui.chooseGoogle(email)))
        throw new AccountError(
          'ACCOUNT_GOOGLE_SELECTION_REQUIRED',
          'The requested email is not in the Google account chooser; select or sign in manually',
        );
      chosenGoogle = true;
    }
    return false;
  }, 'SSO login');
  const actual = await identity({ required: true });
  if (email && actual !== email)
    throw new AccountError('ACCOUNT_MISMATCH', 'The signed-in email does not match the requested account');
  log(email ? 'Verified the requested account email' : 'Verified the observed Google account email');
  return {
    email: actual,
    provider,
    changed: true,
    verified: true,
    ...(email ? {} : { identityMatch: 'observed' }),
  };
}
