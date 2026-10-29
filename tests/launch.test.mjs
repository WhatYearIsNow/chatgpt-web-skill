import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  browserCandidates,
  findBrowserExecutable,
  managedBrowserDir,
  readActiveEndpoint,
  managedLaunchArgs,
  ensureManagedBrowser,
  closeManagedBrowser,
} from '../lib/launch.mjs';

const tempDirectory = async () =>
  mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'launch-test-'));

test('executable discovery covers platforms, honors explicit paths and fails actionably', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const explicit = join(directory, 'chrome.exe');
  await writeFile(explicit, '');
  assert.equal(await findBrowserExecutable({ explicitPath: explicit }), explicit);
  await assert.rejects(findBrowserExecutable({ explicitPath: join(directory, 'missing.exe') }), {
    code: 'ERR_BROWSER_CONFIGURATION',
  });

  assert.ok(
    browserCandidates({ PROGRAMFILES: 'C:\\P', LOCALAPPDATA: 'C:\\L' }, 'win32').some((path) =>
      path.endsWith('chrome.exe'),
    ),
  );
  assert.ok(browserCandidates({}, 'darwin')[0].includes('Google Chrome.app'));
  assert.deepEqual(browserCandidates({}, 'linux'), []);

  const candidate = join(directory, 'chromium');
  await writeFile(candidate, '');
  assert.equal(
    await findBrowserExecutable({ platform: 'win32', candidates: [join(directory, 'absent'), candidate] }),
    candidate,
  );
  assert.equal(
    await findBrowserExecutable({
      platform: 'linux',
      candidates: [],
      which: (name) => (name === 'chromium' ? '/usr/bin/chromium' : ''),
    }),
    '/usr/bin/chromium',
  );
  await assert.rejects(
    findBrowserExecutable({ platform: 'linux', candidates: [], which: () => '' }),
    (error) => error.code === 'ERR_BROWSER_CONFIGURATION' && error.message.includes('CHATGPT_WEB_CHROME'),
  );
});

test('DevToolsActivePort parsing yields a ws endpoint or null', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readActiveEndpoint(directory), null);
  await writeFile(join(directory, 'DevToolsActivePort'), '9333\n/devtools/browser/guid\n');
  assert.equal(await readActiveEndpoint(directory), 'ws://127.0.0.1:9333/devtools/browser/guid');
  await writeFile(join(directory, 'DevToolsActivePort'), '');
  assert.equal(await readActiveEndpoint(directory), null);
  await writeFile(join(directory, 'DevToolsActivePort'), 'not-a-port\n');
  assert.equal(await readActiveEndpoint(directory), null);
  assert.equal(managedBrowserDir(directory), join(directory, 'browser'));
});

test('managed launch args isolate the profile and bind loopback with an ephemeral port', () => {
  const args = managedLaunchArgs({ profileDir: join('d', 'browser'), headless: true });
  assert.ok(args.includes('--user-data-dir=' + join('d', 'browser')));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--headless=new'));
  assert.ok(!managedLaunchArgs({ profileDir: 'd' }).includes('--headless=new'));
});

const fakeChild = (t, script = () => {}) => {
  const child = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  t.after(() => child.removeAllListeners());
  script(child);
  return child;
};

test('a live managed browser is reused without launching', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dir = managedBrowserDir(directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/live');
  const sentinel = { close() {} };
  let spawns = 0;
  const result = await ensureManagedBrowser({
    dataDir: directory,
    timeoutMs: 1000,
    connect: async (endpoint) => {
      assert.equal(endpoint, 'ws://127.0.0.1:9333/devtools/browser/live');
      return sentinel;
    },
    spawn: () => {
      spawns++;
      return fakeChild(t);
    },
  });
  assert.equal(result.reused, true);
  assert.equal(result.client, sentinel);
  assert.equal(spawns, 0);
});

