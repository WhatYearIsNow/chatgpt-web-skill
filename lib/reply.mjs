// 文本回复的回合归属与稳定性。独立于 CDP，可用离线 DOM 夹具验证。
import { setTimeout as sleep } from 'node:timers/promises';
import { SEL } from './selectors.mjs';

function snapshot(sel, replyTo) {
  const strip = (s) => (s || '').replace(/^\s*ChatGPT said:\s*/i, '').trim();
  const empty = (src) => ({ text: '', src, complete: false });
  if (!document.body) return empty('no-body');
  const stop = [...document.querySelectorAll('button')].some((b) =>
    /停止|Stop/i.test(b.getAttribute('aria-label') || ''),
  );
  let assistants = [...document.querySelectorAll(sel.assistant)];
  if (replyTo) {
    const users = [...document.querySelectorAll(sel.userMsg)];
    const user = users[users.length - 1];
    // 后来者又发了消息、导航走了、历史尚未挂载时，都不认旧回复。
    if (!user || user.getAttribute('data-chatgpt-search-unit-key') !== replyTo.userKey)
      return empty('user-mismatch');
    assistants = assistants.filter((el) => {
      const relation = user.compareDocumentPosition(el);
      return !(relation & 1) && !!(relation & 4);
    });
    if (!assistants.length) return empty('awaiting-current-assistant');
  }
  const turns = [...document.querySelectorAll(sel.turn)];
  const lastTurn = turns[turns.length - 1];
  const complete = !!lastTurn && lastTurn.getAttribute('data-talvt-turn-state') === 'complete' && !stop;
  const el = assistants[assistants.length - 1];
  if (el) {
    let text = strip(el.innerText);
    if (text) return { text, src: 'assistant.innerText', complete };
    const md = el.querySelector(sel.markdownCopy);
    text = strip(md?.innerText);
    if (text) return { text, src: 'markdown', complete };
    text = strip(el.textContent);
    if (text) return { text, src: 'assistant.textContent', complete };
  }
  // 有回合归属时绝不用整页尾部：那可能是上一轮正文或本轮提示词里的引文。
  if (!replyTo) {
    const body = document.body.innerText || '';
    const i = body.lastIndexOf('ChatGPT said:');
    if (i >= 0) {
      const text = body
        .slice(i + 'ChatGPT said:'.length)
        .split('ChatGPT can make mistakes')[0]
        .replace(/\n+Latest response[\s\S]*$/i, '')
        .trim();
      if (text) return { text, src: 'body-tail', complete };
    }
  }
  return { ...empty('empty'), complete };
}

export function replySnapshotExpression(replyTo = null) {
  if (replyTo && (typeof replyTo.userKey !== 'string' || !replyTo.userKey.endsWith(':user')))
    throw new Error('回复归属缺少本轮用户消息标识，已中止回收');
  return `(${snapshot.toString()})(${JSON.stringify(SEL)}, ${JSON.stringify(replyTo)})`;
}

export async function waitTurnComplete(page, timeoutMs, { replyTo = null } = {}) {
  const expression = replySnapshotExpression(replyTo);
  await page.waitForFunction(`(() => { const r = ${expression}; return r.complete && !!r.text; })()`, {
    timeoutMs,
    pollingMs: 1000,
  });
}

export async function collectReply(
  page,
  { replyTo = null, waitContentMs = 90000, stableIterations = 15, pollingMs = 1000 } = {},
) {
  if (
    !Number.isFinite(waitContentMs) ||
    waitContentMs <= 0 ||
    !Number.isInteger(stableIterations) ||
    stableIterations < 1 ||
    !Number.isFinite(pollingMs) ||
    pollingMs <= 0
  )
    throw new Error('回复等待参数无效');
  const expression = replySnapshotExpression(replyTo);
  const deadline = Date.now() + waitContentMs;
  let lastText = '';
  let stable = 0;
  let last = { text: '', src: 'empty' };
  while (Date.now() < deadline) {
    const r = await page.evaluate(expression);
    last = r;
    if (r.complete && r.text) {
      stable = r.text === lastText ? stable + 1 : 0;
      lastText = r.text;
      if (stable >= stableIterations) {
        // 最后一次求值也必须与已稳定正文一致；中途恢复流式生成则重新等。
        const final = await page.evaluate(expression);
        last = final;
        if (final.complete && final.text === lastText) {
          if (/^cloudflare_challenge$/i.test(final.text.trim()))
            throw new Error('ChatGPT 返回 cloudflare_challenge：浏览器检查未通过。');
          return { text: final.text, src: final.src };
        }
        lastText = '';
        stable = 0;
      }
    } else {
      lastText = '';
      stable = 0;
    }
    await sleep(Math.min(pollingMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `回复在 ${Math.round(waitContentMs / 1000)}s 内未完成或未稳定，已拒收（src=${last.src}，${last.text?.length || 0} 字）`,
  );
}
