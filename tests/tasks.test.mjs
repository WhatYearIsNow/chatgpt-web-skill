import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask } from '../lib/tasks.mjs';
import { QuotaError } from '../lib/chatgpt.mjs';
import { TaskError } from '../lib/errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cursor = { userKey: 'test:user' };
function setup(overrides = {}) {
  const events = [],
    records = [];
  let attached = false;
  const cdp = () => ({
    closed: false,
    session: async () => 'session',
    createTarget: async () => {
      events.push('create');
      return 'owned-target';
    },
    call: async (method, params) => {
      if (method === 'Target.closeTarget') {
        assert.equal(params.targetId, 'owned-target');
        events.push('close-tab');
      }
    },
    close() {
      this.closed = true;
      events.push('disconnect');
    },
  });
  const d = {
    acquireLock: async () => {
      events.push('lock');
      return async () => events.push('release');
    },
    connectWithApproval: async () => cdp(),
    Page: class {},
    activatePage: async () => {},
    ensureNetworkAndLogin: async () => true,
    waitComposerReady: async () => {},
    assertIdleComposer: async () => {},
    readAccount: async () => 'Example',
    checkAccount() {},
    attachFiles: async () => {
      attached = true;
      events.push('attach');
    },
    fillPrompt: async () => {
      events.push('fill');
    },
    setThinking: async () => {},
    sendAndConfirm: async () => {
      events.push('send');
      return cursor;
    },
    waitConvUrl: async () => {},
    currentUrl: async () => 'https://chatgpt.com/c/test',
    waitTurnComplete: async (_p, _ms, opts) => assert.equal(opts.replyTo, cursor),
    collectReply: async (_p, opts) => {
      assert.equal(opts.replyTo, cursor);
      return { text: 'New reply' };
    },
    attach: async () => ({ cdp: cdp(), page: {}, sid: 'sid' }),
    waitAndSaveImage: async (_p, out, _ms, opts) => {
      assert.equal(opts.replyTo, cursor);
      events.push(['save-image', out, attached]);
    },
    closeTab: async () => events.push('fallback-close'),
    checkUsable: async () => ({ ok: true }),
    markOk: async () => {},
    markExhausted: async () => {},
    mkdir: async () => {},
    writeFile: async () => events.push('write'),
    record: async (e) => records.push(e),
    log() {},
    switchAccount: async () => ({ email: 'example@example.invalid', changed: true, verified: true }),
    ...overrides,
  };
  const options = {
    command: 'ask',
    prompt: 'Test',
    timeoutMs: 100,
    lockTimeoutMs: 100,
    dryRun: false,
    candidates: 1,
    out: null,
  };
  return { d, events, records, options };
}

test('all text commands correlate the reply, close only their own target and release the lock', async () => {
  for (const command of ['ask', 'review', 'followup']) {
    const h = setup();
    const result = await runTask(
      {
        ...h.options,
        command,
        url: command === 'followup' ? 'https://chatgpt.com/c/test' : undefined,
        zip: 'test.zip',
      },
      h.d,
    );
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.deepEqual(
      h.events.filter((e) => ['send', 'close-tab', 'release'].includes(e)),
      ['send', 'close-tab', 'release'],
    );
    assert.equal(h.records.at(-1).outcome, 'ok');
  }
});
test('direct service callers cannot bypass essential validation or silently run zero image candidates', async () => {
  for (const input of [
    { command: 'image', candidates: 0, out: 'x.png', prompt: 'test' },
    { command: 'image', candidates: NaN, out: 'x.png', prompt: 'test' },
    { command: 'other' },
    { command: 'ask', prompt: '' },
    { command: 'ask', prompt: 'x', timeoutMs: -1 },
  ]) {
    const h = setup();
    await assert.rejects(runTask(input, h.d), { code: 'USAGE' });
    assert.equal(h.events.length, 0);
  }
});

test('a login page fails fast with LOGIN_REQUIRED before any composer wait', async () => {
  const h = setup({
    ensureNetworkAndLogin: async () => {
      throw new TaskError('LOGIN_REQUIRED', 'not logged in');
    },
  });
  await assert.rejects(runTask(h.options, h.d), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.taskState.stage, 'prepare');
    return true;
  });
  assert.ok(!h.events.includes('send') && !h.events.includes('fill'));
  assert.ok(h.events.includes('close-tab') && h.events.includes('release'));
  assert.equal(h.records.at(-1).outcome, 'fail');
});

