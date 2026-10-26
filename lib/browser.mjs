/**
 * Minimal browser transport for chatgpt-web. Node.js >=22.15; no runtime dependencies.
 *
 * Set CHATGPT_WEB_CDP_URL to an existing loopback browser CDP HTTP or WebSocket
 * endpoint (for example http://127.0.0.1:9222 or ws://127.0.0.1:9333).
 * HTTP discovery uses /json/version; both URLs must be loopback addresses.
 * Endpoints that expose only WebSocket (pure relays and Chrome's
 * chrome://inspect/#remote-debugging switch mode, which serves 404 on /json/*)
 * must use the ws:// form; it connects directly without HTTP discovery.
 * Redirects, URL credentials, fragments and remote hosts are rejected.
 *
 * Alternatively set CHATGPT_WEB_BROWSER_MODULE to a trusted local ESM file
 * exporting connectToUserChrome({ timeoutMs }). The module executes arbitrary
 * local code and owns its connection behavior. An explicit CDP URL takes priority.
 * With neither configured, and managed launching not disabled
 * (CHATGPT_WEB_MANAGED=0 or config.json managed:false), an isolated managed
 * browser is launched instead (see lib/launch.mjs): a dedicated user-data-dir
 * under the private data directory, never the user's default browser or profiles.
 * An explicitly selected existing browser can be profile-pinned through its
 * internal version page. Existing profiles are never copied, junctioned or
 * used as managed launch directories. No OS dialog is approved, no JavaScript dialog is
 * accepted and no password is handled. close() disconnects this client;
 * Page.close() closes only its explicitly supplied target.
 */

import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolveBrowserOptions } from './config.mjs';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const now = () => performance.now();

