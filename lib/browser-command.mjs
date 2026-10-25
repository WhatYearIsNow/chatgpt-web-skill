/**
 * `browser status|start|login|stop`: lifecycle commands for the managed
 * browser. status is a read-only snapshot; the other three serialize on the
 * same machine-local browser mutex as real tasks so two callers cannot race
 * a launch or a stop. All actions only ever touch the managed dedicated
 * profile directory, never the user's default browser.
 */

import { acquireLock } from './lock.mjs';
import { ensureManagedBrowser, closeManagedBrowser, browserStatus } from './launch.mjs';
import { Page } from './browser.mjs';
import { waitForLogin } from './chatgpt.mjs';
import { getDataDir } from './storage.mjs';

export async function browserAction(options, overrides = {}) {
  const d = { acquireLock, ensureManagedBrowser, closeManagedBrowser, browserStatus, Page, waitForLogin, ...overrides };
  const dataDir = getDataDir();
  if (options.action === 'status') {
    return d.browserStatus({ dataDir, executable: options.chrome });
  }
  const release = await d.acquireLock('browser', { timeoutMs: options.lockTimeoutMs });
  try {
    if (options.action === 'stop') {
      return d.closeManagedBrowser({ dataDir, waitMs: 5000 });
    }
    const started = await d.ensureManagedBrowser({
      dataDir, headless: !!options.headless, executable: options.chrome, timeoutMs: 30_000,
    });
    if (options.action === 'start') {
      try { started.client.close(); } catch { /* The detached browser keeps running. */ }
      return { action: 'start', reused: started.reused, endpoint: started.endpoint, executable: started.executable, dataDir: started.dir };
    }
    // login: open ChatGPT in the managed window, wait for the one manual login.
    const targetId = await started.client.createTarget('https://chatgpt.com/');
    const page = new d.Page(started.client, targetId);
    let loggedIn = false;
    try {
      loggedIn = await d.waitForLogin(page, { timeoutMs: options.timeoutMs });
    } finally {
      try { await page.close(); } catch { /* The login survives in the profile. */ }
    }
    try { started.client.close(); } catch { /* The detached browser keeps running. */ }
    return { action: 'login', reused: started.reused, endpoint: started.endpoint, executable: started.executable, dataDir: started.dir, loggedIn };
  } finally {
    try { await release(); } catch { /* Released best-effort on the way out. */ }
  }
}
