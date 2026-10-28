import { connectToUserChrome, Page, sleep } from './browser.mjs';
import { SEL, RE } from './selectors.mjs';

import { saveImagePayload } from './image.mjs';
import { TaskError } from './errors.mjs';
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
      const transient =
        error.code === -32000 && /Not attached to an active page/i.test(error.message);
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
  const head = prompt.slice(0, Math.min(40, prompt.length));
  const waitContent = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let t = '';
    while (Date.now() < deadline) {
      t = await composerText(page).catch(() => '');
      if (t.trim() && t.includes(head)) return t.trim().length;
      await sleep(150);
    }
    return 0;
  };
  let filled = 0;
  for (let attempt = 0; attempt < 5 && filled < 1; attempt++) {
    await beforeAttempt();
    await doClear(page, cdp, sid); // 每轮从干净输入框开始，防止残稿与提示词拼串
    if (!(await page.evaluate(FOCUS_JS).catch(() => false))) throw new Error('找不到输入框');
    const ok = await evalT(page, PASTE_JS, 15000).catch(() => false);
    if (ok) filled = await waitContent(12000);
    if (filled < 1) {
      await cdp.call('Input.insertText', { text: prompt }, sid).catch(() => {});
      filled = await waitContent(12000);
    }
    if (filled < 1) {
      _log(`第 ${attempt + 1} 次填写没生效，重试`);
      await sleep(1000);
    }
  }
  if (filled < 1) {
    const info = await composerInfo(page);
    throw new Error(`提示词没填进去（输入框 ${filled ? '' : '不'}含目标内容，kind=${info.kind}）`);
  }
  const normalize = (value) =>
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .trim();
  if (normalize(await composerText(page)) !== normalize(prompt))
    throw new TaskError(
      'PROMPT_MISMATCH',
      'Composer text differs from the requested prompt; nothing was sent',
    );
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
 * 等生图完成并保存最后一张 Generated image 到 outPath，返回对话 URL。
 * 必须用发送之后**新开的连接**调用（文件头纪律 2）。额度耗尽抛 QuotaError。
 */
export async function waitAndSaveImage(page, outPath, timeoutMs, { replyTo = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evalT(
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
      const currentTurn = cursor ? user?.closest(${JSON.stringify(SEL.turn)}) : null;
      const galleries = currentTurn ? [...currentTurn.querySelectorAll('[data-testid="generated-image-gallery"]')]
        .filter(el => !(user.compareDocumentPosition(el) & 1) && (user.compareDocumentPosition(el) & 4)) : [];
      const scope = assistant || galleries.at(-1);
      const images = scope ? [...scope.querySelectorAll('img')].filter(i => i.naturalWidth > 200 && /Generated image/i.test(i.alt)) : [];
      const turns = document.querySelectorAll(${JSON.stringify(SEL.turn)});
      const last = currentTurn || turns[turns.length - 1];
      const stop = [...document.querySelectorAll('button')].some(b => /停止|Stop/i.test(b.getAttribute('aria-label') || ''));
      return { ready: !!last && last.getAttribute('data-talvt-turn-state') === 'complete' && !stop && images.length > 0,
        src: images.at(-1)?.src, tail: assistant?.innerText?.slice(-500) || '' };
    })()`,
      Math.min(8000, Math.max(1, deadline - Date.now())),
    );
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
      const payload = await page.evaluate(
        `(async () => {
        const response = await fetch(${JSON.stringify(state.src)}, { signal: AbortSignal.timeout(30000) });
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
        Math.min(35000, Math.max(1, deadline - Date.now())),
      );
      await saveImagePayload(payload, outPath);
      return currentUrl(page);
    }
    await sleep(Math.min(600, Math.max(0, deadline - Date.now())));
  }
  throw new TaskError('IMAGE_TIMEOUT', 'Image generation did not complete within the configured timeout');
}

/** 当前标签页 URL（读不到返回空串）。 */
export async function currentUrl(page) {
  return page.evaluate('location.href').catch(() => '');
}
