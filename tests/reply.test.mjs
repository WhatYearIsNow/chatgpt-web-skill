import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReply, waitTurnComplete, replySnapshotExpression } from '../lib/reply.mjs';
import { fixture } from './helpers.mjs';

const replyTo = { userKey: 'current:user' };
const history = {
  users: [
    { key: 'old:user', order: 0 },
    { key: 'current:user', order: 2 },
  ],
  assistants: [{ key: 'old:assistant', order: 1, text: '上一轮完整回复' }],
  body: 'ChatGPT said: 上一轮完整回复',
};
// Successful DOM/VM fixtures need scheduling headroom on shared CI runners.
const options = { replyTo, waitContentMs: 2000, stableIterations: 1, pollingMs: 1 };
const rejectionOptions = { ...options, waitContentMs: 80 };

test('续问已发送而新助手尚未出现时，不能通过完成等待或回收旧正文', async () => {
  const page = fixture(history);
  await assert.rejects(waitTurnComplete(page, 100, { replyTo }), /等待条件/);
  await assert.rejects(collectReply(page, rejectionOptions), /已拒收/);
});

test('回收本轮助手，支持只有一个汉字的回复', async () => {
  const page = fixture({
    ...history,
    assistants: [...history.assistants, { key: 'current:assistant', order: 3, text: '好' }],
  });
  await waitTurnComplete(page, 100, { replyTo });
  assert.equal((await collectReply(page, options)).text, '好');
});

test('中途又有用户发言时拒收，避免将后来者回复算入本轮', async () => {
  const page = fixture({
    ...history,
    users: [...history.users, { key: 'later:user', order: 4 }],
    assistants: [{ key: 'current:assistant', order: 3, text: '不应回收' }],
  });
  await assert.rejects(collectReply(page, rejectionOptions), /user-mismatch/);
});

test('本轮正文未挂载时禁止整页尾部回退到旧正文', async () => {
  const page = fixture({
    ...history,
    assistants: [{ key: 'current:assistant', order: 3, text: 'ChatGPT said:' }],
  });
  await assert.rejects(collectReply(page, rejectionOptions), /已拒收/);
});

for (const [name, state] of [
  ['停止按钮仍在', { stop: true }],
  ['回合仍在流式生成', { complete: false }],
]) {
  test(`${name}，正文再稳定也拒收`, async () => {
    const page = fixture({
      ...history,
      ...state,
      assistants: [{ key: 'current:assistant', order: 3, text: '暂时稳定的半截' }],
    });
    await assert.rejects(collectReply(page, rejectionOptions), /已拒收/);
  });
}

test('达到稳定窗后最后一次采样发生变化，必须重新等待新正文稳定', async () => {
  let calls = 0;
  const page = {
    evaluate: async () => ({ complete: true, src: 'fixture', text: ++calls < 3 ? '早期正文' : '最终正文' }),
  };
  assert.equal((await collectReply(page, options)).text, '最终正文');
  assert.ok(calls >= 6);
});

test('正文持续变化直到截止时间时拒收', async () => {
  let count = 0;
  const page = { evaluate: async () => ({ complete: true, src: 'fixture', text: `片段${++count}` }) };
  await assert.rejects(collectReply(page, rejectionOptions), /已拒收/);
});

test('本轮有正文时仍保留 markdown 与 textContent 退路', async () => {
  for (const spec of [{ markdown: 'markdown 正文' }, { raw: 'textContent 正文' }]) {
    const page = fixture({ ...history, assistants: [{ key: 'current:assistant', order: 3, ...spec }] });
    const r = await collectReply(page, options);
    assert.equal(r.text, spec.markdown || spec.raw);
  }
});

test('旧调用方未传归属时保留整页尾部兼容回退', async () => {
  const page = fixture({ body: 'ChatGPT said: 旧脚本正文\nChatGPT can make mistakes' });
  assert.equal((await collectReply(page, { ...options, replyTo: null })).text, '旧脚本正文');
});

test('Cloudflare challenge 不作为正常回复返回', async () => {
  const page = fixture({
    ...history,
    assistants: [{ key: 'current:assistant', order: 3, text: 'cloudflare_challenge' }],
  });
  await assert.rejects(collectReply(page, options), /浏览器检查未通过/);
});

test('缺少本轮用户标识和无效等待参数会在求值前报错', async () => {
  assert.throws(() => replySnapshotExpression({}), /消息标识/);
  await assert.rejects(collectReply({}, { stableIterations: 0 }), /参数无效/);
});