test('a stale port file launches fresh: spawn, poll, connect, record connection.json', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dir = managedBrowserDir(directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/stale');
  const executable = join(directory, 'chrome.exe');
  await writeFile(executable, '');
  const sentinel = { close() {} };
  const child = fakeChild(t);
  const result = await ensureManagedBrowser({
    dataDir: directory,
    executable,
    timeoutMs: 3000,
    connect: async (endpoint) => {
      if (endpoint.startsWith('ws://127.0.0.1:9333')) throw new Error('stale endpoint is dead');
      assert.equal(endpoint, 'ws://127.0.0.1:9334/devtools/browser/fresh');
      return sentinel;
    },
    spawn: (exe, args) => {
      assert.equal(exe, executable);
      assert.ok(args.some((a) => a.startsWith('--user-data-dir=')));
      setTimeout(() => {
        writeFile(join(dir, 'DevToolsActivePort'), '9334\n/devtools/browser/fresh');
      }, 20);
      return child;
    },
  });
  assert.equal(result.reused, false);
  assert.equal(result.client, sentinel);
  const record = JSON.parse(await readFile(join(directory, 'browser-connection.json'), 'utf8'));
  assert.equal(record.endpoint, 'ws://127.0.0.1:9334/devtools/browser/fresh');
  assert.equal(record.pid, 4242);
});

test('launch failures surface spawn errors, early exits and timeouts as ERR_BROWSER_LAUNCH', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'chrome.exe');
  await writeFile(executable, '');

  await assert.rejects(
    ensureManagedBrowser({
      dataDir: directory,
      executable,
      timeoutMs: 500,
      connect: async () => {
        throw new Error('never');
      },
      spawn: () =>
        fakeChild(t, (child) =>
          process.nextTick(() =>
            child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
          ),
        ),
    }),
    (error) => error.code === 'ERR_BROWSER_LAUNCH' && error.message.includes('spawn ENOENT'),
  );

  await assert.rejects(
    ensureManagedBrowser({
      dataDir: join(directory, 'b'),
      executable,
      timeoutMs: 500,
      connect: async () => {
        throw new Error('never');
      },
      spawn: () => fakeChild(t, (child) => setTimeout(() => child.emit('exit', 1), 10)),
    }),
    (error) => error.code === 'ERR_BROWSER_LAUNCH' && error.message.includes('exited during startup'),
  );

  await assert.rejects(
    ensureManagedBrowser({
      dataDir: join(directory, 'c'),
      executable,
      timeoutMs: 120,
      connect: async () => {
        throw new Error('never');
      },
      spawn: () => fakeChild(t),
    }),
    (error) => error.code === 'ERR_BROWSER_LAUNCH' && error.message.includes('did not become connectable'),
  );
});

test('closeManagedBrowser confirms shutdown through the port file, not the command response', async (t) => {
  const directory = await tempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dir = managedBrowserDir(directory);
  await mkdir(dir, { recursive: true });
  const portFile = join(dir, 'DevToolsActivePort');

  assert.deepEqual(
    await closeManagedBrowser({
      dataDir: directory,
      connect: async () => {
        throw new Error('unused');
      },
    }),
    { stopped: false, endpoint: null, reason: 'not-running' },
  );

  await writeFile(portFile, '9333\n/devtools/browser/x');
  assert.deepEqual(
    await closeManagedBrowser({
      dataDir: directory,
      connect: async () => {
        throw new Error('dead');
      },
    }),
    { stopped: false, endpoint: 'ws://127.0.0.1:9333/devtools/browser/x', reason: 'not-reachable' },
  );

  await writeFile(portFile, '9333\n/devtools/browser/x');
  const closed = await closeManagedBrowser({
    dataDir: directory,
    waitMs: 2000,
    connect: async () => ({
      call: async (method) => {
        assert.equal(method, 'Browser.close');
        await rm(dir, { recursive: true, force: true });
      },
      close() {},
    }),
  });
  assert.deepEqual(closed, {
    stopped: true,
    endpoint: 'ws://127.0.0.1:9333/devtools/browser/x',
    portFileRemoved: true,
  });

  // Some platforms leave the port file behind after the process exits; the
  // endpoint refusing connections is the shutdown signal instead.
  await mkdir(dir, { recursive: true });
  await writeFile(portFile, '9333\n/devtools/browser/x');
  let connections = 0;
  const exited = await closeManagedBrowser({
    dataDir: directory,
    waitMs: 2000,
    connect: async () => {
      if (++connections === 1) return { call: async () => {}, close() {} };
      throw new Error('refused after close');
    },
  });
  assert.deepEqual(exited, {
    stopped: true,
    endpoint: 'ws://127.0.0.1:9333/devtools/browser/x',
    portFileRemoved: false,
  });

  await mkdir(dir, { recursive: true });
  await writeFile(portFile, '9333\n/devtools/browser/x');
  const stubborn = await closeManagedBrowser({
    dataDir: directory,
    waitMs: 200,
    connect: async () => ({ call: async () => {}, close() {} }),
  });
  assert.equal(stubborn.stopped, false);
  assert.equal(stubborn.reason, 'still-running');
});
