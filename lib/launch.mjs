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
import { BrowserError } from './browser.mjs';
import { getDataDir, writeJsonAtomic } from './storage.mjs';

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 1500;
const POLL_MS = 250;

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

const LINUX_BROWSER_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];

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
    try { await access(explicitPath, fsConstants.F_OK); return explicitPath; }
    catch { throw new BrowserError(`Configured browser executable does not exist: ${explicitPath} (CHATGPT_WEB_CHROME / config.json chromePath)`, { code: 'ERR_BROWSER_CONFIGURATION' }); }
  }
  for (const path of candidates) {
    try { await access(path, fsConstants.F_OK); return path; } catch { /* Try the next candidate. */ }
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    for (const name of LINUX_BROWSER_NAMES) {
      try {
        const found = which(name);
        if (found) return found;
      } catch { /* which exits nonzero when absent. */ }
    }
  }
  throw new BrowserError('No Chromium-based browser was found. Install Google Chrome (Chromium, Edge and Brave also work), or point CHATGPT_WEB_CHROME / config.json chromePath at an existing executable.', { code: 'ERR_BROWSER_CONFIGURATION' });
}

/** The managed profile directory; always a fresh dedicated tree, never the user's. */
export function managedBrowserDir(dataDir = getDataDir()) {
  return join(resolve(dataDir), 'browser');
}

/**
 * Read DevToolsActivePort inside the managed dir. Returns a loopback ws://
 * browser endpoint, or null when absent, briefly locked (Windows EBUSY) or
 * malformed. A stale file is indistinguishable here; callers verify by
 * connecting, and a fresh launch overwrites the file.
 */
export async function readActiveEndpoint(dir) {
  let content;
  try { content = await readFile(join(dir, 'DevToolsActivePort'), 'utf8'); }
  catch { return null; }
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
    } catch { /* Stale file or dying process: launch fresh below. */ }
  }

  const resolvedExecutable = await findBrowserExecutable({ explicitPath: executable });
  await mkdir(dir, { recursive: true });
  const args = managedLaunchArgs({ profileDir: dir, headless });
  const child = spawnImpl(resolvedExecutable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  const spawnError = new Promise((_, reject) => {
    child.once('error', (error) => reject(new BrowserError(
      `Managed browser failed to start: ${error.message} (executable: ${resolvedExecutable})`,
      { code: 'ERR_BROWSER_LAUNCH', cause: error },
    )));
  });

  const launched = (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const endpoint = await readActiveEndpoint(dir);
      if (endpoint) {
        try {
          const client = await connect(endpoint, CONNECT_TIMEOUT_MS);
          await writeJsonAtomic(join(resolve(dataDir), 'browser-connection.json'), {
            pid: child.pid ?? null, endpoint, executable: resolvedExecutable, startedAt: new Date().toISOString(),
          }).catch(() => {});
          return { client, endpoint, reused: false, dir, executable: resolvedExecutable };
        } catch { /* Endpoint raced with startup; keep polling. */ }
      }
      if (exited !== null) {
        throw new BrowserError(`Managed browser exited during startup with code ${exited} (executable: ${resolvedExecutable}, profile: ${dir}). A headed launch on a machine without a display fails this way; try "browser start --headless" or configure an explicit CHATGPT_WEB_CDP_URL endpoint.`, { code: 'ERR_BROWSER_LAUNCH' });
      }
      if (Date.now() >= deadline) {
        throw new BrowserError(`Managed browser did not become connectable within ${timeoutMs}ms (executable: ${resolvedExecutable}, profile: ${dir}). Try "browser start --headless" or configure an explicit CHATGPT_WEB_CDP_URL endpoint.`, { code: 'ERR_BROWSER_LAUNCH' });
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
  try { client = await connect(endpoint, CONNECT_TIMEOUT_MS); }
  catch { return { stopped: false, endpoint, reason: 'not-reachable' }; }
  try { await client.call('Browser.close', {}, null, 3000); } catch { /* Most versions exit without answering. */ }
  try { client.close(); } catch { /* Already closed by the browser exiting. */ }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const current = await readActiveEndpoint(dir);
    if (!current) return { stopped: true, endpoint, portFileRemoved: true };
    try {
      const probe = await connect(current, CONNECT_TIMEOUT_MS);
      try { probe.close(); } catch { /* Probe only. */ }
    } catch {
      return { stopped: true, endpoint, portFileRemoved: false };
    }
    if (Date.now() >= deadline) return { stopped: false, endpoint, reason: 'still-running' };
    await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
  }
}

/** Read-only health snapshot for `browser status`; never throws. */
export async function browserStatus({ dataDir = getDataDir(), executable = null } = {}) {
  const dir = managedBrowserDir(dataDir);
  const report = { dataDir: resolve(dataDir), dir, executable: null, executableError: null, running: false, endpoint: null };
  try { report.executable = await findBrowserExecutable({ explicitPath: executable }); }
  catch (error) { report.executableError = error.message; }
  report.endpoint = await readActiveEndpoint(dir);
  if (report.endpoint) {
    try { const client = await defaultConnect(report.endpoint, CONNECT_TIMEOUT_MS); client.close(); report.running = true; }
    catch { /* Endpoint file present but stale. */ }
  }
  return report;
}
