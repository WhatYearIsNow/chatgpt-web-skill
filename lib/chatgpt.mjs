import { connectToUserChrome, Page, sleep } from './browser.mjs';
import { SEL, RE } from './selectors.mjs';

import { saveImagePayload } from './image.mjs';
import { TaskError } from './errors.mjs';
import { readErrorPage, watchMainDocumentFailure, networkErrorMessage } from './network.mjs';
import { basename } from 'node:path';

export const log = (...a) => console.error('[chatgpt-web]', ...a);

/** 额度耗尽类错误——消费方应停下报告，不要重试。 */
export class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
    this.kind = 'quota';
  }
}

/** Compatibility name: approval and browser launch belong to the configured adapter. */
export async function connectWithApproval(options = {}) {
  return connectToUserChrome(options);
}

/**
 * 连一条 CDP 并绑定到指定标签页，确认它响应求值。
 * 生图流发送后换新连接等图也走这里（文件头纪律 2）。
 */
export async function attach(targetId, { timeoutMs = 25000, settleMs = 700 } = {}) {
  const cdp = await connectToUserChrome({ timeoutMs });
  try {
    const sid = await cdp.session(targetId);
    await activatePage(cdp, targetId, sid);
    await sleep(settleMs);
    await cdp.evaluate(targetId, '1', 10000); // 健康检查：页面能响应求值
    return { cdp, page: new Page(cdp, targetId), sid, targetId };
  } catch (e) {
    try {
      cdp.close();
    } catch {}
    throw e;
  }
}

/**
 * Page 刚创建或 Page.navigate 刚返回时，页面可能尚未附着完成，此时调用会报
 * 「Not attached to an active page」(-32000)。仅对该瞬时错误做有界重试，
 * 其余错误立即抛出，不掩盖真实问题。
 */
