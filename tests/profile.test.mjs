import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { withProfileGuard } from '../lib/browser.mjs';

const expected = resolve('synthetic-user-data', 'Profile 4');
function fixture(actual = expected) {
  const calls = [];
  const client = {
    async createTarget(url) {
      calls.push(['create', url]);
      return 'owned';
    },
    async evaluate(targetId) {
      calls.push(['observe', targetId]);
      return actual;
    },
    async session(targetId) {
      return `session:${targetId}`;
    },
    async call(method, params, sid) {
      calls.push([method, params, sid]);
      if (method === 'Target.closeTarget') return { success: true };
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'user-tab' }] };
      return {};
    },
    close() {
      calls.push(['disconnect']);
    },
  };
  return { calls, client, guarded: withProfileGuard(client, expected) };
}

test('profile guard verifies every newly created tab before navigating the same tab', async () => {
  const { calls, guarded } = fixture();
  for (const url of ['https://chatgpt.com/', 'about:blank'])
    assert.equal(await guarded.createTarget(url), 'owned');
  assert.deepEqual(calls, [
    ['create', 'chrome://version/'],
    ['observe', 'owned'],
    ['Page.navigate', { url: 'https://chatgpt.com/' }, 'session:owned'],
    ['create', 'chrome://version/'],
    ['observe', 'owned'],
    ['Page.navigate', { url: 'about:blank' }, 'session:owned'],
  ]);
  guarded.close();
  assert.deepEqual(calls.at(-1), ['disconnect']);
});

test('wrong or unreadable profiles stop before site navigation and close only the owned tab', async () => {
  for (const [actual, code] of [
    [join(expected, 'other'), 'PROFILE_MISMATCH'],
    ['not-absolute', 'PROFILE_UNVERIFIED'],
  ]) {
    const { calls, guarded } = fixture(actual);
    await assert.rejects(guarded.createTarget('https://chatgpt.com/'), { code });
    assert.equal(
      calls.some(([method]) => method === 'Page.navigate'),
      false,
    );
    assert.deepEqual(
      calls.find(([method]) => method === 'Target.closeTarget'),
      ['Target.closeTarget', { targetId: 'owned' }, null],
    );
  }
  const { calls, client, guarded } = fixture();
  client.evaluate = async () => {
    throw new Error('internal page unavailable');
  };
  await assert.rejects(guarded.createTarget('https://chatgpt.com/'), { code: 'PROFILE_UNVERIFIED' });
  assert.equal(
    calls.some(([method]) => method === 'Page.navigate'),
    false,
  );
});

test('a later tab in a different profile is rejected instead of trusting the first probe', async () => {
  const { client, guarded } = fixture();
  await guarded.createTarget('about:blank');
  client.evaluate = async () => join(expected, 'different');
  await assert.rejects(guarded.createTarget('https://chatgpt.com/'), { code: 'PROFILE_MISMATCH' });
});

test('navigation failure cleans up the verified tab; no pin preserves the original client', async () => {
  const { client, calls, guarded } = fixture();
  const original = client.call.bind(client);
  client.call = async (...args) =>
    args[0] === 'Page.navigate' ? { errorText: 'ERR_FAILED' } : original(...args);
  await assert.rejects(guarded.createTarget('https://chatgpt.com/'), { code: 'ERR_CDP_NAVIGATION' });
  assert.ok(calls.some(([method]) => method === 'Target.closeTarget'));
  assert.equal(withProfileGuard(client), client);
});