test('dry-run can upload an attachment but never sends or writes an output', async () => {
  const h = setup();
  const result = await runTask(
    { ...h.options, command: 'review', dryRun: true, zip: 'test.zip', out: 'result.md' },
    h.d,
  );
  assert.equal(result.sent, false);
  assert.ok(h.events.includes('attach'));
  assert.ok(!h.events.includes('send') && !h.events.includes('write'));
  assert.equal(h.records[0].outcome, 'dry-run');
});

test('existing draft or wrong account stops before upload or fill, with cleanup', async () => {
  for (const method of ['assertIdleComposer', 'checkAccount']) {
    const h = setup({
      [method]: () => {
        throw new Error('blocked');
      },
    });
    await assert.rejects(runTask(h.options, h.d), /blocked/);
    assert.ok(!h.events.includes('send') && !h.events.includes('fill'));
    assert.ok(h.events.includes('close-tab') && h.events.includes('release'));
  }
});
test('a conversation that redirects during account hydration stops before filling or sending', async () => {
  let reads = 0;
  const h = setup({
    currentUrl: async () => (++reads === 1 ? 'https://chatgpt.com/c/test' : 'https://chatgpt.com/'),
  });
  await assert.rejects(
    runTask({ ...h.options, command: 'followup', url: 'https://chatgpt.com/c/test' }, h.d),
    { code: 'CONVERSATION_UNAVAILABLE' },
  );
  assert.ok(!h.events.includes('fill') && !h.events.includes('send'));
});

test('ambiguous send or transport error never retries and reports sent=unknown', async () => {
  let attempts = 0;
  const h = setup({
    sendAndConfirm: async () => {
      attempts++;
      throw new Error('disconnected during click');
    },
  });
  await assert.rejects(runTask(h.options, h.d), (error) => error.taskState.sent === 'unknown');
  assert.equal(attempts, 1);
  assert.ok(h.events.includes('release'));
});
test('completion and collection share the configured reply budget', async () => {
  let completionBudget;
  const h = setup({
    waitTurnComplete: async (_p, ms) => {
      completionBudget = ms;
    },
    collectReply: async (_p, options) => {
      assert.ok(options.waitContentMs > 0 && options.waitContentMs <= completionBudget);
      return { text: 'ok' };
    },
  });
  await runTask(h.options, h.d);
  const expired = setup({
    waitTurnComplete: async () => delay(15),
    collectReply: async () => {
      throw new Error('must not collect with a fresh default budget');
    },
  });
  await assert.rejects(runTask({ ...expired.options, timeoutMs: 5 }, expired.d), { code: 'REPLY_TIMEOUT' });
});
test('fallback tab cleanup failure remains visible in structured warnings', async () => {
  const h = setup({
    attach: async () => {
      throw new Error('reconnect failed');
    },
    closeTab: async () => {
      throw new Error('cleanup failed');
    },
  });
  await assert.rejects(runTask({ ...h.options, command: 'image', out: 'image.png' }, h.d), (error) =>
    error.taskState.warnings.some((warning) => warning.code === 'TAB_CLOSE_FAILED'),
  );
});

test('ledger failure preserves successful remote result as a warning', async () => {
  const h = setup({
    record: async () => {
      throw new Error('disk failure');
    },
  });
  const result = await runTask(h.options, h.d);
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].code, 'LEDGER_WRITE_FAILED');
});
test('browser-local conversation URLs are reported as transient, not promised to reopen', async () => {
  const h = setup({ currentUrl: async () => 'https://chatgpt.com/c/local-chatgpt%3Aexample' });
  const result = await runTask(h.options, h.d);
  assert.ok(result.warnings.some((warning) => warning.code === 'CONVERSATION_TRANSIENT'));
});

test('candidates use distinct non-PNG paths and keep references until send', async () => {
  const h = setup();
  const result = await runTask(
    { ...h.options, command: 'image', candidates: 2, refs: ['reference.jpg'], out: 'image.webp' },
    h.d,
  );
  assert.equal(result.outputs.length, 2);
  const saved = h.events.filter(Array.isArray);
  assert.match(saved[0][1], /image-1\.webp$/);
  assert.match(saved[1][1], /image-2\.webp$/);
  assert.ok(saved.every((row) => row[2]));
});