async function callWhenPageAttached(cdp, sid, method, params, { attempts = 8, delayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await cdp.call(method, params, sid);
    } catch (error) {
      const transient = error.code === -32000 && /Not attached to an active page/i.test(error.message);
      if (!transient) throw error;
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** 激活本任务标签页，保证后台页的输入能进入真实 composer。 */
export async function activatePage(cdp, targetId, sid) {
  await cdp.call('Target.activateTarget', { targetId });
  await callWhenPageAttached(cdp, sid, 'Page.setWebLifecycleState', { state: 'active' });
  await callWhenPageAttached(cdp, sid, 'Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** 新开一个 chatgpt.com 标签页，返回 targetId（连接用完即断，只留 targetId）。 */
export async function openTab(url = 'https://chatgpt.com/') {
  const cdp = await connectToUserChrome({ timeoutMs: 25000 });
  try {
    const targetId = await cdp.createTarget(url);
    log(`新开标签页：${String(targetId).slice(0, 8)}`);
    return targetId;
  } finally {
    try {
      cdp.close();
    } catch {}
  }
}

/** 关掉本任务自己开的标签页。每个 ChatGPT 标签页几百 MB 内存，收尾必关；只关自己开的。 */
export async function closeTab(targetId) {
  try {
    const cdp = await connectToUserChrome({ timeoutMs: 15000 });
    try {
      await new Page(cdp, targetId).close();
    } finally {
      try {
        cdp.close();
      } catch {}
    }
  } catch (e) {
    log(`关标签页失败（不影响结果）：${e.message}`);
    throw e;
  }
}

export async function evalT(page, expr, ms = 8000) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(expr, ms),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new TaskError('EVALUATE_TIMEOUT', `Page evaluation exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(page, expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      if (await evalT(page, expr, 6000)) return true;
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error(`等待超时（${label}）${last ? '：' + last : ''}`);
}

const COMPOSER_INFO_JS = `(() => {
  const ta = document.querySelector('textarea[placeholder="Ask ChatGPT"]');
  if (ta) return JSON.stringify({ kind: 'textarea', len: (ta.value || '').trim().length });
  const ed = document.querySelector('div.ProseMirror[contenteditable="true"]')
    || document.querySelector('[contenteditable="true"]');
  if (ed) return JSON.stringify({ kind: 'prosemirror', len: (ed.innerText || '').trim().length });
  return JSON.stringify({ kind: 'none', len: -1 });
})()`;

/** 输入框状态：{ kind: 'textarea'|'prosemirror'|'none', len: trim 后字数（-1 读不到）}。 */
export async function composerInfo(page) {
  return JSON.parse(await page.evaluate(COMPOSER_INFO_JS).catch(() => '{"kind":"none","len":-1}'));
}

const COMPOSER_TEXT_JS = `(() => {
  const ta = document.querySelector('textarea[placeholder="Ask ChatGPT"]');
  if (ta) return ta.value || '';
  const ed = document.querySelector('div.ProseMirror[contenteditable="true"]')
    || document.querySelector('[contenteditable="true"]');
  return ed ? (ed.innerText || '') : '';
})()`;

/** 输入框全文（校验「填进去的是不是这条提示词」用，光看长度会被恢复的草稿骗过）。 */
export async function composerText(page) {
  return page.evaluate(COMPOSER_TEXT_JS).catch(() => '');
}

/**
 * 等 composer 就绪（textarea / ProseMirror / 泛 contenteditable）。
 * 根路径偶尔停在「The browser check couldn't finish」——先刷新一次再判死。
 */
export async function waitComposerReady(page, cdp, sid, { timeoutMs = 35000, log: _log = log } = {}) {
  const wait = async (ms) => {
    try {
      await page.waitForSelector(SEL.composerAll, { timeoutMs: ms });
      return true;
    } catch {
      return false;
    }
  };
  if (await wait(timeoutMs)) return true;
  _log('composer 未出现，刷新页面重试');
  await cdp.call('Page.reload', { ignoreCache: true }, sid);
  if (await wait(90000)) return true;
  const tail = await page.evaluate('document.body.innerText.slice(-200)').catch(() => '');
  throw new Error(`composer 始终未出现，页面状态：${JSON.stringify(tail)}`);
}

/**
 * 未登录的实测信号（2026-10-25 托管浏览器首跑确认）：auth.openai.com 域、
 * chatgpt.com 站内 /auth/ 路径，或未登录落地页上的 /auth/login 登录链接。
 */
const LOGIN_STATE_JS = `(() => {
  const host = location.hostname;
  if (host === 'auth.openai.com' || host.endsWith('.auth.openai.com')) return 'auth';
  if (/chatgpt\\.com\\//.test(location.href) && /\\/auth(\\/|$)/.test(location.pathname)) return 'auth';
  // 已登录（composer 已出现）优先判定，避免把页面上的次要链接误判成登录入口。
  if (document.querySelector('textarea[placeholder="Ask ChatGPT"]')) return 'ready';
  if (document.querySelector('div.ProseMirror[contenteditable="true"], [contenteditable="true"]')) return 'ready';
  // 未登录落地页：登录/注册入口（链接 href 或按钮文本）。fresh 托管 profile 首跑确认。
  if (document.querySelector('a[href*="/auth/login"]')) return 'auth';
  const hasLoginControl = Array.from(document.querySelectorAll('a,button')).some((el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
    return t.length <= 12 && /^(log in|sign in|sign up|get started|登录|注册|登陆|登录 ChatGPT)/i.test(t);
  });
  if (hasLoginControl) return 'auth';
  return 'unknown';
})()`;

/**
 * 登录态三态：'auth'（在登录页或未登录落地页）/ 'ready'（composer 已出现）/ 'unknown'（仍在加载）。
 */
export async function loginState(page) {
  const state = await page.evaluate(LOGIN_STATE_JS).catch(() => 'unknown');
  return state === 'auth' || state === 'ready' ? state : 'unknown';
}

/**
 * 快速失败检测：确认登录页就立刻报 LOGIN_REQUIRED，而不是等 composer 超时。
 * 超时仍 unknown 时放行，交给 waitComposerReady 的刷新/兜底流程。
 */
export async function ensureLoggedIn(page, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await loginState(page);
    if (state === 'auth') {
      throw new TaskError(
        'LOGIN_REQUIRED',
        'No logged-in ChatGPT session was found (the browser is on the login page). Log in once in the connected browser window - with the managed browser that login persists in its own profile - then rerun this command.',
      );
    }
    if (state === 'ready') return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/**
 * Combined fast gate before real work: fail in seconds when the network/proxy
 * is down or no session is logged in, instead of waiting for the composer
 * timeout. Arms a Network watcher (catches a failure after the tab opened) and
 * polls the chrome-error page. Returns true when ready; false when the probe
 * window ends with no decision (the caller falls back to waitComposerReady).
 */
export async function ensureNetworkAndLogin(page, cdp, sid, { timeoutMs = 15000 } = {}) {
  let watch = null;
  if (cdp && sid && typeof cdp.on === 'function') {
    watch = watchMainDocumentFailure(cdp, sid);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      watch?.stop?.();
      return false;
    }
    const tick = sleep(Math.min(500, left));
    let net = null;
    if (watch) {
      net = await Promise.race([watch.promise, tick.then(() => null)]);
    } else {
      await tick;
    }
    if (net) {
      watch?.stop?.();
      throw new TaskError('NETWORK_UNREACHABLE', networkErrorMessage(net));
    }
    const errPage = await readErrorPage(page).catch(() => null);
    if (errPage) {
      watch?.stop?.();
      throw new TaskError('NETWORK_UNREACHABLE', networkErrorMessage(errPage));
    }
    const state = await loginState(page);
    if (state === 'auth') {
      watch?.stop?.();
      throw new TaskError(
        'LOGIN_REQUIRED',
        'No logged-in ChatGPT session was found (the browser is on the login page). Log in once in the connected browser window - with the managed browser that login persists in its own profile - then rerun this command.',
      );
    }
    if (state === 'ready') {
      watch?.stop?.();
      return true;
    }
  }
}

/** 等到登录完成（browser login 用）：超时抛 LOGIN_REQUIRED，由调用方给出结构化结果。 */
export async function waitForLogin(page, { timeoutMs = 300000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await loginState(page)) === 'ready') return true;
    if (Date.now() >= deadline) {
      throw new TaskError(
        'LOGIN_REQUIRED',
        `Still not logged in after ${Math.round(timeoutMs / 1000)}s. Finish the login in the opened browser window and rerun "browser login" (or any command) afterwards.`,
      );
    }
    await sleep(pollMs);
  }
}

async function doClear(page, cdp, sid, { clearChips = false } = {}) {
  const kind = (await composerInfo(page)).kind;
  if (kind === 'textarea') {
    await page.evaluate(`(() => {
      const ta = document.querySelector('textarea[placeholder="Ask ChatGPT"]');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  } else if (kind !== 'none') {
    await page.evaluate(`(() => {
      const ed = document.querySelector('div.ProseMirror[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"]');
      if (ed) ed.focus();
      return !!ed;
    })()`);
    for (const k of [
      { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    ]) {
      await cdp.call('Input.dispatchKeyEvent', k, sid).catch(() => {});
    }
  }
  if (clearChips) {
    await page
      .evaluate(`document.querySelectorAll(${JSON.stringify(SEL.attachChip)}).forEach((b) => b.click())`)
      .catch(() => {});
  }
}

/**
 * 清空输入框 + 残留附件芯片。ChatGPT 会恢复上次没发出去的草稿（实测：dry-run 残稿会在
 * 新标签页里被恢复，而且恢复是**异步晚到**的——清完立刻填词会被残稿覆盖/拼串，
 * 2026-10-21 实测事故）。所以清完要盯 1.2s：字数回来了就再清，稳定为空才算数。
 */
export async function clearComposer(page, cdp, sid) {
  await doClear(page, cdp, sid, { clearChips: true });
  await sleep(300);
  const deadline = Date.now() + 4000;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    if ((await composerInfo(page)).len !== 0) {
      await doClear(page, cdp, sid);
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1200) {
      break;
    }
    await sleep(300);
  }
  const left = await composerInfo(page);
  if (left.len !== 0) {
    throw new Error(
      `输入框没清干净（还剩 ${left.len} 字，kind=${left.kind}，-1 表示读不到编辑器）。` +
        '继续发送会把旧内容和新提示词拼在一起，模型会收到重复指令。已中止。',
    );
  }
  return left;
}

// 校验归一化：\r\n → \n、不换行空格 → 空格、连续换行折叠为单个换行。
// 2026-11-07 实测：ChatGPT composer 把空行加倍渲染（\n\n → \n\n\n\n\n，插入空段落），
// 2026-11-07 实测两种渲染变换：空行加倍（2 连换行 → 5 连换行）与软换行升级（1 连 → 2 连）。折叠只用于判定，不改写实际发送内容；残稿防护不受影响（残稿内容与提示词不同，折叠后仍不相等）。
export function normalizeFillText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 填提示词并**按内容**校验（输入框必须真的包含这条提示词的开头）。
 * 只看长度会被「异步恢复的草稿」骗过——2026-10-21 实测：残稿 36 字冒充了 25 字的新
 * 提示词，导致把上一轮的"请勿回复"发了出去。所以每轮填写前先清干净，填完做
 * 开头包含 + 全文长度 sanity 双校验。主用派发 paste 事件（ProseMirror 稳定吃这套），
 * 失败退 Input.insertText（textarea 路径）。改 innerText 不进框架状态，绝不走那条路。
 * 返回实际填入字数。
 */
export async function fillPrompt(
  page,
  cdp,
  sid,
  prompt,
  { log: _log = log, beforeAttempt = async () => {} } = {},
) {
  const FOCUS_JS = `(() => {
    const el = document.querySelector(${JSON.stringify(SEL.composerAll)});
    if (!el) return false;
    el.focus();
    return true;
  })()`;
  const PASTE_JS = `(() => {
    const ed = document.querySelector(${JSON.stringify(SEL.composerAll)});
    if (!ed) return false;
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(prompt)});
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`;
  const target = normalizeFillText(prompt);
  const head = target.slice(0, Math.min(40, target.length));
  const waitContent = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let t = '';
    while (Date.now() < deadline) {
      t = await composerText(page).catch(() => '');
      const n = normalizeFillText(t);
      if (n && n.includes(head)) return n.length;
      await sleep(150);
    }
    return 0;
  };
  let filled = 0;
  for (let attempt = 0; attempt < 5 && filled < 1; attempt++) {
    await beforeAttempt();
    await doClear(page, cdp, sid); // 每轮从干净输入框开始，防止残稿与提示词拼串
    const cleared = await composerInfo(page).catch(() => null);
    _log(`attempt ${attempt + 1}: 清空后 kind=${cleared?.kind ?? '?'} len=${cleared?.len ?? '?'}`);
    if (!(await page.evaluate(FOCUS_JS).catch(() => false))) throw new Error('找不到输入框');
    const ok = await evalT(page, PASTE_JS, 15000).catch(() => false);
    _log(`attempt ${attempt + 1}: paste 返回 ${ok}`);
    if (ok) filled = await waitContent(12000);
    if (filled < 1) {
      await cdp.call('Input.insertText', { text: prompt }, sid).catch(() => {});
      filled = await waitContent(12000);
    }
    if (filled < 1) {
      const info = await composerInfo(page).catch(() => null);
      const text = await composerText(page).catch(() => '');
      _log(
        `attempt ${attempt + 1}: 重试前 kind=${info?.kind ?? '?'} len=${info?.len ?? '?'} 实际=${JSON.stringify(text.slice(0, 80))}`,
      );
      await sleep(1000);
    }
  }
  if (filled < 1) {
    const info = await composerInfo(page);
    const text = await composerText(page).catch(() => '');
    throw new Error(
      `提示词没填进去（输入框 ${filled ? '' : '不'}含目标内容，kind=${info.kind}，len=${info.len}，实际=${JSON.stringify(text.slice(0, 120))}）`,
    );
  }
  const gotN = normalizeFillText(await composerText(page));
  const wantN = normalizeFillText(prompt);
  if (gotN !== wantN) {
    let div = 0;
    while (div < Math.min(gotN.length, wantN.length) && gotN[div] === wantN[div]) div += 1;
    _log(
      `mismatch: gotLen=${gotN.length} wantLen=${wantN.length} div@${div}` +
        ` got=${JSON.stringify(gotN.slice(Math.max(0, div - 20), div + 40))}` +
        ` want=${JSON.stringify(wantN.slice(Math.max(0, div - 20), div + 40))}`,
    );
    throw new TaskError(
      'PROMPT_MISMATCH',
      'Composer text differs from the requested prompt; nothing was sent',
    );
  }
  return filled;
}

/**
 * 挂附件。kind='photos'（图片，生图参考图）或 'files'（通用文件，zip）。
 * 只有对应 aria-label 的 input 能收对应类型；用 input[type=file] 会选中第一个 image/*，
 * 附件被静默丢弃。React 可能重渲染清空 input.files，必须验证 Remove 芯片并重试。
 * 定位不用 DOM.getDocument（新标签页导航时会偶发挂住），走 Runtime.evaluate 拿 objectId。
 *
 * photos 会先等上传框可用（最长 20s）：刚打开的页面会短暂 disabled（水合慢），
 * 但真限额时它**一直** disabled——等满 20s 仍不可用才判，抛 QuotaError。
 */
export async function attachFiles(
  page,
  cdp,
  sid,
  files,
  { kind = 'files', retries = 10, log: _log = log } = {},
) {
  const selector = kind === 'photos' ? SEL.filePhotos : SEL.fileFiles;
  const findExpr =
    `document.querySelector(${JSON.stringify(selector)})` +
    (kind === 'files' ? ` || document.querySelector('input[type="file"][accept=""]')` : '');
  if (kind === 'photos') {
    let enabled = false;
    for (let round = 0; round < 2 && !enabled; round++) {
      if (round === 1) {
        _log('上传框 20 秒未启用，刷新页面重试一次（排除页面降级）');
        await cdp.call('Page.enable', {}, sid).catch(() => {});
        await cdp.call('Page.reload', { ignoreCache: false }, sid).catch(() => {});
        await sleep(2500);
        await waitComposerReady(page, cdp, sid, { timeoutMs: 30000, log: _log }).catch(() => {});
      }
      for (let i = 0; i < 20; i++) {
        enabled = await page
          .evaluate(
            `(() => { const i = document.querySelector(${JSON.stringify(selector)}); return !!i && i.disabled === false; })()`,
          )
          .catch(() => false);
        if (enabled) break;
        await sleep(1000);
      }
    }
    if (!enabled) {
      throw new TaskError(
        'UPLOAD_UNAVAILABLE',
        'Upload input is unavailable after one refresh; this alone does not prove a quota limit',
      );
    }
  }
  await cdp.call('DOM.enable', {}, sid).catch(() => {});
  await sleep(1000);
  for (let attempt = 0; attempt < retries; attempt++) {
    let objectId = null;
    try {
      const r = await cdp.call('Runtime.evaluate', { expression: findExpr, returnByValue: false }, sid);
      objectId = r?.result?.objectId || null;
    } catch (e) {
      _log(`定位文件输入框失败：${e.message}`);
    }
    if (!objectId) {
      await sleep(500);
      continue;
    }
    try {
      await cdp.call('DOM.setFileInputFiles', { files, objectId }, sid);
    } catch (e) {
      _log(`setFileInputFiles 失败：${e.message}`);
    }
    await sleep(1200);
    const uploaded = await page
      .evaluate(
        `(() => {
      const labels = [...document.querySelectorAll(${JSON.stringify(SEL.attachChip)})]
        .map(el => el.getAttribute('aria-label') || '');
      const expected = ${JSON.stringify(files.map((file) => basename(file)))};
      return labels.length >= expected.length && expected.every(name =>
        labels.filter(label => label.includes(name)).length >= expected.filter(value => value === name).length);
    })()`,
      )
      .catch(() => false);
    if (uploaded) return true;
    _log(`附件未挂上，重试 ${attempt + 1}`);
  }
  throw new Error('附件挂载失败（input.files 被页面清空或附件芯片未出现）。刷新页面重试。');
}

/**
 * 读当前登录账号的显示名。profile 按钮三行是「Loading profile / 账号名 / 套餐」，取有效行。
 * 注意：必须紧跟在 composer 出现后调用——侧边栏几秒后自动收起，收起后按钮宽度 0、
 * 只剩「Loading profile」，就再也读不到了（读不到时会点 Show sidebar 展开）。
 * /backend-api/me 返回的 email/name 是脱敏空串，读不到邮箱，只能读显示名。
 */
export async function readAccount(page, cdp, sid, { timeoutMs = 20000 } = {}) {
  const read = async () => {
    const raw = await evalT(
      page,
      `document.querySelector(${JSON.stringify(SEL.profile)})?.innerText || ''`,
    ).catch(() => '');
    return (
      raw
        .replace(/loading profile/gi, '')
        .replace(/\bfree\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || ''
    );
  };
  let name = await read();
  if (name) return name;
  const box = await evalT(
    page,
    `(() => {
    const b = document.querySelector(${JSON.stringify(SEL.sidebar)});
    if (!b) return 'NO';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`,
  ).catch(() => 'NO');
  if (box && box !== 'NO') {
    const { x, y } = JSON.parse(box);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await sleep(120);
    await cdp.call(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      sid,
    );
    await sleep(60);
    await cdp.call(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      sid,
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    name = await read();
    if (name) return name;
    await sleep(500);
  }
  return '';
}

/** 账号校验。跑错号会白耗额度，不符就抛错（调用方应在消耗额度之前调用）。 */
export function checkAccount(acct, want) {
  if (!want) return acct;
  if (!acct || !acct.toLowerCase().includes(String(want).toLowerCase())) {
    throw new Error(
      `当前登录的是「${acct || '未知'}」，与要求「${want}」不符。已中止，未消耗额度。` +
        '切号用 chatgpt-web/scripts/account.mjs（退出登录会清当前会话，密码只能用户自己输）。',
    );
  }
  return acct;
}

async function realClickAt(cdp, sid, rect) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sid);
  await sleep(120);
  await cdp.call(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
    sid,
  );
  await sleep(80);
  await cdp.call(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
    sid,
  );
}

const THINK_PROBE_JS = `(() => {  const b = [...document.querySelectorAll('button,[role="button"]')]
    .find(x => /^Think(ing)?$/i.test((x.innerText || '').trim())
            && x.getBoundingClientRect().width > 0);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return JSON.stringify({
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    pressed: b.getAttribute('aria-pressed'),
    text: (b.innerText || '').trim(),
  });
})()`;

/**
 * 打开/关闭 composer 的「Think」开关。幂等：已经是目标状态就不点。
 *
 * 失败语义：找不到按钮 → 抛错并列出工具栏可点项。**不要静默跳过**——
 * 静默跳过正是「以为开了其实没开」的来源。
 */
export async function setThinking(page, cdp, sid, { on = true, log: _log = log } = {}) {
  const want = String(!!on);
  for (let i = 0; i < 6; i++) {
    const raw = await page.evaluate(THINK_PROBE_JS).catch(() => null);
    const st = raw ? JSON.parse(raw) : null;
    if (!st) {
      const seen = JSON.parse(
        await page
          .evaluate(
            `(() => {
        return JSON.stringify([...document.querySelectorAll('button,[role="button"]')]
          .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(b => (b.innerText || '').trim() || b.getAttribute('aria-label') || '')
          .filter(Boolean).slice(-14));
      })()`,
          )
          .catch(() => '[]'),
      );
      throw new Error(`找不到「Think」开关。工具栏可点项：${JSON.stringify(seen)}`);
    }
    if (st.pressed === want) {
      _log(`Think 已是${on ? '开' : '关'}（aria-pressed=${st.pressed}）`);
      return true;
    }
    await realClickAt(cdp, sid, st);
    await sleep(700);
  }
  const raw = await page.evaluate(THINK_PROBE_JS).catch(() => null);
  const st = raw ? JSON.parse(raw) : null;
  throw new Error(`点了 6 次 Think，aria-pressed 仍是 ${st ? st.pressed : '读不到'}（目标 ${want}）。`);
}

/**
 * 点发送并确认「对话里多了一条用户消息」——这是真正的发送成功信号（比「输入框清空」强）。
 * 判死语义：消息没出现且输入框没清空 = 点击没生效，直接抛错。继续等只会白耗时间，
 * 重复点发送还可能重复消耗额度。输入框清空而消息元素没出现，多半是选择器变了，
 * 继续等回复比中止更划算（按已发送处理并告警）。
 */
export async function sendAndConfirm(page, { confirmTimeoutMs = 25000, log: _log = log } = {}) {
  await waitFor(
    page,
    `(() => {
    const b = document.querySelector(${JSON.stringify(SEL.send)});
    return !!b && !b.disabled;
  })()`,
    90000,
    '发送按钮',
  );
  const keysJs = `[...document.querySelectorAll(${JSON.stringify(SEL.userMsg)})]
    .map(el => el.getAttribute('data-chatgpt-search-unit-key'))`;
  const beforeKeys = await page.evaluate(keysJs);
  await page.evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(SEL.send)});
    if (!b || b.disabled) throw new Error('发送按钮不可用');
    b.click();
  })()`);
  const sent = await waitFor(
    page,
    `(${keysJs}).some(key => !${JSON.stringify(beforeKeys)}.includes(key))`,
    confirmTimeoutMs,
    '本轮用户消息已出现在对话里',
  ).catch(() => false);
  if (!sent) {
    throw new TaskError(
      'SEND_UNCONFIRMED',
      'Cannot confirm whether this message was sent. Inspect the conversation before retrying.',
    );
  }
  const keys = await page.evaluate(keysJs);
  const userKey = keys[keys.length - 1];
  if (!userKey || beforeKeys.includes(userKey))
    throw new TaskError(
      'SEND_UNCONFIRMED',
      'Cannot identify the sent message. Inspect the conversation before retrying.',
    );
  return { userKey };
}

/**
 * 发送后等 SPA 从 / 跳到 /c/<id>（导航期间 DOM 整棵替换；不等跳转查消息会查到旧 DOM）。
 * 跳转失败不致命（继续按当前页面找），只告警。
 */
export async function waitConvUrl(page, { timeoutMs = 30000, log: _log = log } = {}) {
  try {
    await page.waitForFunction(`/^https:\\/\\/chatgpt\\.com\\/c\\//.test(location.href)`, {
      timeoutMs,
      pollingMs: 500,
    });
  } catch {
    _log('URL 未跳到 /c/，继续按当前页面找回复');
  }
}

