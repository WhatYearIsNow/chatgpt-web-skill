import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { acquireMutex, getDataDir, mutexPort, writeJsonAtomic, withDataLock } from '../lib/storage.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';
import * as quota from '../lib/quota.mjs';

const storageUrl = new URL('../lib/storage.mjs', import.meta.url).href;
const quotaUrl = new URL('../lib/quota.mjs', import.meta.url).href;
const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;

async function fixture(t) {
  const temporaryBase = resolve(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir());
  let directory;
  // Test resources need usable ports before exercising quota/alias assertions.
  // A fresh directory is a new test namespace, never an alternate production lock.
  for (let attempt = 0; attempt < 24; attempt++) {
    directory = await mkdtemp(join(temporaryBase, 'chatgpt-web-storage-test-'));
    let canonical = await realpath(directory);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    try {
      for (const namespace of [
        `chatgpt-web:data:v1:${canonical}`,
        ...['counter', 'death', 'foreign'].map((kind) => `test:${kind}:${directory}`),
      ]) {
        const release = await acquireMutex(namespace, { timeoutMs: 0 });
        await release();
      }
      break;
    } catch (error) {
      assert.equal(resolve(dirname(directory)), temporaryBase);
      await rm(directory, { recursive: true, force: true });
      if (
        process.platform !== 'win32' ||
        error.code !== 'LOCK_UNAVAILABLE' ||
        !error.message.includes('(EACCES)')
      )
        throw error;
      if (attempt === 23)
        throw new Error('Could not allocate a Windows test directory with usable mutex ports', {
          cause: error,
        });
    }
  }
  const previous = process.env.CHATGPT_WEB_DATA_DIR;
  process.env.CHATGPT_WEB_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHATGPT_WEB_DATA_DIR;
    else process.env.CHATGPT_WEB_DATA_DIR = previous;
    assert.equal(resolve(dirname(directory)), temporaryBase);
    assert.ok(directory.includes('chatgpt-web-storage-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function startChild(source, directory) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, CHATGPT_WEB_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const done = new Promise((resolveDone, rejectDone) => {
    child.once('error', rejectDone);
    child.once('close', (code, signal) => resolveDone({ code, signal, stdout, stderr }));
  });
  return { child, done, output: () => stdout };
}

