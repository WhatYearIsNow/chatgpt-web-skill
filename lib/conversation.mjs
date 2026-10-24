// 续问只接受 chatgpt.com 的单个会话地址；查询参数/锚点不影响会话归属。
import { SEL } from './selectors.mjs';
export function conversationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('会话 URL 无效'); }
  const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
  let id;
  try { id = match && decodeURIComponent(match[1]); } catch { throw new Error('会话 URL 编码无效'); }
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password ||
      !id || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(id))
    throw new Error('会话 URL 必须是 https://chatgpt.com/c/<id>');
  return `${url.origin}/c/${encodeURIComponent(id)}`;
}

export function positiveTimeout(value, defaultSeconds = 900) {
  const seconds = Number(value ?? defaultSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2147483647)
    throw new Error('--timeout 必须是有限的正秒数（不超过 2147483 秒）');
  return seconds * 1000;
}

export async function assertIdleComposer(page) {
  const state = await page.evaluate(`(() => {
    const ta = document.querySelector('textarea[placeholder="Ask ChatGPT"]');
    const ed = document.querySelector('[contenteditable="true"]');
    return {
      draft: !!((ta?.value || ed?.innerText || '').trim()),
      attachment: !!document.querySelector(${JSON.stringify(SEL.attachChip)}),
      generating: [...document.querySelectorAll('button')]
        .some(b => /停止|Stop/i.test(b.getAttribute('aria-label') || '')),
    };
  })()`);
  if (state.draft || state.attachment || state.generating)
    throw new Error('指定会话有草稿、附件或正在生成，已中止；请先处理该会话后再续问');
}