export { waitTurnComplete, collectReply } from './reply.mjs';

/**
 * 事件驱动唤醒：页面内 MutationObserver 监听 turn 状态属性与子树变化，变化后静默
 * 250ms 即返回（先于硬上限）；流式输出期间变化流持续 → 一路推迟到硬上限（=原轮询
 * 间隔），不增加流式期间的评估频次。检测延迟从固定 600ms 降到 ~250ms。测试桩等
 * 无 MutationObserver 的环境退化为纯 sleep 语义（硬上限照常到点）。
 */
async function wakeOnDomChange(page, ms) {
  if (ms <= 0) return;
  try {
    await page.evaluate(
      `(async () => {
        await new Promise((resolve) => {
          let observer = null;
          let quiet = null;
          const finish = () => {
            if (observer) observer.disconnect();
            resolve('wake');
          };
          const hard = setTimeout(finish, ${ms});
          if (typeof MutationObserver === 'undefined') return; // stub environments: degrade to pure sleep
          observer = new MutationObserver(() => {
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(finish, 250);
          });
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-talvt-turn-state'],
          });
        });
      })()`,
      ms + 1000,
    );
  } catch {
    // 页面跳转/评估环境异常：退化为纯 sleep，下一轮轮询兜底
    await sleep(Math.min(ms, 600));
  }
}