async function runChild(source, directory) {
  const result = await startChild(source, directory).done;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function owner(t, namespace, directory, browser = false) {
  const worker = startChild(
    `
    import { ${browser ? 'acquireLock' : 'acquireMutex'} } from ${JSON.stringify(browser ? lockUrl : storageUrl)};
    await ${browser ? 'acquireLock' : 'acquireMutex'}(${JSON.stringify(namespace)});
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
    directory,
  );
  t.after(async () => {
    worker.child.kill('SIGKILL');
    await worker.done;
  });
  for (let i = 0; !worker.output().includes('ready') && i < 200; i++) await delay(10);
  assert.match(worker.output(), /ready/);
  return worker;
}

test('runtime directories honor overrides and platform conventions', () => {
  const home = resolve('example-home');
  assert.equal(getDataDir({ env: { CHATGPT_WEB_DATA_DIR: './custom' }, home }), resolve('./custom'));
  assert.equal(
    getDataDir({ env: { LOCALAPPDATA: home }, platform: 'win32', home }),
    join(home, 'chatgpt-web'),
  );
  assert.equal(
    getDataDir({ env: {}, platform: 'win32', home }),
    join(home, 'AppData', 'Local', 'chatgpt-web'),
  );
  assert.equal(
    getDataDir({ env: {}, platform: 'darwin', home }),
    join(home, 'Library', 'Application Support', 'chatgpt-web'),
  );
  assert.equal(
    getDataDir({ env: { XDG_DATA_HOME: home }, platform: 'linux', home }),
    join(home, 'chatgpt-web'),
  );
  assert.equal(
    getDataDir({ env: { XDG_DATA_HOME: 'relative' }, platform: 'linux', home }),
    join(home, '.local', 'share', 'chatgpt-web'),
  );
});
test('data mutex ports stay outside the default Windows dynamic-port range', () => {
  for (let i = 0; i < 1000; i++) {
    const port = mutexPort(`chatgpt-web:data:v1:fixture-${i}`);
    assert.ok(port >= 42000 && port < 49000);
  }
});

test('mutex excludes real processes across repeated critical sections', { timeout: 20000 }, async (t) => {
  const directory = await fixture(t);
  const namespace = `test:counter:${directory}`;
  const counter = join(directory, 'counter');
  await writeFile(counter, '0');
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      runChild(
        `
    import { acquireMutex } from ${JSON.stringify(storageUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    for (let i = 0; i < 5; i++) {
      const release = await acquireMutex(${JSON.stringify(namespace)}, { pollMs: 2 });
      const value = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
      await delay(3);
      await writeFile(${JSON.stringify(counter)}, String(value + 1));
      await release();
    }
    console.log('ok');
  `,
        directory,
      ),
    ),
  );
  assert.equal(results.length, 8);
  assert.equal(await readFile(counter, 'utf8'), '40');
});

test('dead owner recovers without files, including concurrent contenders', { timeout: 15000 }, async (t) => {
  const directory = await fixture(t);
  const namespace = `test:death:${directory}`;
  const worker = await owner(t, namespace, directory);
  await assert.rejects(acquireMutex(namespace, { timeoutMs: 50, pollMs: 5 }), { code: 'LOCK_TIMEOUT' });
  worker.child.kill('SIGKILL');
  await worker.done;
  const marker = join(directory, 'inside');
  await Promise.all(
    Array.from({ length: 6 }, () =>
      runChild(
        `
    import { acquireMutex } from ${JSON.stringify(storageUrl)};
    import { open, rm } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const release = await acquireMutex(${JSON.stringify(namespace)}, { pollMs: 2 });
    const file = await open(${JSON.stringify(marker)}, 'wx');
    await delay(10);
    await file.close();
    await rm(${JSON.stringify(marker)});
    await release();
  `,
        directory,
      ),
    ),
  );
  assert.deepEqual(await readdir(directory), []);
});

test(
  'live ownership cannot be stolen by clock jumps or another process release',
  { timeout: 10000 },
  async (t) => {
    const directory = await fixture(t);
    await owner(t, 'test browser', directory, true);
    const result = await runChild(
      `
    import { acquireLock, releaseLock } from ${JSON.stringify(lockUrl)};
    Date.now = () => 9000000000000;
    await releaseLock();
    try {
      await acquireLock('contender', { timeoutMs: 70, pollMs: 5 });
      throw new Error('double ownership');
    } catch (error) { if (error.code !== 'LOCK_TIMEOUT') throw error; }
    console.log('blocked');
  `,
      directory,
    );
    assert.equal(result, 'blocked');
  },
);

test('release is idempotent and old closures cannot release a later owner', async (t) => {
  await fixture(t);
  const first = await acquireLock('first', { timeoutMs: 500 });
  await assert.rejects(acquireLock('nested'), { code: 'LOCK_REENTRANT' });
  await first();
  const second = await acquireLock('second');
  t.after(second);
  await first();
  await assert.rejects(acquireLock('still held'), { code: 'LOCK_REENTRANT' });
  await releaseLock();
  const third = await acquireLock('third');
  await third();
  await third();
});

test('foreign listener/hash collision fails closed and does not close its owner', async (t) => {
  const directory = await fixture(t);
  const namespace = `test:foreign:${directory}`;
  const server = createServer((socket) => socket.destroy());
  server.listen({ host: '127.0.0.1', port: mutexPort(namespace), exclusive: true });
  await once(server, 'listening');
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  await assert.rejects(acquireMutex(namespace, { timeoutMs: 30, pollMs: 2 }), { code: 'LOCK_TIMEOUT' });
  assert.equal(server.listening, true);
});

test(
  'quota read-modify-write preserves concurrent updates and ledger records',
  { timeout: 25000 },
  async (t) => {
    const directory = await fixture(t);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runChild(
          `
    import { markExhausted, record } from ${JSON.stringify(quotaUrl)};
    await markExhausted('fixture-account-${index}', 'limit');
    await record({ kind: 'image', account: 'fixture-account-${index}', outcome: 'ok' });
  `,
          directory,
        ),
      ),
    );
    const state = JSON.parse(await readFile(join(directory, 'quota-state.json'), 'utf8'));
    assert.equal(Object.keys(state.accounts).length, 12);
    assert.equal((await quota.readAll()).length, 12);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.tmp')).length, 0);
    await Promise.all(Array.from({ length: 12 }, (_, index) => quota.markOk(`parallel-${index}`)));
    const final = JSON.parse(await readFile(join(directory, 'quota-state.json'), 'utf8'));
    assert.equal(Object.keys(final.accounts).length, 24);
  },
);

test('corrupt JSON and invalid schemas fail closed and are preserved', async (t) => {
  const directory = await fixture(t);
  const file = join(directory, 'quota-state.json');
  for (const raw of [
    '{',
    '{}',
    'null',
    '{"accounts":[]}',
    '{"accounts":{"fixture":{"resets_at":"not-a-date"}}}',
    '{"accounts":{"fixture":{"aliases":[12]}}}',
  ]) {
    await writeFile(file, raw);
    await assert.rejects(quota.checkUsable('fixture'), { code: 'STORAGE_INVALID' });
    await assert.rejects(quota.markOk('fixture'), { code: 'STORAGE_INVALID' });
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('I/O failures are errors, not an empty quota or ledger', async (t) => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'quota-state.json'));
  await assert.rejects(quota.checkUsable('fixture'), { code: 'STORAGE_IO' });
  await mkdir(join(directory, 'usage.jsonl'));
  await assert.rejects(quota.readAll(), { code: 'STORAGE_IO' });
  await assert.rejects(quota.record({ kind: 'ask', outcome: 'ok' }), { code: 'STORAGE_IO' });
});

test('corrupt ledger blocks reading and appending without discarding evidence', async (t) => {
  const directory = await fixture(t);
  const file = join(directory, 'usage.jsonl');
  const raw = '{"kind":"image","outcome":"ok","ts":"2026-01-01T00:00:00Z"}\n{"half":';
  await writeFile(file, raw);
  await assert.rejects(quota.readAll(), { code: 'STORAGE_INVALID' });
  await assert.rejects(quota.record({ kind: 'image', outcome: 'ok' }), { code: 'STORAGE_INVALID' });
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('failed atomic replacement preserves the destination and cleans its own temp file', async (t) => {
  const directory = await fixture(t);
  const destination = join(directory, 'existing-directory');
  await mkdir(destination);
  await writeFile(join(destination, 'evidence'), 'keep');
  await assert.rejects(writeJsonAtomic(destination, { fixture: true }), { code: 'STORAGE_IO' });
  assert.equal(await readFile(join(destination, 'evidence'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(directory), ['existing-directory']);
});

test('ambiguous fragment and duplicate exact alias fail closed', async (t) => {
  const directory = await fixture(t);
  const state = {
    accounts: {
      'fixture-alpha': { aliases: ['shared'], exhausted_at: null },
      'fixture-beta': {
        aliases: ['shared'],
        exhausted_at: '2026-01-01T00:00:00Z',
        resets_at: '2099-01-01T00:00:00Z',
      },
    },
  };
  await writeFile(join(directory, 'quota-state.json'), JSON.stringify(state));
  await assert.rejects(quota.checkUsableByAlias('fixture'), { code: 'QUOTA_ALIAS_AMBIGUOUS' });
  await assert.rejects(quota.checkUsable('shared'), { code: 'QUOTA_ALIAS_AMBIGUOUS' });
  await assert.rejects(quota.markOk('shared'), { code: 'QUOTA_ALIAS_AMBIGUOUS' });
  assert.equal((await quota.checkUsable('fixture-beta')).ok, false);
});

test('quota expiry, aliases, episode preservation, and prototype-like display names', async (t) => {
  const directory = await fixture(t);
  const now = Date.parse('2026-10-23T00:00:00Z');
  const first = await quota.markExhausted('fixture', 'tomorrow at 12:36 PM', now);
  const repeated = await quota.markExhausted('FIXTURE', 'disabled', now + 1000);
  assert.equal(repeated.resets_at, first.resets_at);
  assert.equal((await quota.checkUsableByAlias('ixT', now)).ok, false);
  assert.equal((await quota.checkUsable('fixture', Date.parse(first.resets_at))).ok, true);
  await quota.markOk('FIXTURE', now + 2000);
  assert.equal((await quota.checkUsable('fixture', now)).ok, true);
  await quota.markExhausted('__proto__', 'limit', now);
  const state = JSON.parse(await readFile(join(directory, 'quota-state.json'), 'utf8'));
  assert.equal(Object.keys(state.accounts).length, 2);
  assert.equal((await quota.checkUsable('__proto__', now)).ok, false);
});

test('local calendar boundaries and dry-run outcomes do not inflate image counts', async (t) => {
  const directory = await fixture(t);
  const events = [
    { ts: '2026-10-22T15:59:59Z', kind: 'image', outcome: 'ok', account: 'fixture' },
    { ts: '2026-10-22T16:00:01Z', kind: 'image', outcome: 'ok', account: 'fixture' },
    { ts: '2026-10-23T15:59:59Z', kind: 'image', outcome: 'dry-run', account: 'fixture' },
    { ts: '2026-10-23T16:00:01Z', kind: 'image', outcome: 'ok', account: 'fixture' },
    { ts: '2026-10-23T12:00:00Z', kind: 'image', outcome: 'fail', account: 'fixture' },
    { ts: '2026-10-23T12:00:00Z', kind: 'image', outcome: 'ok', account: 'second' },
  ];
  await writeFile(
    join(directory, 'usage.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const options = { now: Date.parse('2026-10-23T06:00:00Z'), timeZone: 'Asia/Shanghai' };
  assert.equal(await quota.todayImages('fixture', options), 1);
  assert.equal(await quota.todayImages(null, options), 2);
  await quota.record({ kind: 'image', outcome: 'dry-run', account: 'fixture' });
  assert.equal(await quota.todayImages('fixture', options), 1);
  assert.equal((await quota.tail(1))[0].outcome, 'dry-run');
  assert.deepEqual(await quota.tail(0), []);
});

test('reset phrases validate AM/PM hours and minutes and preserve local midnight/noon', () => {
  const now = new Date(2026, 9, 23, 18, 0).getTime();
  assert.equal(new Date(quota.parseResetAt('tomorrow at 12:36 PM', now)).getHours(), 12);
  assert.equal(new Date(quota.parseResetAt('tomorrow at 12:36 AM', now)).getHours(), 0);
  assert.equal(new Date(quota.parseResetAt('tomorrow at 1:36 PM', now)).getDate(), 24);
  for (const message of ['tomorrow at 13:36 PM', 'tomorrow at 0:36 AM', 'tomorrow at 12:77 PM', 'unknown']) {
    assert.equal(quota.parseResetAt(message, now), now + 86400000);
  }
});

test('missing ledger delimiter is not silently merged with the next record', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'usage.jsonl');
  const raw = JSON.stringify({ kind: 'image', outcome: 'ok', ts: '2026-01-01T00:00:00Z' });
  await writeFile(path, raw);
  await assert.rejects(quota.record({ kind: 'ask', outcome: 'ok' }), { code: 'STORAGE_INVALID' });
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('stored metadata cannot redirect a matched account update', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'quota-state.json');
  await writeFile(path, JSON.stringify({ accounts: { fixture: { key: 'other', aliases: ['alias'] } } }));
  await quota.markOk('alias');
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(state.accounts), ['fixture']);
  assert.ok(state.accounts.fixture.last_ok_at);
});

test('nested data operations reject explicitly while independent calls queue', async (t) => {
  await fixture(t);
  await assert.rejects(
    withDataLock(() => quota.markOk('nested')),
    { code: 'LOCK_REENTRANT' },
  );
  await Promise.all([quota.markOk('first'), quota.markOk('second')]);
  assert.equal((await quota.checkUsable('first')).ok, true);
});

test('legacy exhaustion without an explicit reset keeps its fallback episode', async (t) => {
  const directory = await fixture(t);
  const now = Date.parse('2026-10-23T00:00:00Z');
  const initial = { accounts: { fixture: { exhausted_at: new Date(now).toISOString() } } };
  const file = join(directory, 'quota-state.json');
  await writeFile(file, JSON.stringify(initial));
  await quota.markExhausted('fixture', 'disabled', now + 3600000);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), initial);
  assert.equal((await quota.checkUsable('fixture', now + 86400000)).ok, true);
});
