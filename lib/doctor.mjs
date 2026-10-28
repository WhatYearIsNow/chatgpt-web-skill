/**
 * 只读预检：解析连接模式、建立连接并核对 ChatGPT 登录态，不发消息、不耗额度、不提交。
 * 用于真实任务开始前的 fail-closed 检查，也可单独诊断。
 */
import { resolveBrowserOptions } from './config.mjs';
import { connectToUserChrome, Page, sleep } from './browser.mjs';
import { loginState, activatePage } from './chatgpt.mjs';
import { ensureManagedBrowser, ensureDedicatedBrowser } from './launch.mjs';
import { getDataDir } from './storage.mjs';

export async function doctor(options = {}, overrides = {}) {
  const d = {
    resolveBrowserOptions,
    connectToUserChrome,
    ensureManagedBrowser,
    ensureDedicatedBrowser,
    Page,
    loginState,
    activatePage,
    getDataDir,
    ...overrides,
  };
  const dataDir = d.getDataDir();
  const cfg = await d.resolveBrowserOptions();
  const report = {
    mode: cfg.mode,
    endpoint: cfg.endpoint || null,
    browserModule: cfg.browserModule || null,
    profilePath: cfg.profilePath || null,
  };
  if (cfg.mode === 'disabled') {
    return {
      ...report,
      ok: false,
      loginState: 'auth',
      reason: 'not-configured',
      hint: 'Run "browser login" (isolated browser) or configure an endpoint/profile before tasks.',
    };
  }
  const external = ['endpoint', 'adapter'].includes(cfg.mode);
  let client;
  let started;
  try {
    started = external
      ? {
          client: await d.connectToUserChrome({
            endpoint: cfg.endpoint,
            browserModule: cfg.browserModule,
            profilePath: cfg.profilePath,
            timeoutMs: 20000,
          }),
        }
      : cfg.mode === 'dedicated'
        ? await d.ensureDedicatedBrowser({
            dataDir,
            headless: !!cfg.headless,
            executable: cfg.chromePath,
            port: cfg.dedicatedPort || undefined,
            timeoutMs: 20000,
          })
        : await d.ensureManagedBrowser({
            dataDir,
            headless: !!cfg.headless,
            executable: cfg.chromePath,
            timeoutMs: 20000,
          });
    client = started.client;
    const targetId = await client.createTarget('https://chatgpt.com/');
    const page = new d.Page(client, targetId);
    const sid = await client.session(targetId);
    await d.activatePage(client, targetId, sid);
    // 有界等待页面到达确定状态（auth/ready）；最多约 15s。
    let state = 'unknown';
    for (let i = 0; i < 30; i++) {
      state = await d.loginState(page);
      if (state !== 'unknown') break;
      await sleep(500);
    }
    await page.close().catch(() => {});
    return {
      ...report,
      ok: state === 'ready',
      loginState: state,
      ...(state !== 'ready'
        ? { hint: 'No logged-in ChatGPT session. Run "browser login" once, then retry.' }
        : {}),
    };
  } finally {
    try {
      client?.close();
    } catch {
      /* Managed browser keeps running; external client only disconnects. */
    }
  }
}
