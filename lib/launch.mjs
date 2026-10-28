/**
 * Managed browser lifecycle for chatgpt-web. Node.js >=22.15; no runtime dependencies.
 *
 * When no CDP endpoint or adapter is configured, the transport falls back to a
 * managed browser: a Chromium-based browser launched with its own dedicated
 * user-data-dir under the private data directory and an ephemeral debug port.
 * The user's default browser, its profiles and its DevToolsActivePort file are
 * never read, copied, junctioned or modified; profiles are never shared with
 * the daily browser. A first interactive login in that window persists in the
 * managed profile, so later runs reuse the same login state without relaunching
 * prompts. This module never approves OS dialogs, accepts JavaScript dialogs or
 * handles passwords.
 */

import { access, readFile, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BrowserError } from './browser.mjs';
import { getDataDir, writeJsonAtomic } from './storage.mjs';

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 1500;
const POLL_MS = 250;

/** Default fixed debug port for the dedicated browser. */
export const DEFAULT_DEDICATED_PORT = 9230;

/** Per-platform Chromium-family executable candidates; Linux uses PATH lookup. */
export function browserCandidates(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    const prog = env.PROGRAMFILES || '';
    const prog86 = env['PROGRAMFILES(X86)'] || '';
    return [
      join(local, 'Google/Chrome/Application/chrome.exe'),
      join(prog, 'Google/Chrome/Application/chrome.exe'),
      join(prog86, 'Google/Chrome/Application/chrome.exe'),
      join(local, 'Chromium/Application/chrome.exe'),
      join(prog86, 'Microsoft/Edge/Application/msedge.exe'),
      join(prog, 'Microsoft/Edge/Application/msedge.exe'),
      join(local, 'Microsoft/Edge/Application/msedge.exe'),
    ].filter(Boolean);
  }
  return [];
}

const LINUX_BROWSER_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

function whichExecutable(name) {
  // execFileSync keeps discovery deterministic and dependency-free; 'which'
  // exits nonzero for absent names, which becomes a caught error.
  return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Locate a Chromium-family executable. explicitPath (CHATGPT_WEB_CHROME or
 * config chromePath) wins; otherwise platform candidates, then PATH on Linux.
 * Throws ERR_BROWSER_CONFIGURATION when nothing usable exists.
 */
export async function findBrowserExecutable({
  explicitPath = null,
  env = process.env,
  platform = process.platform,
  candidates = browserCandidates(env, platform),
  which = whichExecutable,
} = {}) {
  if (explicitPath) {
    try {
      await access(explicitPath, fsConstants.F_OK);
      return explicitPath;
    } catch {
      throw new BrowserError(
        `Configured browser executable does not exist: ${explicitPath} (CHATGPT_WEB_CHROME / config.json chromePath)`,
        { code: 'ERR_BROWSER_CONFIGURATION' },
      );
    }
  }
  for (const path of candidates) {
    try {
      await access(path, fsConstants.F_OK);
      return path;
    } catch {
      /* Try the next candidate. */
    }
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    for (const name of LINUX_BROWSER_NAMES) {
      try {
        const found = which(name);
        if (found) return found;
      } catch {
        /* which exits nonzero when absent. */
      }
    }
  }
  throw new BrowserError(
    'No Chromium-based browser was found. Install Google Chrome (Chromium, Edge and Brave also work), or point CHATGPT_WEB_CHROME / config.json chromePath at an existing executable.',
    { code: 'ERR_BROWSER_CONFIGURATION' },
  );
}

/** The managed profile directory; always a fresh dedicated tree, never the user's. */
export function managedBrowserDir(dataDir = getDataDir()) {
  return join(resolve(dataDir), 'browser');
}

/** The dedicated profile directory: a persistent isolated tree, never the user's. */
export function dedicatedBrowserDir(dataDir = getDataDir()) {
  return join(resolve(dataDir), 'dedicated');
}

/** Command line for a dedicated launch: fixed debug port; exported for tests. */
export function dedicatedLaunchArgs({
  profileDir,
  port,
  headless = false,
  minimized = false,
  url = 'about:blank',
}) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    // Start off-screen so a real (Cloudflare-capable) window never flashes or
    // steals the foreground; CDP then minimizes it onto the taskbar.
    ...(minimized && !headless ? ['--window-position=-32000,-32000', '--window-size=1000,700'] : []),
    url,
  ];
}

