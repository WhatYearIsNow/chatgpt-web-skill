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
import net from 'node:net';
import { BrowserError } from './browser.mjs';
import { getDataDir, writeJsonAtomic } from './storage.mjs';

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 1500;
const POLL_MS = 250;

/**
 * Probe a loopback TCP endpoint (the local proxy port). Resolves true when a
 * connection succeeds within timeoutMs, false otherwise. Exported for tests.
 */
export async function probeTcpPort(host, port, timeoutMs = 1500) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Parse an http(s)://host:port proxy URL into { host, port }; null when
 * malformed or non-loopback (auto-launch must never target a remote proxy).
 * Exported for tests.
 */
/**
 * HTTP-level proxy probe: send an absolute-URI GET through the HTTP proxy and
 * check the upstream is actually reachable (TCP-port-alive is NOT enough — the
 * SakuraCat helper service keeps the port listening even when its GUI is closed
 * and the upstream node is down). Default probe URL is a lightweight 204
 * endpoint. Resolves true on 2xx-3xx first response line.
 */
export async function probeProxyHttp(
  proxyServer,
  { timeoutMs = 3000, probeUrl = 'http://www.gstatic.com/generate_204' } = {},
) {
  const ep = parseProxyEndpoint(proxyServer);
  if (!ep) return false;
  const target = new URL(probeUrl);
  return new Promise((resolveProbe) => {
    const socket = net.connect({ host: ep.host, port: ep.port });
    let buf = '';
    const done = (ok) => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => {
      socket.write(`GET ${probeUrl} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /^HTTP\/1\.\d (\d{3})/.exec(buf);
      if (m) {
        const code = Number(m[1]);
        done(code >= 200 && code < 400);
      }
    });
  });
}

export function parseProxyEndpoint(proxyServer) {
  if (typeof proxyServer !== 'string' || !proxyServer) return null;
  try {
    const url = new URL(proxyServer);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: '127.0.0.1', port };
  } catch {
    return null;
  }
}

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

/**
 * Read the command line of the process listening on a loopback debug port, so a
 * reused instance can be checked against the proxy it was launched with.
 *
 * Why this exists: reuse is "discover the port, take it". A browser launched
 * BEFORE the proxy was configured keeps serving on the fixed port with no
 * `--proxy-server`, so every page hits the network directly and times out —
 * while the config file still says a proxy is set. "Config has proxyServer" and
 * "instance actually has --proxy-server" are different facts; only the command
 * line distinguishes them.
 *
 * Best-effort: returns null when the process cannot be identified (unknown
 * platform, no permission, no listener), and callers must treat null as
 * "cannot verify" rather than "verified good".
 */
export function readListenerCommandLine(port, { platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      // One PowerShell round-trip: owning pid of the listening socket, then that
      // process's command line. -NoProfile keeps startup cost predictable.
      // Outer backtick string keeps PowerShell's $ variables literal; the only
      // interpolation is the port we control.
      const script =
        `$c = Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess)).CommandLine }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
      const line = String(out || '').trim();
      return line || null;
    }
    // macOS/Linux: ask lsof, which reports the owning pid for a listening socket.
    const out = execFileSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    const pid = String(out || '')
      .trim()
      .split('\n')[0];
    if (!pid) return null;
    return (
      String(execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 8000 })).trim() ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * Does a command line reference a given profile directory?
 *
 * Chrome echoes the path it was given, and Windows accepts both separators, so
 * normalize separators and case before comparing the exact --user-data-dir
 * value. Exported for tests.
 */
export function commandLineMentionsDir(commandLine, dir) {
  if (typeof commandLine !== 'string' || !commandLine || typeof dir !== 'string' || !dir) return false;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const actual = commandLineFlag(commandLine, '--user-data-dir');
  return actual !== null && norm(actual) === norm(dir);
}

