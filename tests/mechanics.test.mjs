import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SEL } from '../lib/selectors.mjs';
import { sendAndConfirm, activatePage } from '../lib/chatgpt.mjs';
async function mechanics() {
  return { sendAndConfirm, activatePage };
}

function sendPage({ addUser = true, failBaseline = false } = {}) {
  const keys = ['history:user'];
  let clicks = 0;
  const button = {
    disabled: false,
    click() {
      clicks++;
      if (addUser) keys.push('new:user');
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === SEL.send) return button;
      if (selector.startsWith('textarea')) return { value: '' };
      return null;
    },
    querySelectorAll: () => keys.map((key) => ({ getAttribute: () => key })),
  };
  const page = {
    evaluate: async (expr) => {
      if (failBaseline && expr.includes('.map(')) throw new Error('基线读取失败');
      return vm.runInNewContext(expr, { document });
    },
  };
  return { page, clicks: () => clicks };
}

test('确认发送返回新增用户消息标识，而非无归属的成功布尔值', async () => {
  const { sendAndConfirm } = await mechanics();
  const h = sendPage();
  const replyTo = await sendAndConfirm(h.page, { confirmTimeoutMs: 20 });
  assert.equal(replyTo.userKey, 'new:user');
  assert.equal(h.clicks(), 1);
});

test('输入框清空也不能替代新增消息证据，状态不明时不重复点击', async () => {
  const { sendAndConfirm } = await mechanics();
  const h = sendPage({ addUser: false });
  await assert.rejects(
    sendAndConfirm(h.page, { confirmTimeoutMs: 1 }),
    /Inspect the conversation before retrying/,
  );
  assert.equal(h.clicks(), 1);
});

test('基线读取失败时中止，连一次发送也不尝试', async () => {
  const { sendAndConfirm } = await mechanics();
  const h = sendPage({ failBaseline: true });
  await assert.rejects(sendAndConfirm(h.page), /基线读取失败/);
  assert.equal(h.clicks(), 0);
});

test('激活失败会传出错误，避免继续向后台页面填入提示词', async () => {
  const { activatePage } = await mechanics();
  await assert.rejects(
    activatePage(
      {
        call: async () => {
          throw new Error('激活失败');
        },
      },
      'tab',
      'sid',
    ),
    /激活失败/,
  );
});
