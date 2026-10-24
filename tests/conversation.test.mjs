import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationUrl, positiveTimeout, assertIdleComposer } from '../lib/conversation.mjs';
import { fixture } from './helpers.mjs';

test('会话地址去除查询参数、锚点与尾斜杠', () => {
  assert.equal(conversationUrl('https://chatgpt.com/c/abc-123/?x=1#fragment'), 'https://chatgpt.com/c/abc-123');
});
test('会话ID视为单一不透明片段，保留合法冒号编码而拒绝编码分隔符', () => {
  assert.equal(conversationUrl('https://chatgpt.com/c/local-chatgpt%3Aexample-id'), 'https://chatgpt.com/c/local-chatgpt%3Aexample-id');
  for (const id of ['a%2fb', 'a%5cb', 'a%0ab', 'a%3fb', '%ZZ'])
    assert.throws(() => conversationUrl(`https://chatgpt.com/c/${id}`));
});

test('拒绝非本站、伪造主机、其他路径与嵌套会话地址', () => {
  const withCredentials = new URL('https://chatgpt.com/c/id');
  withCredentials.username = 'user';
  for (const url of [undefined, '', 'https://chatgpt.com.evil/c/id', 'http://chatgpt.com/c/id',
    'https://chatgpt.com@example.invalid/c/id', withCredentials.href,
    'https://chatgpt.com:444/c/id', 'https://chatgpt.com/c/', 'https://chatgpt.com/c/id/other',
    'https://chatgpt.com/c/id%2Fother', 'https://chatgpt.com/g/123'])
    assert.throws(() => conversationUrl(url));
});

test('超时参数必须是有限正数，允许小数秒', () => {
  assert.equal(positiveTimeout(undefined), 900000);
  assert.equal(positiveTimeout('0.5'), 500);
  for (const timeout of ['NaN', 'Infinity', '-1', '0', '', '2147484'])
    assert.throws(() => positiveTimeout(timeout), /timeout/);
});

test('空闲 composer 通过；已有草稿、附件、正在生成分别拒绝', async () => {
  await assertIdleComposer(fixture());
  for (const state of [{ draft: '用户草稿' }, { attachment: true }, { stop: true }])
    await assert.rejects(assertIdleComposer(fixture(state)), /已中止/);
});

test('探测失败不会被当作没有草稿', async () => {
  await assert.rejects(assertIdleComposer({ evaluate: async () => { throw new Error('断连'); } }), /断连/);
});