/**
 * 页面内 fetch 下载图片（带类型/大小校验），返回 base64 payload。
 * 主检测路径与 UI 漂移兜底共用，防两份拷贝漂移。
 */
async function fetchImagePayload(page, src, budgetMs) {
  return page.evaluate(
    `(async () => {
        const response = await fetch(${JSON.stringify(src)}, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Image download HTTP ' + response.status);
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Unsupported image response type');
        if (Number(response.headers.get('content-length')) > 67108864) throw new Error('Image is too large');
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 67108864) throw new Error('Image is too large');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        let binary = '';
        for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 32768)
          binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
        return { base64: btoa(binary), mime };
      })()`,
    Math.min(35_000, Math.max(1, budgetMs)),
  );
}

/**
 * 收集页面上「够大的」blob:/data: 图片的 src。
 *
 * 用途（2026-11-18）：产物兜底要排除「本轮请求之前就存在的图」。
 * 这条**只用图片自身的尺寸与 src**，不依赖任何消息结构选择器——
 * 因为那些选择器正是会被 ChatGPT 改版打掉的东西。
 */
export async function collectLargeImageSrcs(page, { minSide = 300 } = {}) {
  const raw = await page.evaluate(
    `(() => {
      const out = [];
      for (const el of document.querySelectorAll('img')) {
        const src = el.src || '';
        if (!/^(blob:|data:image)/.test(src)) continue;
        const w = el.naturalWidth || 0, h = el.naturalHeight || 0;
        if (w < ${Number(minSide)} || h < ${Number(minSide)}) continue;
        out.push(src);
      }
      return JSON.stringify(out);
    })()`,
    15_000,
  );
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 产物探测：按「图片自身」而非语义结构找生成图（只读，不下载）。
 *
 * 判据（循环内快速探测与循环外兜底共用同一实现，避免判据漂移）：
 *   * src 是 blob:/data:image；
 *   * 自然尺寸 >= minSide（生成图远大于头像/图标）；
 *   * 不在 beforeSrcs 里（排除发送前就存在的陈旧图）。
 *
 * **排序（2026-11-18 实测修正，这条很关键）**：
 *   原来只按面积降序取第一张。真机上参考图（`alt: "User attachment"`）与生成图
 *   （`alt: "Generated image 1"`）**尺寸完全相同**（都是 1086x1448），
 *   面积相等时 sort 的稳定性决定谁在前 —— 实测 `User attachment` 排在前面，
 *   于是「取最大图」实际取到的是**用户上传的参考图**，而不是生成结果。
 *   这会把原图当答案存下去，是**静默的错图**（比失败更糟，因为看起来成功了）。
 *
 *   修正：分两级排序——
 *     1) 先按「是否像生成图」：alt 匹配 Generated image / 已生成图像 的排最前；
 *     2) 同级再按面积降序。
 *   另外显式把 `User attachment`（上传的输入图）排到最后，作为双保险。
 */
