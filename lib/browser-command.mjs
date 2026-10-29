/**
 * Browser commands use the same connection policy as tasks. Only explicitly
 * selected managed/dedicated instances may be launched or stopped. External
 * browsers are connected/disconnected, never shut down. status never opens a browser.
 */

import { acquireLock } from './lock.mjs';
import {
  ensureManagedBrowser,
  ensureDedicatedBrowser,
  closeManagedBrowser,
  closeDedicatedBrowser,
  browserStatus,
  dedicatedStatus,
} from './launch.mjs';
import { Page, connectToUserChrome, BrowserError } from './browser.mjs';
import { resolveBrowserOptions } from './config.mjs';
import { waitForLogin } from './chatgpt.mjs';
import { getDataDir } from './storage.mjs';

export async function browserAction(options, overrides = {}) {
  const d = {
    acquireLock,
    ensureManagedBrowser,
    ensureDedicatedBrowser,
    closeManagedBrowser,
    closeDedicatedBrowser,
    browserStatus,
    dedicatedStatus,
    Page,
    waitForLogin,
    connectToUserChrome,
    resolveBrowserOptions,
    ...overrides,
  };
  const dataDir = getDataDir();
  const selected = options.managed
    ? { mode: 'managed', chromePath: process.env.CHATGPT_WEB_CHROME || null, headless: false }
    : options.dedicated
      ? {
          mode: 'dedicated',
          chromePath: process.env.CHATGPT_WEB_CHROME || null,
          headless: false,
          dedicatedMinimized: false,
          dedicatedPort: options.dedicatedPort ? Number(options.dedicatedPort) : null,
        }
      : await d.resolveBrowserOptions();
  const external = ['endpoint', 'adapter'].includes(selected.mode);
  const details = {
    mode: selected.mode,
    endpoint: selected.endpoint || null,
    browserModule: selected.browserModule || null,
    expectedProfilePath: selected.profilePath || null,
  };
  if (external && (options.chrome || options.headless))
    throw new BrowserError('--chrome/--headless require managed mode; use --managed explicitly', {
      code: 'ERR_BROWSER_CONFIGURATION',
    });
  if (options.action === 'status') {
    if (external) return { ...details, running: null, profileVerified: false, reason: 'not-probed' };
    if (selected.mode === 'disabled') return { ...details, running: false, reason: 'not-configured' };
    if (selected.mode === 'dedicated')
      return {
        ...details,
        ...(await d.dedicatedStatus({
          dataDir,
          executable: options.chrome || selected.chromePath,
          port: selected.dedicatedPort || undefined,
        })),
      };
    return {
      ...details,
      ...(await d.browserStatus({ dataDir, executable: options.chrome || selected.chromePath })),
    };
  }
  if (options.action === 'stop' && external)
    return { ...details, stopped: false, reason: 'external-browser' };
  if (selected.mode === 'disabled')
    throw new BrowserError(
      'No browser connection configured; configure one or choose --managed or --dedicated explicitly',
      { code: 'ERR_CDP_CONFIGURATION' },
    );
  const release = await d.acquireLock('browser', { timeoutMs: options.lockTimeoutMs });
  let client;
  try {
    if (options.action === 'stop') {
      if (selected.mode === 'dedicated') {
        return {
          ...details,
          ...(await d.closeDedicatedBrowser({
            dataDir,
            port: selected.dedicatedPort || undefined,
            waitMs: 5000,
          })),
        };
      }
      return { ...details, ...(await d.closeManagedBrowser({ dataDir, waitMs: 5000 })) };
    }
    const started = external
      ? {
          client: await d.connectToUserChrome({
            endpoint: selected.endpoint,
            browserModule: selected.browserModule,
            profilePath: selected.profilePath,
            timeoutMs: 30_000,
          }),
        }
      : selected.mode === 'dedicated'
        ? await d.ensureDedicatedBrowser({
            dataDir,
            headless: !!options.headless || selected.headless,
            minimized: options.action === 'start' && (!!options.minimized || !!selected.dedicatedMinimized),
            executable: options.chrome || selected.chromePath,
            port: selected.dedicatedPort || undefined,
            timeoutMs: 30_000,
          })
        : await d.ensureManagedBrowser({
            dataDir,
            headless: !!options.headless || selected.headless,
            executable: options.chrome || selected.chromePath,
            timeoutMs: 30_000,
          });
    client = started.client;
    if (options.action === 'start') {
      // External start is a connection/profile check, not a second launch.
      if (external) {
        const targetId = await client.createTarget('about:blank');
        await new d.Page(client, targetId).close();
      }
      return {
        ...details,
        action: 'start',
        ...(external ? { connected: true, profileVerified: !!selected.profilePath } : {}),
        reused: started.reused,
        endpoint: started.endpoint || selected.endpoint || null,
        executable: started.executable,
        dataDir: started.dir,
        ...(started.port ? { port: started.port } : {}),
      };
    }
    // login: open ChatGPT in the selected browser, wait for manual login.
    const targetId = await client.createTarget('https://chatgpt.com/');
    const page = new d.Page(client, targetId);
    let loggedIn = false;
    try {
      loggedIn = await d.waitForLogin(page, { timeoutMs: options.timeoutMs });
    } finally {
      try {
        await page.close();
      } catch {
        /* The login survives in the profile. */
      }
    }
    return {
      ...details,
      action: 'login',
      reused: started.reused,
      endpoint: started.endpoint || selected.endpoint || null,
      executable: started.executable,
      dataDir: started.dir,
      ...(started.port ? { port: started.port } : {}),
      loggedIn,
      ...(external ? { profileVerified: !!selected.profilePath } : {}),
    };
  } finally {
    try {
      client?.close();
    } catch {
      /* Only disconnect this client. */
    }
    try {
      await release();
    } catch {
      /* Released best-effort on the way out. */
    }
  }
}