export class BrowserError extends Error {
  constructor(message, { code = 'ERR_BROWSER', method, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BrowserError';
    this.code = code;
    if (method) this.method = method;
  }
}

function duration(value, name = 'timeoutMs', allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`${name} must be an integer between ${allowZero ? 0 : 1} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function timeout(label) {
  return new BrowserError(`${label} timed out`, { code: 'ERR_BROWSER_TIMEOUT' });
}

function remaining(deadline, label) {
  const ms = Math.ceil(deadline - now());
  if (ms <= 0) throw timeout(label);
  return ms;
}

function closeQuietly(client) {
  try {
    Promise.resolve(client?.close?.()).catch(() => {});
  } catch {
    /* Best-effort adapter cleanup. */
  }
}

/** A bounded wait which always removes its timer, including on rejection. */
async function within(promise, timeoutMs, label, onLateResult) {
  let timer;
  let expired = false;
  const result = Promise.resolve(promise).then((value) => {
    if (expired) onLateResult?.(value);
    return value;
  });
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(timeout(label));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A close acknowledgement precedes actual target destruction in Chromium. */
async function waitTargetGone(cdp, targetId, deadline, pollingMs) {
  for (;;) {
    // Validate the budget before starting any request. Native calls already own
    // their timer and pending cleanup; a competing outer timer could win first.
    const budget = remaining(deadline, 'CDP target closure');
    const request = cdp.call('Target.getTargets', {}, null, budget);
    const response =
      cdp instanceof CDPClient ? await request : await within(request, budget, 'CDP target closure');
    if (!Array.isArray(response?.targetInfos)) {
      throw new BrowserError('CDP getTargets returned no targetInfos while waiting for target closure', {
        code: 'ERR_CDP_PROTOCOL',
      });
    }
    if (!response.targetInfos.some((target) => target.targetId === targetId)) return;
    await sleep(Math.min(pollingMs, remaining(deadline, 'CDP target closure')));
  }
}

export function sleep(ms) {
  duration(ms, 'ms', true);
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Reject nonlocal endpoints before making a network request. No remote override. */
export function validateEndpoint(value, { websocketOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('CDP endpoint must be an absolute HTTP or WebSocket URL');
  }
  const allowed = websocketOnly ? ['ws:', 'wss:'] : ['http:', 'https:', 'ws:', 'wss:'];
  if (!allowed.includes(url.protocol)) throw new TypeError('CDP endpoint must use HTTP(S) or WS(S)');
  if (url.username || url.password || url.hash)
    throw new TypeError('CDP endpoint must not contain credentials or a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  if (!local) throw new TypeError('CDP endpoint must use a loopback address (localhost, 127.0.0.0/8 or ::1)');
  return url;
}

async function discoverWebSocket(endpoint, deadline) {
  const url = validateEndpoint(endpoint);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url;
  const probe = new URL('/json/version', url);
  const forms =
    'Only http(s) endpoints use /json/version discovery; ws(s) endpoints connect directly without it.';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining(deadline, 'CDP discovery'));
  try {
    const response = await fetch(probe, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      throw new BrowserError(
        `CDP discovery: ${probe} returned HTTP ${response.status}. ${forms} ` +
          `Chrome's chrome://inspect/#remote-debugging switch mode serves 404 on /json/* because it exposes only ` +
          'the browser WebSocket endpoint; use the ws:// form of CHATGPT_WEB_CDP_URL instead (for example a local ' +
          'relay such as ws://127.0.0.1:9333, or ws://127.0.0.1:9222/devtools/browser/<id>).',
        { code: 'ERR_CDP_DISCOVERY' },
      );
    }
    // Bound memory as well as time when a mistaken endpoint serves a large file.
    let body = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) {
        controller.abort();
        throw new BrowserError('CDP discovery response exceeds 1 MiB', { code: 'ERR_CDP_DISCOVERY' });
      }
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    let metadata;
    try {
      metadata = JSON.parse(body);
    } catch (cause) {
      throw new BrowserError('CDP discovery did not return JSON', { code: 'ERR_CDP_DISCOVERY', cause });
    }
    if (typeof metadata?.webSocketDebuggerUrl !== 'string') {
      throw new BrowserError('CDP discovery has no webSocketDebuggerUrl', { code: 'ERR_CDP_DISCOVERY' });
    }
    return validateEndpoint(metadata.webSocketDebuggerUrl, { websocketOnly: true });
  } catch (cause) {
    if (controller.signal.aborted && !(cause instanceof BrowserError)) throw timeout('CDP discovery');
    if (!(cause instanceof BrowserError)) {
      const detail = cause?.cause?.code || cause?.code || cause?.message || String(cause);
      throw new BrowserError(`CDP discovery could not reach ${probe} (${detail}). ${forms}`, {
        code: 'ERR_CDP_DISCOVERY',
        cause,
      });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Small CDP client using flattened sessions; no global/browser shutdown commands. */
export class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    this.pending = new Map();
    this.sessions = new Map();
    this.attaching = new Map();
    this.nextId = 0;
    this.onMessage = (event) => this.receive(event.data);
    this.onClose = () => this.shutdown(new BrowserError('CDP connection closed', { code: 'ERR_CDP_CLOSED' }));
    this.onError = () =>
      this.shutdown(new BrowserError('CDP WebSocket connection failed', { code: 'ERR_CDP_CLOSED' }));
    ws.addEventListener('message', this.onMessage);
    ws.addEventListener('close', this.onClose);
    ws.addEventListener('error', this.onError);
  }

  static async connect(endpoint, timeoutMs = 10_000) {
    duration(timeoutMs);
    if (typeof globalThis.WebSocket !== 'function')
      throw new BrowserError('Native WebSocket requires Node.js >=22.15');
    const deadline = now() + timeoutMs;
    const endpointUrl = validateEndpoint(endpoint, { websocketOnly: true });
    const ws = new WebSocket(endpointUrl);
    const client = new CDPClient(ws);
    let timer;
    let onOpen;
    let onError;
    let onClose;
    try {
      await new Promise((resolveOpen, reject) => {
        onOpen = resolveOpen;
        onError = () =>
          reject(
            new BrowserError(`CDP WebSocket handshake failed for ${endpointUrl}`, {
              code: 'ERR_CDP_CONNECT',
            }),
          );
        onClose = () =>
          reject(
            new BrowserError(`CDP WebSocket closed during handshake for ${endpointUrl}`, {
              code: 'ERR_CDP_CONNECT',
            }),
          );
        timer = setTimeout(() => reject(timeout('CDP connection')), remaining(deadline, 'CDP connection'));
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
        ws.addEventListener('close', onClose, { once: true });
      });
      await client.call(
        'Target.setDiscoverTargets',
        { discover: true },
        null,
        remaining(deadline, 'CDP connection'),
      );
      return client;
    } catch (cause) {
      client.close();
      throw cause;
    } finally {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    }
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.shutdown(new BrowserError('Malformed CDP response', { code: 'ERR_CDP_PROTOCOL' }));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.shutdown(new BrowserError('Malformed CDP response', { code: 'ERR_CDP_PROTOCOL' }));
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const detached = message.params?.sessionId;
      for (const [target, session] of this.sessions) {
        if (session === detached) this.sessions.delete(target);
      }
      for (const [id, pending] of this.pending) {
        if (detached && pending.sessionId === detached) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            new BrowserError('CDP target session detached', {
              code: 'ERR_CDP_DETACHED',
              method: pending.method,
            }),
          );
        }
      }
    }
    if (message.method === 'Target.targetDestroyed') {
      const targetId = message.params?.targetId;
      const sessionId = this.sessions.get(targetId);
      this.forgetSession(targetId);
      if (sessionId) {
        for (const [id, request] of this.pending) {
          if (request.sessionId !== sessionId) continue;
          clearTimeout(request.timer);
          this.pending.delete(id);
          request.reject(
            new BrowserError('CDP target was destroyed', {
              code: 'ERR_CDP_DETACHED',
              method: request.method,
            }),
          );
        }
      }
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // Events and late responses cannot settle a different request.
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new BrowserError(message.error.message || 'CDP command failed', {
          method: pending.method,
          code: message.error.code ?? 'ERR_CDP_PROTOCOL',
        }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  call(method, params = {}, sessionId = null, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    try {
      duration(timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof method !== 'string' || !method)
      return Promise.reject(new TypeError('CDP method must be a nonempty string'));
    if (this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new BrowserError('CDP connection is closed', { code: 'ERR_CDP_CLOSED', method }));
    }
    return new Promise((resolveCall, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`CDP command timed out: ${method}`, { code: 'ERR_BROWSER_TIMEOUT', method }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer, method, sessionId });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new BrowserError(`Unable to send CDP command: ${method}`, { cause, method, code: 'ERR_CDP_SEND' }),
        );
      }
    });
  }

  async session(targetId, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    duration(timeoutMs);
    if (typeof targetId !== 'string' || !targetId) throw new TypeError('targetId must be a nonempty string');
    if (this.closed) throw new BrowserError('CDP connection is closed', { code: 'ERR_CDP_CLOSED' });
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    let pending = this.attaching.get(targetId);
    if (!pending) {
      pending = this.call('Target.attachToTarget', { targetId, flatten: true }, null, timeoutMs)
        .then((response) => {
          if (this.closed) throw new BrowserError('CDP connection is closed', { code: 'ERR_CDP_CLOSED' });
          if (!response?.sessionId)
            throw new BrowserError('CDP attach returned no sessionId', { code: 'ERR_CDP_PROTOCOL' });
          this.sessions.set(targetId, response.sessionId);
          return response.sessionId;
        })
        .finally(() => this.attaching.delete(targetId));
      this.attaching.set(targetId, pending);
    }
    return within(pending, timeoutMs, 'CDP session attachment');
  }

  forgetSession(targetId) {
    this.sessions.delete(targetId);
  }

  async evaluate(targetId, expression, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    duration(timeoutMs);
    if (typeof expression !== 'string') throw new TypeError('evaluate expression must be a string');
    const deadline = now() + timeoutMs;
    const sessionId = await this.session(targetId, remaining(deadline, 'CDP evaluation'));
    const response = await this.call(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: remaining(deadline, 'CDP evaluation'),
      },
      sessionId,
      remaining(deadline, 'CDP evaluation'),
    );
    if (response?.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new BrowserError(
        `Page evaluation failed: ${detail.exception?.description || detail.text || 'JavaScript exception'}`,
        {
          code: 'ERR_CDP_EVALUATION',
          method: 'Runtime.evaluate',
        },
      );
    }
    const result = response?.result;
    if (result?.unserializableValue) {
      const value = result.unserializableValue;
      if (value === 'NaN') return NaN;
      if (value === 'Infinity') return Infinity;
      if (value === '-Infinity') return -Infinity;
      if (value === '-0') return -0;
      if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    }
    return result?.value;
  }

  async targets() {
    const response = await this.call('Target.getTargets');
    return (response?.targetInfos || []).filter((target) => target.type === 'page');
  }

  async createTarget(url = 'about:blank') {
    const response = await this.call('Target.createTarget', { url, newWindow: false });
    if (!response?.targetId)
      throw new BrowserError('CDP createTarget returned no targetId', { code: 'ERR_CDP_PROTOCOL' });
    return response.targetId;
  }

  async closeTarget(targetId, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, pollingMs = 50 } = {}) {
    duration(timeoutMs);
    duration(pollingMs, 'pollingMs');
    const deadline = now() + timeoutMs;
    const response = await this.call(
      'Target.closeTarget',
      { targetId },
      null,
      remaining(deadline, 'CDP target closure'),
    );
    if (response?.success === false)
      throw new BrowserError('CDP could not close the target', { code: 'ERR_CDP_PROTOCOL' });
    await waitTargetGone(this, targetId, deadline, pollingMs);
    this.forgetSession(targetId);
    return response;
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.sessions.clear();
    this.attaching.clear();
    this.ws.removeEventListener('message', this.onMessage);
    this.ws.removeEventListener('close', this.onClose);
    this.ws.removeEventListener('error', this.onError);
    try {
      this.ws.close();
    } catch {
      /* Already closed or handshake aborted. */
    }
  }

  close() {
    this.shutdown(new BrowserError('CDP connection closed by client', { code: 'ERR_CDP_CLOSED' }));
  }
}