export async function probeProductImage(page, { beforeSrcs = [], minSide = 300 } = {}) {
  return page.evaluate(
    `(() => {
      const minSide = ${Number(minSide)};
      const before = new Set(${JSON.stringify(beforeSrcs || [])});
      const GENERATED = /Generated image|已生成图像/i;
      const ATTACHMENT = /User attachment|用户附件|附件/i;
      const out = [];
      for (const [idx, el] of [...document.querySelectorAll('img')].entries()) {
        const src = el.src || '';
        if (!/^(blob:|data:image)/.test(src)) continue;
        const w = el.naturalWidth || 0, h = el.naturalHeight || 0;
        if (w < minSide || h < minSide) continue;
        if (before.has(src)) continue;
        const alt = el.alt || '';
        // rank 越小越优先：0=明确是生成图，1=无标注，2=明确是上传的附件
        const rank = GENERATED.test(alt) ? 0 : ATTACHMENT.test(alt) ? 2 : 1;
        out.push({ idx, w, h, src, alt, rank });
      }
      out.sort((a, b) => (a.rank - b.rank) || (b.w * b.h - a.w * a.h));
      // ── 产物资格（2026-11-19 外审 P0）──────────────────────────────────
      // 原来 \`found: out.length > 0\` 会把 rank=2（用户上传的参考图）也算成
      // 「找到了产物」；调用方只判 \`early?.found && early.src\`，**根本不看 rank**，
      // 于是「上传参考图 → 语义检测抛错 → 生成图还没出现」时会把参考图
      // 当生成结果落盘，且外层认为成功。
      //
      // 现在把「候选发现」与「产物资格」分开：
      //   * found        —— 只代表「页面上有可选候选」，不代表可以用；
      //   * eligible     —— 是否**允许当产物保存**：rank 必须 < 2（明确附件一律禁止）；
      //   * eligibleSrc  —— 允许保存的那一张（没有就是 null）。
      // 调用方**必须**判 eligible，不得再用 found。
      const eligibleCandidates = out.filter((c) => c.rank < 2);
      const best = eligibleCandidates[0] || null;
      return {
        found: out.length > 0,
        eligible: !!best,
        eligibleSrc: best?.src || null,
        eligibleAlt: best?.alt || '',
        // 明确是附件的最优先候选（用于报错时说明「只看到你的参考图」）
        attachmentOnly: out.length > 0 && !best,
        src: best?.src || null,
        count: out.length,
        w: best?.w || 0,
        h: best?.h || 0,
        idx: best?.idx ?? -1,
        alt: best?.alt || '',
        // 诊断用：把候选的 rank/alt 带出来，出错时能看懂为什么选了它
        candidates: out.slice(0, 5).map((c) => ({
          idx: c.idx, w: c.w, h: c.h, rank: c.rank, alt: c.alt,
        })),
      };
    })()`,
    15_000,
  );
}