function commandLineFlag(commandLine, name) {
  const tokens = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const prefix = name + '=';
  const argument = tokens
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .find((token) => token.startsWith(prefix));
  return argument ? argument.slice(prefix.length).replace(/^["']|["']$/g, '') : null;
}

/**
 * Find the pid listening on a loopback port. Returns null when nothing listens.
 * Exported for tests.
 */
export function findListenerPid(port, { platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      const script =
        `$c = Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { $c.OwningProcess }`;
      const out = String(
        execFileSync('powershell', ['-NoProfile', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 8000,
        }) || '',
      ).trim();
      const pid = Number(out.split('\n')[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const out = String(
      execFileSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        timeout: 8000,
      }) || '',
    ).trim();
    const pid = Number(out.split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Terminate the process listening on a loopback port and wait for the port to
 * stop answering, so a relaunch can bind it. Best-effort beyond the kill itself.
 *
 * Callers MUST have proven the process is theirs (profile path in its command
 * line) before calling this.
 */
export async function stopListenerProcess(
  port,
  {
    kill = defaultKill,
    timeoutMs = 8000,
    expectedCommandLine,
    expectedProfileDir,
    findPidImpl = findListenerPid,
    readCommandLineImpl = readListenerCommandLine,
    probeImpl = probeTcpPort,
  } = {},
) {
  if (!expectedCommandLine || !expectedProfileDir)
    return { stopped: false, pid: null, reason: 'IDENTITY_REQUIRED' };
  const pid = findPidImpl(port);
  if (pid == null) return { stopped: false, pid: null, reason: 'NO_LISTENER' };
  const commandLine = readCommandLineImpl(port);
  if (
    commandLine !== expectedCommandLine ||
    !commandLineMentionsDir(commandLine, expectedProfileDir) ||
    findPidImpl(port) !== pid
  ) {
    return { stopped: false, pid, reason: 'LISTENER_CHANGED' };
  }
  kill(pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeImpl('127.0.0.1', port, 400))) return { stopped: true, pid, reason: null };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { stopped: false, pid, reason: 'PORT_STILL_OPEN' };
}

function defaultKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* Already gone, or not ours: the port probe below is the real verdict. */
  }
}

/**
 * Does a running instance's command line match the proxy setting we require?
 *
 * Returns { known, matches, reason }:
 *   known=false  → command line unavailable, cannot judge (caller decides policy)
 *   matches=true → instance carries exactly the required proxy (or none required
 *                  and none present)
 *   matches=false→ instance is running with a different/no proxy than required
 *
 * Exported for tests.
 */
export function checkInstanceProxy({ commandLine, proxyServer = null }) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) {
    return { known: false, matches: false, reason: 'UNKNOWN_COMMAND_LINE' };
  }
  const actual = commandLineFlag(commandLine, '--proxy-server');
  const want = proxyServer || null;
  if (want === actual) return { known: true, matches: true, reason: null };
  return {
    known: true,
    matches: false,
    reason:
      want && !actual ? 'INSTANCE_WITHOUT_PROXY' : want ? 'INSTANCE_PROXY_MISMATCH' : 'INSTANCE_HAS_PROXY',
  };
}

