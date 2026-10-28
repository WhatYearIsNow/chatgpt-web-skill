/**
 * Read-only doctor preflight for chatgpt-web. Node.js >=22.15; no runtime deps.
 *
 * Resolves the connection selection, starts/connects the browser, opens a
 * throwaway probe tab, and reports the login state. It never sends a prompt,
 * never modifies the user's daily browser and closes both the probe tab and its
 * own connection before returning. A failed top-level navigation (proxy/network
 * down) is classified and reported in seconds instead of waiting for a task
 * timeout. Run it before real work:
 *
 *   node scripts/doctor.mjs
 */

import { resolveBrowserOptions } from './config.mjs';
import { connectToUserChrome, Page, sleep } from './browser.mjs';
import { activatePage, loginState } from './chatgpt.mjs';
import { ensureManagedBrowser, ensureDedicatedBrowser } from './launch.mjs';
import { getDataDir } from './storage.mjs';
import {
  classifyNetworkError,
  networkErrorMessage,
  readErrorPage,
  watchMainDocumentFailure,
} from './network.mjs';

const CHATGPT_URL = 'https://chatgpt.com/';
const LOGIN_PROBE_MS = 15000;
const POLL_MS = 500;

/**
 * Run the read-only doctor check. Returns a structured report; never throws for
 * an expected failure (not configured, login required, network unreachable).
 */
export async function doctor(options = {}, overrides = {}) {
  const O = {
    resolveBrowserOptions,
    connectToUserChrome,
    ensureManagedBrowser,
    ensureDedicatedBrowser,
    Page,
    activatePage,
    loginState,
    getDataDir,
    classifyNetworkError,
    networkErrorMessage,
    readErrorPage,
    watchMainDocumentFailure,
    ...overrides,
  };

  const report = {
    ok: false,
    mode: null,
    endpoint: null,
    dataDir: null,
    loginState: null,
    network: null,
    hint: null,
    checkedAt: new Date().toISOString(),
  };

  let config;
  try {
    config = await O.resolveBrowserOptions(options);
  } catch (error) {
    report.mode = 'error';
    report.reason = 'config-error';
    report.hint = error.message;
    return report;
  }

  report.mode = config.mode;
  report.dataDir = O.getDataDir();

  if (config.mode === 'disabled') {
    report.reason = 'not-configured';
    report.hint =
      'No browser connection is configured. Set CHATGPT_WEB_CDP_URL to an existing local CDP endpoint, ' +
      'CHATGPT_WEB_BROWSER_MODULE to a trusted local browser adapter, or run "browser login" to launch the managed browser.';
    return report;
  }

  let client;
  let probe = null;
  try {
    client = await connectBrowser(O, config, options);
    if (config.endpoint) report.endpoint = config.endpoint;
    probe = await openProbeTab(O, client);
    const outcome = await probeLogin(O, probe);
    report.loginState = outcome.loginState;
    report.network = outcome.network;

    if (outcome.network) {
      report.ok = false;
      report.reason = 'network-unreachable';
      report.hint = O.networkErrorMessage(outcome.network);
    } else if (outcome.loginState === 'ready') {
      report.ok = true;
    } else if (outcome.loginState === 'auth') {
      report.reason = 'login-required';
      report.hint =
        'Run "browser login" (or log in once inside the managed/dedicated browser window), then rerun the doctor.';
    } else {
      report.reason = 'unknown';
      report.hint =
        'Login state could not be confirmed within the probe window. Open https://chatgpt.com/ in the connected browser to check.';
    }
  } catch (error) {
    report.reason = 'connection-failed';
    report.hint = error.message;
  } finally {
    if (probe) {
      try {
        await new O.Page(client, probe.targetId).close({ timeoutMs: 4000 });
      } catch {
        /* Probe tab cleanup is best-effort. */
      }
    }
    try {
      await client?.close?.();
    } catch {
      /* Connection cleanup is best-effort. */
    }
  }

  return report;
}

async function connectBrowser(O, config, options) {
  if (config.mode === 'managed') {
    const launched = await O.ensureManagedBrowser({
      timeoutMs: 20000,
      executable: config.chromePath,
      headless: !!config.headless,
    });
    return launched.client;
  }
  if (config.mode === 'dedicated') {
    const launched = await O.ensureDedicatedBrowser({
      timeoutMs: 20000,
      executable: config.chromePath,
      headless: !!config.headless,
      minimized: !!config.dedicatedMinimized,
      port: config.dedicatedPort,
    });
    return launched.client;
  }
  return O.connectToUserChrome({ timeoutMs: 60000, ...options });
}

/**
 * Open a throwaway tab and arm network failure detection. A client exposing
 * call()/on() (the bundled CDPClient) opens about:blank, attaches a Network
 * watcher, then navigates, so even an immediate proxy failure is captured.
 * Other clients fall back to creating the target with the URL directly.
 */
async function openProbeTab(O, client) {
  const canNavigate = typeof client.call === 'function' && typeof client.on === 'function';
  if (!canNavigate) {
    const targetId = await client.createTarget(CHATGPT_URL);
    return { client, targetId, sid: null, watch: null, immediateNetwork: null };
  }
  const targetId = await client.createTarget('about:blank');
  const sid = await client.session(targetId);
  await client.call('Network.enable', {}, sid);
  const watch = O.watchMainDocumentFailure(client, sid);
  let nav;
  try {
    nav = await client.call('Page.navigate', { url: CHATGPT_URL }, sid);
  } catch (error) {
    watch.stop();
    throw error;
  }
  const immediateNetwork = nav?.errorText ? O.classifyNetworkError(nav.errorText) : null;
  return { client, targetId, sid, watch, immediateNetwork };
}

/** Probe login state and network failure until one is known or the budget ends. */
async function probeLogin(O, probe) {
  const page = new O.Page(probe.client, probe.targetId);
  if (probe.immediateNetwork) {
    probe.watch?.stop?.();
    return { loginState: null, network: probe.immediateNetwork };
  }

  const deadline = Date.now() + LOGIN_PROBE_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      probe.watch?.stop?.();
      return { loginState: 'unknown', network: null };
    }
    // Wait for a network failure event or one poll tick, whichever is first.
    const tick = sleep(Math.min(POLL_MS, left));
    let net = null;
    if (probe.watch) {
      net = await Promise.race([probe.watch.promise, tick.then(() => null)]);
    } else {
      await tick;
    }
    if (net) {
      probe.watch?.stop?.();
      return { loginState: null, network: net };
    }

    const state = await O.loginState(page).catch(() => 'unknown');
    const errPage = await O.readErrorPage(page).catch(() => null);
    if (errPage) {
      probe.watch?.stop?.();
      return { loginState: null, network: errPage };
    }
    if (state === 'ready' || state === 'auth') {
      probe.watch?.stop?.();
      return { loginState: state, network: null };
    }
  }
}