/**
 * 等生图完成并保存最后一张 Generated image 到 outPath，返回对话 URL。
 * 必须用发送之后**新开的连接**调用（文件头纪律 2）。额度耗尽抛 QuotaError。
 *
 * 2026-11-18 新增 `beforeSrcs`：
 *   发送前页面上已有的大图 src 集合。产物兜底用它排除「本轮之前就有的图」，
 *   避免把上一轮的陈旧图当成这次的产物。
 * 新增 `minSide`：产物兜底的最小边长（默认 300，滤掉头像/图标）。
 */
export async function waitAndSaveImage(
  page,
  outPath,
  timeoutMs,
  { replyTo = null, recoveryMs = 120000, beforeSrcs = [], minSide = 300 } = {},
) {
  let deadline = Date.now() + timeoutMs;
  let reloaded = false;
  // 检测阶段抛出的第一个错误：兜底全部失败时用它作为最终失败原因，
  // 免得把「语义结构漂移」这个真正原因吞掉、只报一句泛泛的超时。
  let firstStateError = null;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await evalT(
        page,
        `(() => {
      const users = [...document.querySelectorAll(${JSON.stringify(SEL.userMsg)})];
      const user = users[users.length - 1];
      const cursor = ${JSON.stringify(replyTo)};
      if (cursor && !user) return { ready: false, tail: '' };
      if (cursor && user.getAttribute('data-chatgpt-search-unit-key') !== cursor.userKey)
        throw new Error('Current user message does not match the image request');
      const assistants = [...document.querySelectorAll(${JSON.stringify(SEL.assistant)})]
        .filter(el => !cursor || (!(user.compareDocumentPosition(el) & 1) && (user.compareDocumentPosition(el) & 4)));
      const assistant = assistants[assistants.length - 1];
      // New image-only replies may omit the assistant search-unit marker. Bind
      // their gallery to the exact current user's enclosing turn and DOM order.
      // 2026-11-12 UI drift: the generated image may also sit OUTSIDE the
      // assistant unit (gallery became a sibling inside the turn), so an
      // assistant-first scope scanned nothing and missed completed images
      // (0/3 real misses today). Collect from both the assistant and the
      // galleries and merge; galleries stay bound to the current turn and
      // DOM-ordered after the user, keeping stale/unfinished protections.
      const currentTurn = cursor ? user?.closest(${JSON.stringify(SEL.turn)}) : null;
      const turns = [...document.querySelectorAll(${JSON.stringify(SEL.turn)})];
      const last = currentTurn || turns[turns.length - 1];
      const boundTurn = currentTurn || last;
      const galleries = boundTurn
        ? [...boundTurn.querySelectorAll('[data-testid="generated-image-gallery"]')].filter(
            (el) => !cursor || (!(user.compareDocumentPosition(el) & 1) && (user.compareDocumentPosition(el) & 4)),
          )
        : [];
      const altTest = /Generated image|已生成图像/i;
      const collected = [
        ...(assistant ? [...assistant.querySelectorAll('img')].filter((i) => altTest.test(i.alt)) : []),
        ...(galleries.length
          ? galleries.flatMap((g) => [...g.querySelectorAll('img')]).filter((i) => altTest.test(i.alt))
          : []),
      ];
      const uniq = [...new Set(collected)];
      // Background/minimized windows may defer bitmap decode (naturalWidth stays 0);
      // prefer decoded images, fall back to undecoded (download via src fetch).
      const decoded = uniq.filter((i) => i.naturalWidth > 200 && i.src);
      const images = decoded.length ? decoded : uniq.filter((i) => i.src);
      const stop = [...document.querySelectorAll('button')].some(b => /停止|Stop/i.test(b.getAttribute('aria-label') || ''));
      return { ready: !!last && last.getAttribute('data-talvt-turn-state') === 'complete' && !stop && images.length > 0,
        src: images.at(-1)?.src, tail: assistant?.innerText?.slice(-500) || '' };
    })()`,
        Math.min(8000, Math.max(1, deadline - Date.now())),
      );
    } catch (error) {
      // 2026-11-18 实测缺陷（两个，连着踩到的）：
      //
      // 缺陷 1：这里原来写的是 `if (!reloaded) throw error;` —— 第一次出错就直接
      //   抛出去。可下面那两层兜底（UI 漂移 sweep / 产物扫描）都在**循环之外**，
      //   抛出去就永远走不到它们。当天 ChatGPT 让语义锚点失效，进来就抛
      //   "Current user message does not match the image request"，图明明已生成
      //   （实测会话里有 1087x1447 的 "Generated image 1"），却一律判 failed。
      //
      // 缺陷 2（修缺陷 1 时引入的）：改成了 `firstStateError = error; break;`。
      //   **break 立即跳出循环，等于放弃了所有等待**。而图是异步生成的，
      //   跳出那一刻它还没渲染出来，兜底扫到的自然是空 —— 于是仍然失败，
      //   只是错误码变好看了（IMAGE_STATE_UNRECOGNIZED）。实测 2/2 依旧全灭，
      //   重新打开会话却能看到完整生成图。
      //
      // 正确做法：**记下错误但继续循环**。循环本身负责等待、死线、以及到点后
      // 那次 reload 宽限（L951-960 的 recoveryMs 路径）——那条路径是之前实测
      // 能救回慢速生成图的关键，不能因为一次检测失败就丢掉。
      // 只有当本次迭代距死线已无剩余时间时才真正退出。
      firstStateError = firstStateError || error;
      // 语义检测失败时**先**做快速产物探测（2026-11-18）。
      // 位置很关键：下面 `continue` 会回到循环顶部，如果把探测放在循环体尾部，
      // 走 catch 分支的每一轮都会跳过它 —— 而「语义检测失效」正是最需要它的场景。
      const early = await probeProductImage(page, { beforeSrcs, minSide }).catch(() => null);
      // 必须用 eligible 而不是 found（2026-11-19 外审 P0）：
      // found 只表示「页面上有候选」，rank=2 的用户参考图也算候选；
      // 只有 eligible（rank<2，明确不是附件）才允许落盘。
      if (early?.eligible && early.eligibleSrc) {
        try {
          const payload = await fetchImagePayload(page, early.eligibleSrc, deadline - Date.now());
          await saveImagePayload(payload, outPath);
          console.error(
            `[chatgpt-web] IMAGE_QUICK_PRODUCT: semantic detection failing but a ` +
              `${early.w}x${early.h} image is already present; recovered without waiting for timeout.`,
          );
          return currentUrl(page);
        } catch {
          // 取回失败（图还在写、blob 失效等）：继续按原流程等待
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(300);
      continue;
    }
    if (/used all your free images|reached.{0,30}image.{0,20}limit/i.test(state.tail)) {
      const error = new QuotaError('The current assistant message reports an image quota limit');
      error.rawMessage = state.tail;
      throw error;
    }
    if (RE.fail.test(state.tail))
      throw new TaskError(
        'IMAGE_GENERATION_FAILED',
        'The current assistant message reports a generation failure',
      );
    if (state.ready) {
      const payload = await fetchImagePayload(page, state.src, deadline - Date.now());
      await saveImagePayload(payload, outPath);
      return currentUrl(page);
    }
    await wakeOnDomChange(page, Math.min(600, Math.max(0, deadline - Date.now())));
    // 快速产物探测放在 catch 分支里（见上方），这里不再重复。
    // 原因：语义检测正常但尚未 ready 时，图本来就还没好，探测只会浪费 evaluate；
    // 而检测抛错时才是「语义失效、只能看产物」的场景，必须优先探。
    if (!reloaded && Date.now() >= deadline) {
      // Deadline reached: a slow server can complete the image after the client
      // gave up — the same conversations later held finished images while the
      // command had already failed (2026-11-08: three real IMAGE_TIMEOUT).
      // Reload once and grant a grace window before reporting failure.
      if (recoveryMs <= 0) break;
      reloaded = true;
      deadline += recoveryMs;
      await page.evaluate('location.reload()').catch(() => {});
      await sleep(300);
      continue;
    }
  }
  // UI 漂移兜底：检测路径扫空但图已完成时，全文档扫描（绑定 cursor 用户消息之后
  // 的位置，陈旧图不误收）通常仍能拿到已完成的图——把 UI 改版从「硬失败 + 手工
  // 救援」降级为「照样出图 + stderr 告警」（2026-11-12 三张真机回收实证该路径
  // 3/3 可用）。
  try {
    const sweep = await page.evaluate(
      `(() => {
      const users = [...document.querySelectorAll(${JSON.stringify(SEL.userMsg)})];
      const user = users[users.length - 1];
      const cursor = ${JSON.stringify(replyTo)};
      const altTest = /Generated image|已生成图像/i;
      const imgs = [...document.querySelectorAll('img')]
        .filter(i => altTest.test(i.alt || '') && i.src)
        .filter(i => !cursor || !user || (user.compareDocumentPosition(i) & 4));
      return { found: imgs.length > 0, src: imgs.at(-1)?.src || null, count: imgs.length };
    })()`,
      15_000,
    );
    if (sweep?.found && sweep.src) {
      const payload = await fetchImagePayload(page, sweep.src, 35_000);
      await saveImagePayload(payload, outPath);
      console.error(
        `[chatgpt-web] IMAGE_FALLBACK_SWEEP: detection scope matched nothing (possible UI drift) ` +
          `but a conversation-wide sweep found ${sweep.count} image(s); saved via fallback sweep.`,
      );
      return currentUrl(page);
    }
  } catch {
    // 兜底扫描失败：按原始超时失败收场，下一层是调用方的候选/回收机制
  }
  // ── 产物驱动兜底（2026-11-18 新增）───────────────────────────────
  // 前面所有路径都锚在「用户消息 / assistant 单元 / turn」这些**语义结构**上。
  // 2026-11-18 实测：ChatGPT 一次改版让这些选择器**全部命中 0 个**——
  //   [data-message-author-role] / [data-testid="user-message"] /
  //   article[data-testid^="conversation-turn"] / [data-search-unit-id]
  // 于是在第 842 行抛 "Current user message does not match the image request"，
  // 引擎 exit 1，整批生图被判 failed——**但图其实早就生成好了**（在 blob: URL 里）。
  //
  // 这一层彻底不依赖语义结构：只看「页面上有没有新出现的、够大的图片」。
  // 判据：
  //   * src 是 blob:/data:image 且自然尺寸 >= minSide（生成图远大于头像/图标）；
  //   * 排除 alt 匹配「Generated image」的图——那些已被上面更精确的路径处理过；
  //   * 取**面积最大**的那张（生成图通常是最大图）；
  //   * 排除本轮请求之前就存在的图（用 before 集合，按 src 比对）。
  try {
    const product = await probeProductImage(page, { beforeSrcs, minSide });
    // 同样必须用 eligible（2026-11-19 外审 P0）：明确是用户附件的候选一律不落盘。
    if (product?.eligible && product.eligibleSrc) {
      const payload = await fetchImagePayload(page, product.eligibleSrc, deadline - Date.now());
      await saveImagePayload(payload, outPath);
      console.error(
        `[chatgpt-web] IMAGE_PRODUCT_FALLBACK: message/turn scope matched nothing ` +
          `(UI drift — semantic selectors are gone) but a ${product.w}x${product.h} ` +
          `image was found by product scan; saved via product fallback.`,
      );
      return currentUrl(page);
    }
    // 只看到附件 = 生成图还没出来 / 生成失败。这**不能**当成功，也不能当超时，
    // 要报一个能看懂的原因，否则又回到「静默错图」那类问题。
    if (product?.attachmentOnly) {
      throw new TaskError(
        'IMAGE_ONLY_ATTACHMENT',
        '只找到本轮上传的参考图，没有找到生成的图片（参考图一律不当作产物保存）。',
      );
    }
  } catch (err) {
    if (err instanceof TaskError) throw err;
    // 产物兜底也失败：按原始超时失败收场
  }
  // 两层兜底都没拿到图。如果检测阶段有具体错误（例如语义结构漂移），
  // 用它当失败原因——这比一句 IMAGE_TIMEOUT 更能说明问题出在哪。
  if (firstStateError) {
    const wrapped = new TaskError(
      'IMAGE_STATE_UNRECOGNIZED',
      'Image detection failed and both fallbacks found nothing: ' + firstStateError.message,
    );
    wrapped.cause = firstStateError;
    throw wrapped;
  }
  throw new TaskError('IMAGE_TIMEOUT', 'Image generation did not complete within the configured timeout');
}