test('image dry-run prepares one composer even when multiple candidates are planned', async () => {
  const h = setup();
  const result = await runTask(
    { ...h.options, command: 'image', candidates: 3, dryRun: true, out: 'image.png' },
    h.d,
  );
  assert.equal(h.events.filter((e) => e === 'create').length, 1);
  assert.equal(result.plannedCandidates, 3);
  assert.equal(h.records[0].outcome, 'dry-run');
});

test('quota persistence failure after a saved image does not erase success', async () => {
  const h = setup({
    markOk: async () => {
      throw new Error('disk failure');
    },
  });
  const result = await runTask({ ...h.options, command: 'image', out: 'image.png' }, h.d);
  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.warnings[0].code, 'QUOTA_WRITE_FAILED');
});

test('failed reconnect closes the owned target even when the adapter has no closed property', async () => {
  const h = setup({
    connectWithApproval: async () => ({
      createTarget: async () => 'owned-target',
      session: async () => 'sid',
      close() {},
    }),
    attach: async () => {
      throw new Error('reconnect failed');
    },
  });
  await assert.rejects(
    runTask({ ...h.options, command: 'image', out: 'image.png' }, h.d),
    /reconnect failed/,
  );
  assert.ok(h.events.includes('fallback-close') && h.events.includes('release'));
});

test('constructor failure cleans up a target that was already created', async () => {
  const h = setup({
    Page: class {
      constructor() {
        throw new Error('constructor failure');
      }
    },
  });
  await assert.rejects(runTask(h.options, h.d), /constructor failure/);
  assert.ok(h.events.includes('close-tab') && h.events.includes('release'));
});

test('explicit quota denial marks a limit; a disabled upload input does not', async () => {
  for (const error of [new QuotaError('Explicit limit'), new Error('Upload unavailable')]) {
    let marks = 0;
    const h = setup({
      attachFiles: async () => {
        throw error;
      },
      markExhausted: async () => {
        marks++;
      },
    });
    await assert.rejects(
      runTask({ ...h.options, command: 'image', refs: ['ref.png'], out: 'image.png' }, h.d),
    );
    assert.equal(marks, error instanceof QuotaError ? 1 : 0);
  }
});

test('failure on a later candidate reports partial outputs and does not send more candidates', async () => {
  let sends = 0;
  const h = setup({
    sendAndConfirm: async () => {
      if (++sends === 2) throw new Error('failed');
      return cursor;
    },
  });
  await assert.rejects(
    runTask({ ...h.options, command: 'image', candidates: 3, out: 'image.png' }, h.d),
    (error) => error.taskState.outputs.length === 1 && error.taskState.sent === 'unknown',
  );
  assert.equal(sends, 2);
});

test('account dry-run never calls the switching controller', async () => {
  const h = setup({
    switchAccount: async () => {
      throw new Error('must not switch');
    },
  });
  const result = await runTask(
    { ...h.options, command: 'account', dryRun: true, email: 'example@example.invalid', provider: 'google' },
    h.d,
  );
  assert.equal(result.ok, true);
  assert.equal(result.accountChange.applied, false);
});

test('keep-open disconnects and releases the lock without closing its target', async () => {
  const h = setup();
  await runTask({ ...h.options, keepOpen: true }, h.d);
  assert.ok(!h.events.includes('close-tab'));
  assert.ok(h.events.includes('disconnect') && h.events.includes('release'));
});

test('image result uses the final durable URL returned by collection instead of an earlier local URL', async () => {
  const h = setup({
    currentUrl: async () => 'https://chatgpt.com/c/local-chatgpt%3Afixture',
    waitAndSaveImage: async () => 'https://chatgpt.com/c/image-final',
  });
  const result = await runTask({ ...h.options, command: 'image', out: 'image.png' }, h.d);
  assert.equal(result.url, 'https://chatgpt.com/c/image-final');
  assert.equal(result.outputs.length, 1);
  assert.ok(!result.warnings.some((w) => w.code === 'CONVERSATION_TRANSIENT'));
});