/**
 * Minimize the dedicated browser's real window over CDP. A minimized window
 * passes Cloudflare (unlike --headless) while staying out of the user's way.
 * Best-effort: never fails the launch, and a no-op under headless.
 */
export async function minimizeBrowserWindows(client) {
  try {
    // getWindowForTarget needs a concrete page target; without one it can fail
    // with "No web contents in the target" or bind to a transient window.
    const targets = await client.call('Target.getTargets', {}, null, 3000);
    const page = targets?.targetInfos?.find((t) => t.type === 'page');
    if (!page) return;
    const response = await client.call(
      'Browser.getWindowForTarget',
      { targetId: page.targetId },
      null,
      3000,
    );
    if (!response?.windowId) return;
    await client.call(
      'Browser.setWindowBounds',
      { windowId: response.windowId, bounds: { windowState: 'minimized' } },
      null,
      3000,
    );
  } catch {
    /* Minimizing is best-effort; the off-screen launch args already hide it. */
  }
}

async function defaultDiscoverClient(httpEndpoint, timeoutMs) {
  const { discoverWebSocket, CDPClient } = await import('./browser.mjs');
  // discoverWebSocket/CDPClient measure deadlines against performance.now()
  // (time since process start), not the Unix epoch.
  const deadline = performance.now() + timeoutMs;
  const wsUrl = await discoverWebSocket(httpEndpoint, deadline);
  const remainingMs = Math.max(500, Math.floor(deadline - performance.now()));
  return CDPClient.connect(wsUrl, remainingMs);
}

/**
 * Ensure a dedicated browser is running and connectable. The dedicated browser is
 * a persistent isolated profile on a FIXED loopback debug port, so it can be
 * headless (or backgrounded) and never touches the user's daily browser. Reuses
 * the instance already listening on the fixed port; otherwise launches one
 * detached that outlives this CLI. Returns { client, endpoint, reused, dir, port, executable }.
 */
export async function ensureDedicatedBrowser({
  dataDir = getDataDir(),
  executable = null,
  port = DEFAULT_DEDICATED_PORT,
  headless = false,
  minimized = false,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  discover = defaultDiscoverClient,
  spawn: spawnImpl = spawn,
} = {}) {
  const dir = dedicatedBrowserDir(dataDir);
  const httpEndpoint = `http://127.0.0.1:${port}`;
  // Reuse first: a successful discovery proves the fixed port is live.
  try {
    const client = await discover(httpEndpoint, CONNECT_TIMEOUT_MS);
    if (minimized && !headless) await minimizeBrowserWindows(client);
    return { client, endpoint: httpEndpoint, reused: true, dir, port, executable: null };
  } catch {
    /* Nothing listening on the fixed port: launch fresh below. */
  }

  const resolvedExecutable = await findBrowserExecutable({ explicitPath: executable });
  await mkdir(dir, { recursive: true });
  const args = dedicatedLaunchArgs({ profileDir: dir, port, headless, minimized });
  const child = spawnImpl(resolvedExecutable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });
  const spawnError = new Promise((_, reject) => {
    child.once('error', (error) =>
      reject(
        new BrowserError(
          `Dedicated browser failed to start: ${error.message} (executable: ${resolvedExecutable})`,
          { code: 'ERR_BROWSER_LAUNCH', cause: error },
        ),
      ),
    );
  });

  const launched = (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const client = await discover(httpEndpoint, CONNECT_TIMEOUT_MS);
        await writeJsonAtomic(join(resolve(dataDir), 'dedicated-connection.json'), {
          pid: child.pid ?? null,
          endpoint: httpEndpoint,
          port,
          executable: resolvedExecutable,
          startedAt: new Date().toISOString(),
        }).catch(() => {});
        if (minimized && !headless) await minimizeBrowserWindows(client);
        return { client, endpoint: httpEndpoint, reused: false, dir, port, executable: resolvedExecutable };
      } catch {
        /* Port not ready yet; keep polling. */
      }
      if (exited !== null) {
        throw new BrowserError(
          `Dedicated browser exited during startup with code ${exited} (executable: ${resolvedExecutable}, profile: ${dir}). A headed launch on a machine without a display fails this way; use headless mode.`,
          { code: 'ERR_BROWSER_LAUNCH' },
        );
      }
      if (Date.now() >= deadline) {
        throw new BrowserError(
          `Dedicated browser did not become connectable within ${timeoutMs}ms (executable: ${resolvedExecutable}, profile: ${dir}, port: ${port}).`,
          { code: 'ERR_BROWSER_LAUNCH' },
        );
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
    }
  })();
  launched.catch(() => {});
  spawnError.catch(() => {});
  return Promise.race([launched, spawnError]);
}