/**
 * UI 契约探针（canary）：在已完成的生图会话上运行与 waitAndSaveImage 相同的
 * scope 收集路径（assistant + turn 绑定 gallery 并集），并对照全文档计数，识别
 * 「图在但 scope 扫空」的 UI 漂移。只读、不下载、不发送。页面应已位于 /c/ 会话。
 */
export async function imageContractProbe(page) {
  const counts = await page.evaluate(
    `(() => {
      const users = [...document.querySelectorAll(${JSON.stringify(SEL.userMsg)})];
      const user = users[users.length - 1];
      const assistants = [...document.querySelectorAll(${JSON.stringify(SEL.assistant)})];
      const assistant = assistants[assistants.length - 1];
      const turns = [...document.querySelectorAll(${JSON.stringify(SEL.turn)})];
      const last = turns[turns.length - 1];
      const galleries = last
        ? [...last.querySelectorAll('[data-testid="generated-image-gallery"]')]
        : [];
      const altTest = /Generated image|已生成图像/i;
      const collected = [
        ...(assistant ? [...assistant.querySelectorAll('img')].filter((i) => altTest.test(i.alt)) : []),
        ...galleries.flatMap((g) => [...g.querySelectorAll('img')]).filter((i) => altTest.test(i.alt)),
      ];
      const scopeCount = [...new Set(collected)].filter((i) => i.src).length;
      const docCount = [...document.querySelectorAll('img')].filter((i) => altTest.test(i.alt || '') && i.src)
        .length;
      return { scopeCount, docCount };
    })()`,
    15_000,
  );
  return counts;
}

/** 当前标签页 URL（读不到返回空串）。 */
export async function currentUrl(page) {
  return page.evaluate('location.href').catch(() => '');
}