/**
 * Name retained for existing callers. Connection is always explicitly configured:
 * endpoint, adapter, or the opt-out managed browser. Options endpoint/browserModule
 * override their corresponding environment variables; managedLauncher overrides
 * the default managed launcher for tests.
 */
export async function connectToUserChrome({
  timeoutMs = 60_000,
  endpoint = process.env.CHATGPT_WEB_CDP_URL,
  browserModule = process.env.CHATGPT_WEB_BROWSER_MODULE,
  profilePath = process.env.CHATGPT_WEB_PROFILE_PATH,
  managedLauncher = null,
} = {}) {
  duration(timeoutMs);
  const deadline = now() + timeoutMs;
  const config = await within(
    resolveBrowserOptions({ endpoint, browserModule, profilePath }),
    remaining(deadline, 'Browser configuration'),
    'Browser configuration',
  );
  ({ endpoint, browserModule, profilePath } = config);
  if (endpoint) {
    const wsUrl = await discoverWebSocket(endpoint, deadline);
    const client = await CDPClient.connect(wsUrl, remaining(deadline, 'CDP connection'));
    return withProfileGuard(client, profilePath);
  }
  if (!browserModule) {
    if (config.mode === 'managed') {
      const launch =
        managedLauncher || (async (options) => (await import('./launch.mjs')).ensureManagedBrowser(options));
      const { client } = await launch({
        timeoutMs: remaining(deadline, 'Managed browser launch'),
        executable: config.chromePath,
        headless: !!config.headless,
      });
      return client;
    }
    throw new BrowserError(
      'Set CHATGPT_WEB_CDP_URL to an existing local CDP endpoint, CHATGPT_WEB_BROWSER_MODULE to a trusted local browser adapter, or re-enable the managed browser (remove CHATGPT_WEB_MANAGED=0 / config.json managed:false)',
      {
        code: 'ERR_CDP_CONFIGURATION',
      },
    );
  }
  // A file path/URL is intentionally required: this is executable configuration,
  // not an automatic search through sibling skills or globally installed packages.
  let moduleUrl;
  if (browserModule.startsWith('file:')) {
    moduleUrl = new URL(browserModule);
  } else {
    if (!isAbsolute(browserModule))
      throw new TypeError('Browser module must be an absolute local path or file URL');
    moduleUrl = pathToFileURL(resolve(browserModule));
  }
  if (moduleUrl.host && moduleUrl.host !== 'localhost')
    throw new TypeError('Browser module must be a local file');
  const importBudget = remaining(deadline, 'Browser adapter import');
  const module = await within(import(moduleUrl.href), importBudget, 'Browser adapter import');
  if (typeof module.connectToUserChrome !== 'function')
    throw new TypeError('Browser adapter must export connectToUserChrome');
  const connectionBudget = remaining(deadline, 'Browser adapter connection');
  const client = await within(
    Promise.resolve().then(() =>
      module.connectToUserChrome({ timeoutMs: remaining(deadline, 'Browser adapter connection') }),
    ),
    connectionBudget,
    'Browser adapter connection',
    closeQuietly,
  );
  for (const name of ['call', 'session', 'evaluate', 'createTarget', 'targets', 'close']) {
    if (typeof client?.[name] !== 'function') {
      closeQuietly(client);
      throw new TypeError(`Browser adapter client must implement ${name}()`);
    }
  }
  return withProfileGuard(client, profilePath);
}