/**
 * Read DevToolsActivePort inside the managed dir. Returns a loopback ws://
 * browser endpoint, or null when absent, briefly locked (Windows EBUSY) or
 * malformed. A stale file is indistinguishable here; callers verify by
 * connecting, and a fresh launch overwrites the file.
 */
export async function readActiveEndpoint(dir) {
  let content;
  try {
    content = await readFile(join(dir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return null;
  }
  const lines = content.trim().split('\n');
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `ws://127.0.0.1:${port}${lines[1] || ''}`;
}

/** Command line for a managed launch; exported for tests. */
export function managedLaunchArgs({ profileDir, headless = false, url = 'about:blank' }) {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    url,
  ];
}

async function defaultConnect(endpoint, timeoutMs) {
  const { CDPClient } = await import('./browser.mjs');
  return CDPClient.connect(endpoint, timeoutMs);
}

/**
 * Ensure a managed browser is running and connectable. Reuses an already
 * running instance (verified by connecting, which also discards stale
 * DevToolsActivePort files); otherwise launches one detached process that
 * outlives this CLI, then waits for its ephemeral debug endpoint.
 * Returns { client, endpoint, reused, dir, executable }.
 */
export async function ensureManagedBrowser({
  dataDir = getDataDir(),
  executable = null,
  headless = false,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  connect = defaultConnect,
  spawn: spawnImpl = spawn,
} = {}) {
  const dir = managedBrowserDir(dataDir);
  // Reuse first: one short connect attempt proves the endpoint is live.
  const existing = await readActiveEndpoint(dir);
  if (existing) {
    try {
      const client = await connect(existing, CONNECT_TIMEOUT_MS);
      return { client, endpoint: existing, reused: true, dir, executable: null };
    } catch {
      /* Stale file or dying process: launch fresh below. */
    }
  }

  const resolvedExecutable = await findBrowserExecutable({ explicitPath: executable });
  await mkdir(dir, { recursive: true });
  const args = managedLaunchArgs({ profileDir: dir, headless });
  const child = spawnImpl(resolvedExecutable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });
  const spawnError = new Promise((_, reject) => {
    child.once('error', (error) =>
      reject(
        new BrowserError(
          `Managed browser failed to start: ${error.message} (executable: ${resolvedExecutable})`,
          { code: 'ERR_BROWSER_LAUNCH', cause: error },
        ),
      ),
    );
  });

  const launched = (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const endpoint = await readActiveEndpoint(dir);
      if (endpoint) {
        try {
          const client = await connect(endpoint, CONNECT_TIMEOUT_MS);
          await writeJsonAtomic(join(resolve(dataDir), 'browser-connection.json'), {
            pid: child.pid ?? null,
            endpoint,
            executable: resolvedExecutable,
            startedAt: new Date().toISOString(),
          }).catch(() => {});
          return { client, endpoint, reused: false, dir, executable: resolvedExecutable };
        } catch {
          /* Endpoint raced with startup; keep polling. */
        }
      }
      if (exited !== null) {
        throw new BrowserError(
          `Managed browser exited during startup with code ${exited} (executable: ${resolvedExecutable}, profile: ${dir}). A headed launch on a machine without a display fails this way; try "browser start --headless" or configure an explicit CHATGPT_WEB_CDP_URL endpoint.`,
          { code: 'ERR_BROWSER_LAUNCH' },
        );
      }
      if (Date.now() >= deadline) {
        throw new BrowserError(
          `Managed browser did not become connectable within ${timeoutMs}ms (executable: ${resolvedExecutable}, profile: ${dir}). Try "browser start --headless" or configure an explicit CHATGPT_WEB_CDP_URL endpoint.`,
          { code: 'ERR_BROWSER_LAUNCH' },
        );
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
    }
  })();
  // The loser of the race keeps running to its own rejection; swallow that.
  launched.catch(() => {});
  spawnError.catch(() => {});
  return Promise.race([launched, spawnError]);
}