/** Command line for a dedicated launch: fixed debug port; exported for tests. */
export function dedicatedLaunchArgs({
  profileDir,
  port,
  headless = false,
  minimized = false,
  url = 'about:blank',
  proxyServer = null,
}) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    // Route the isolated browser through a local proxy (e.g. SakuraCat) without
    // touching the OS proxy setting; a dead proxy fails pages honestly.
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
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
    const response = await client.call('Browser.getWindowForTarget', { targetId: page.targetId }, null, 3000);
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
  proxyServer = null,
  proxyLaunchCommand = null,
  proxyProbeUrl = null,
  proxyReadyTimeoutMs = 45_000,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  discover = defaultDiscoverClient,
  spawn: spawnImpl = spawn,
  launchProxyImpl = null,
  killProcessImpl = defaultKill,
  readCommandLineImpl = readListenerCommandLine,
} = {}) {
  const dir = dedicatedBrowserDir(dataDir);
  const httpEndpoint = `http://127.0.0.1:${port}`;
  // Auto-launch the local proxy client when configured: with proxyServer set,
  // the browser is useless until the proxy listens. Probe first; if the port
  // is dead and a launch command is configured, run it detached and wait for
  // readiness (up to proxyReadyTimeoutMs). Upstream node connectivity is the
  // proxy client's own concern — we only guarantee the local port is listening.
  const proxyEndpoint = parseProxyEndpoint(proxyServer);
  if (proxyEndpoint && proxyLaunchCommand) {
    const probe = launchProxyImpl?.probeTcpPort || probeTcpPort;
    const runProxy =
      launchProxyImpl?.spawnProxy ||
      ((cmd) => {
        const child = spawn(cmd, [], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return child;
      });
    const httpProbe =
      launchProxyImpl?.probeHttp ||
      ((u, o) => probeProxyHttp(u, { ...o, probeUrl: proxyProbeUrl || (o && o.probeUrl) }));
    const probeProxy = async () => {
      // 双探：TCP 端口活 + 经代理的出口连通（R-增强：端口监听≠节点可用——
      // SakuraCat helper 服务常驻监听，GUI 关闭时上游节点是断的）
      const tcpOk = await probe(proxyEndpoint.host, proxyEndpoint.port, 1500);
      if (!tcpOk) return { alive: false, reason: 'PROXY_PORT_DEAD' };
      const httpOk = await httpProbe(proxyServer, { timeoutMs: 3000 });
      return { alive: httpOk, reason: httpOk ? null : 'PROXY_NODE_UNREACHABLE' };
    };
    let state = await probeProxy();
    if (!state.alive) {
      runProxy(proxyLaunchCommand);
      const deadline = Date.now() + proxyReadyTimeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        state = await probeProxy();
        if (state.alive) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        const detail =
          state.reason === 'PROXY_NODE_UNREACHABLE'
            ? `代理端口 ${proxyEndpoint.port} 可达但出口节点不可用——请在代理客户端中检查/切换节点`
            : `代理客户端未就绪（端口 ${proxyEndpoint.port} 无监听）`;
        throw new BrowserError(
          `${detail}。auto-launch（command: ${proxyLaunchCommand}）已执行，等待 ${proxyReadyTimeoutMs}ms 超时。原因: ${state.reason}`,
          { code: 'ERR_PROXY_LAUNCH', cause: state.reason },
        );
      }
    }
  }
  // Reuse first: a successful discovery proves the fixed port is live. But a live
  // port is NOT proof the instance is configured correctly — a browser launched
  // before the proxy was set keeps serving with no `--proxy-server`, and every
  // page then fails with ERR_CONNECTION_CLOSED/TIMED_OUT while config.json still
  // declares a proxy. Reusing that blindly is how runs fail six images in a row.
  let reusedClient = null;
  try {
    reusedClient = await discover(httpEndpoint, CONNECT_TIMEOUT_MS);
  } catch {
    /* Nothing listening on the fixed port: launch fresh below. */
  }

  if (reusedClient) {
    const commandLine = readCommandLineImpl(port);
    const verdict = checkInstanceProxy({ commandLine, proxyServer });
    // Unknown command line: the platform query failed (no permission, no lsof,
    // unexpected shell). Reuse anyway but say so — refusing here would break the
    // case where the process genuinely cannot be inspected.
    if (verdict.matches || !verdict.known) {
      if (minimized && !headless) await minimizeBrowserWindows(reusedClient);
      return {
        client: reusedClient,
        endpoint: httpEndpoint,
        reused: true,
        dir,
        port,
        executable: null,
        proxyVerified: verdict.matches,
      };
    }
    // The instance contradicts the required proxy. Replace it here rather than
    // throwing: the caller asked for a working browser, not for a diagnosis, and
    // a leftover instance would be reused again on the next call.
    // Only kill a browser we can prove owns OUR dedicated profile; anything else
    // on this port is someone else's process and must never be touched.
    // Path separators differ between what we build (forward slashes) and what
    // Chrome's command line carries (backslashes on Windows), so compare on a
    // normalized, case-insensitive form.
    const ownsProfile = commandLineMentionsDir(commandLine, dir);
    if (!ownsProfile) {
      throw new BrowserError(
        `固定端口 ${port} 被一个不属于本 skill 的进程占用（命令行未包含 ${dir}），代理要求为 ${proxyServer}。` +
          `不自动结束他人进程，请手工处理端口占用。`,
        { code: 'ERR_PORT_FOREIGN_PROCESS', cause: verdict.reason },
      );
    }
    try {
      await reusedClient.close?.();
    } catch {
      /* Closing the doomed instance is best-effort. */
    }
    const stopped = await stopListenerProcess(port, {
      kill: killProcessImpl,
      timeoutMs: 8000,
      expectedCommandLine: commandLine,
      expectedProfileDir: dir,
    });
    if (!stopped.stopped) {
      throw new BrowserError('Dedicated browser replacement failed: ' + stopped.reason, {
        code: 'ERR_BROWSER_REPLACE',
      });
    }
  }

  const resolvedExecutable = await findBrowserExecutable({ explicitPath: executable });
  await mkdir(dir, { recursive: true });
  const args = dedicatedLaunchArgs({ profileDir: dir, port, headless, minimized, proxyServer });
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
        return {
          client,
          endpoint: httpEndpoint,
          reused: false,
          dir,
          port,
          executable: resolvedExecutable,
          proxyVerified: true,
        };
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