/** Verify every new task tab, then navigate that same tab. A separate probe
 * followed by createTarget could land in another profile after a focus change. */
export function withProfileGuard(client, profilePath) {
  if (!profilePath) return client;
  if (!isAbsolute(profilePath)) throw new TypeError('profilePath must be absolute');
  const canonical = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  return new Proxy(client, {
    get(target, key) {
      if (key === 'createTarget')
        return async (url = 'about:blank') => {
          const targetId = await target.createTarget('chrome://version/');
          const page = new Page(target, targetId);
          try {
            let actual;
            try {
              actual = await page.waitForFunction(
                `
              /^(chrome|edge|brave):\\/\\/version\\/?$/.test(location.href) &&
              document.querySelector('#profile_path')?.textContent?.trim()
            `,
                { timeoutMs: 10_000, pollingMs: 100 },
              );
            } catch (cause) {
              throw new BrowserError(
                'Cannot verify the new tab profile through chrome://version; task stopped',
                {
                  code: 'PROFILE_UNVERIFIED',
                  cause,
                },
              );
            }
            if (typeof actual !== 'string' || !isAbsolute(actual))
              throw new BrowserError('Browser did not report an absolute profile path; task stopped', {
                code: 'PROFILE_UNVERIFIED',
              });
            if (canonical(actual) !== canonical(profilePath))
              throw new BrowserError(`Expected profile ${profilePath}, observed ${actual}; task stopped`, {
                code: 'PROFILE_MISMATCH',
              });
            const sid = await target.session(targetId, 10_000);
            const response = await target.call('Page.navigate', { url }, sid, 10_000);
            if (response?.errorText)
              throw new BrowserError(`Navigation failed: ${response.errorText}`, {
                code: 'ERR_CDP_NAVIGATION',
              });
            return targetId;
          } catch (error) {
            try {
              await page.close({ timeoutMs: 5000 });
            } catch (cleanupError) {
              error.cleanupError = cleanupError.message;
            }
            throw error;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Page methods needed by the mechanical ChatGPT layer; all waits are bounded. */
export class Page {
  constructor(cdp, targetId) {
    if (!cdp || typeof cdp.evaluate !== 'function')
      throw new TypeError('Page requires a CDP-compatible client');
    if (typeof targetId !== 'string' || !targetId) throw new TypeError('Page requires an explicit targetId');
    this.cdp = cdp;
    this.targetId = targetId;
  }

  evaluate(expression, timeoutMs) {
    return this.cdp.evaluate(this.targetId, expression, timeoutMs);
  }

  async waitForFunction(expression, { timeoutMs = 15_000, pollingMs = 200 } = {}) {
    duration(timeoutMs);
    duration(pollingMs, 'pollingMs');
    if (typeof expression !== 'string' || !expression.trim())
      throw new TypeError('waitForFunction requires a nonempty JavaScript expression');
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      try {
        const budget = remaining(deadline, 'waitForFunction');
        const request = this.evaluate(`(() => (${expression}))()`, budget);
        const value =
          this.cdp instanceof CDPClient ? await request : await within(request, budget, 'waitForFunction');
        if (value) return value;
      } catch (error) {
        // Navigation briefly destroys the execution context. All other protocol,
        // transport and JavaScript errors are actionable and propagate immediately.
        if (
          !(
            error.code === -32000 &&
            /Execution context was destroyed|Cannot find context with specified id/i.test(error.message)
          )
        )
          throw error;
      }
      const left = deadline - now();
      if (left > 0) await sleep(Math.min(pollingMs, Math.ceil(left)));
    }
    throw timeout('waitForFunction');
  }

  waitForSelector(selector, { timeoutMs = 15_000, pollingMs = 200, visible = false } = {}) {
    if (typeof selector !== 'string' || !selector) throw new TypeError('selector must be a nonempty string');
    return this.waitForFunction(
      `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (!${Boolean(visible)}) return true;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })()`,
      { timeoutMs, pollingMs },
    );
  }

  async close({ timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, pollingMs = 50 } = {}) {
    if (this.cdp instanceof CDPClient) return this.cdp.closeTarget(this.targetId, { timeoutMs, pollingMs });
    duration(timeoutMs);
    duration(pollingMs, 'pollingMs');
    const deadline = now() + timeoutMs;
    const budget = remaining(deadline, 'CDP target closure');
    const response = await within(
      typeof this.cdp.closeTarget === 'function'
        ? this.cdp.closeTarget(this.targetId, { timeoutMs: budget, pollingMs })
        : this.cdp.call('Target.closeTarget', { targetId: this.targetId }, null, budget),
      budget,
      'CDP target closure',
    );
    if (response?.success === false)
      throw new BrowserError('CDP could not close the target', { code: 'ERR_CDP_PROTOCOL' });
    // Optional external adapters may implement closeTarget as ack-only too.
    await waitTargetGone(this.cdp, this.targetId, deadline, pollingMs);
    return response;
  }
}