/**
 * Gracefully stop the managed browser (flushes cookies) by closing over CDP.
 * Browser.close often does not answer before exit, and on some platforms the
 * DevToolsActivePort file lingers after the process is gone, so shutdown is
 * confirmed by the endpoint refusing connections; a leftover file is stale and
 * is discarded by the reuse path's connect verification.
 */
export async function closeManagedBrowser({
  dataDir = getDataDir(),
  waitMs = 5000,
  connect = defaultConnect,
} = {}) {
  const dir = managedBrowserDir(dataDir);
  const endpoint = await readActiveEndpoint(dir);
  if (!endpoint) return { stopped: false, endpoint: null, reason: 'not-running' };
  let client;
  try {
    client = await connect(endpoint, CONNECT_TIMEOUT_MS);
  } catch {
    return { stopped: false, endpoint, reason: 'not-reachable' };
  }
  try {
    await client.call('Browser.close', {}, null, 3000);
  } catch {
    /* Most versions exit without answering. */
  }
  try {
    client.close();
  } catch {
    /* Already closed by the browser exiting. */
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const current = await readActiveEndpoint(dir);
    if (!current) return { stopped: true, endpoint, portFileRemoved: true };
    try {
      const probe = await connect(current, CONNECT_TIMEOUT_MS);
      try {
        probe.close();
      } catch {
        /* Probe only. */
      }
    } catch {
      return { stopped: true, endpoint, portFileRemoved: false };
    }
    if (Date.now() >= deadline) return { stopped: false, endpoint, reason: 'still-running' };
    await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
  }
}

/**
 * Gracefully stop the dedicated browser over its fixed port. Mirrors
 * closeManagedBrowser, but discovers the CDP endpoint via the fixed HTTP port
 * instead of a DevToolsActivePort file.
 */
export async function closeDedicatedBrowser({
  dataDir = getDataDir(),
  port = DEFAULT_DEDICATED_PORT,
  waitMs = 5000,
  discover = defaultDiscoverClient,
} = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  let client;
  try {
    client = await discover(endpoint, CONNECT_TIMEOUT_MS);
  } catch {
    return { stopped: false, endpoint: null, reason: 'not-running' };
  }
  try {
    await client.call('Browser.close', {}, null, 3000);
  } catch {
    /* Most versions exit without answering. */
  }
  try {
    client.close();
  } catch {
    /* Already closed by the browser exiting. */
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const probe = await discover(endpoint, CONNECT_TIMEOUT_MS);
      try {
        probe.close();
      } catch {
        /* Probe only. */
      }
    } catch {
      return { stopped: true, endpoint };
    }
    if (Date.now() >= deadline) return { stopped: false, endpoint, reason: 'still-running' };
    await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
  }
}
export async function browserStatus({ dataDir = getDataDir(), executable = null } = {}) {
  const dir = managedBrowserDir(dataDir);
  const report = {
    dataDir: resolve(dataDir),
    dir,
    executable: null,
    executableError: null,
    running: false,
    endpoint: null,
  };
  try {
    report.executable = await findBrowserExecutable({ explicitPath: executable });
  } catch (error) {
    report.executableError = error.message;
  }
  report.endpoint = await readActiveEndpoint(dir);
  if (report.endpoint) {
    try {
      const client = await defaultConnect(report.endpoint, CONNECT_TIMEOUT_MS);
      client.close();
      report.running = true;
    } catch {
      /* Endpoint file present but stale. */
    }
  }
  return report;
}

/** Read-only health snapshot for the dedicated browser; never throws. */
export async function dedicatedStatus({
  dataDir = getDataDir(),
  executable = null,
  port = DEFAULT_DEDICATED_PORT,
} = {}) {
  const dir = dedicatedBrowserDir(dataDir);
  const report = {
    dataDir: resolve(dataDir),
    dir,
    executable: null,
    executableError: null,
    running: false,
    endpoint: null,
    port,
  };
  try {
    report.executable = await findBrowserExecutable({ explicitPath: executable });
  } catch (error) {
    report.executableError = error.message;
  }
  const httpEndpoint = `http://127.0.0.1:${port}`;
  try {
    const client = await defaultDiscoverClient(httpEndpoint, CONNECT_TIMEOUT_MS);
    client.close();
    report.endpoint = httpEndpoint;
    report.running = true;
  } catch {
    /* Nothing listening on the fixed port. */
  }
  return report;
}
