// Local-only persistence and mutual exclusion, with no runtime state in the skill.
// A TCP listener is the mutex: the OS owns exclusive bind and releases it on
// process exit, including SIGKILL. We never inspect PIDs or delete stale locks.
// Bind only 127.0.0.1; do not set reusePort. Hash collisions/foreign listeners
// cause extra serialization or a timeout, never concurrent ownership.
// Browser and data ports occupy separate ranges to avoid nested-lock collisions.
// This does not coordinate hosts sharing a network/synced data directory.
import { createServer } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { mkdir, readFile, open, rename, rm, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const activeNamespaces = new Set();
const dataQueues = new Map();
const dataLockContext = new AsyncLocalStorage();

export function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ioError(operation, error) {
  return storageError('STORAGE_IO', `Storage ${operation} failed (${error.code || 'UNKNOWN'}).`);
}

/** Pure path selection; optional arguments make platform behavior testable. */
export function getDataDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.CHATGPT_WEB_DATA_DIR) return resolve(env.CHATGPT_WEB_DATA_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'chatgpt-web');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'chatgpt-web');
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share'), 'chatgpt-web');
}

export function mutexPort(namespace) {
  const hash = createHash('sha256').update(namespace).digest().readUInt32BE(0);
  // Keep data mutexes below the default Windows dynamic-port range. Never probe
  // past a denied/occupied port: every contender must use the same single port.
  return namespace.startsWith('chatgpt-web:browser:') ? 40000 + hash % 1000 : 42000 + hash % 7000;
}

function tryListen(port) {
  return new Promise((resolveListen, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      server.unref();
      resolveListen(server);
    });
  });
}

/** Kernel-owned mutex. Same-process reentry is an error, never a bypass. */
export async function acquireMutex(namespace, { timeoutMs = 30000, pollMs = 25 } = {}) {
  if (typeof namespace !== 'string' || !namespace || !Number.isFinite(timeoutMs) || timeoutMs < 0
      || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw storageError('LOCK_INVALID', 'Invalid mutex options.');
  }
  const port = mutexPort(namespace);
  const started = performance.now();
  for (;;) {
    if (activeNamespaces.has(namespace)) throw storageError('LOCK_REENTRANT', 'This process already holds the requested mutex.');
    try {
      const server = await tryListen(port);
      activeNamespaces.add(namespace);
      let releasing;
      return () => {
        releasing ??= new Promise((resolveClose, rejectClose) => server.close(error => {
          activeNamespaces.delete(namespace);
          if (error) rejectClose(storageError('LOCK_RELEASE', 'Could not close mutex listener.'));
          else resolveClose();
        }));
        return releasing;
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw storageError('LOCK_UNAVAILABLE', `Cannot bind local mutex (${error.code || 'UNKNOWN'}).`);
    }
    if (performance.now() - started >= timeoutMs) {
      throw storageError('LOCK_TIMEOUT', `Local mutex is busy at 127.0.0.1:${port}; no lock was removed.`);
    }
    await delay(Math.min(pollMs, Math.max(1, timeoutMs - (performance.now() - started))));
  }
}

/** Data operations never acquire a browser lock; same-process calls queue. */
export async function withDataLock(fn) {
  const path = getDataDir();
  let canonical;
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    canonical = await realpath(path);
  } catch (error) {
    throw ioError('directory access', error);
  }
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const namespace = `chatgpt-web:data:v1:${canonical}`;
  const inherited = dataLockContext.getStore() || [];
  if (inherited.includes(namespace)) throw storageError('LOCK_REENTRANT', 'Nested data operation would deadlock the requested mutex.');
  const previous = dataQueues.get(namespace) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const release = await acquireMutex(namespace);
    try { return await dataLockContext.run([...inherited, namespace], () => fn(path)); } finally { await release(); }
  });
  dataQueues.set(namespace, operation);
  try { return await operation; } finally {
    if (dataQueues.get(namespace) === operation) dataQueues.delete(namespace);
  }
}

/** Only ENOENT means absent; malformed content and access failures are errors. */
export async function readJsonFile(path, fallback) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return fallback();
    throw ioError('read', error);
  }
  try { return JSON.parse(raw); } catch {
    throw storageError('STORAGE_INVALID', 'Stored JSON is malformed; preserve and repair it before continuing.');
  }
}

/** Hold withDataLock. Same-directory rename never removes the old destination
 * first. File fsync is not a promise of power-loss durability on every filesystem.
 * A failed/unsupported rename is an error, not a fallback to truncating writes.
 */
export async function writeJsonAtomic(path, value) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    throw ioError('replace', error);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Serialized, fsynced JSONL append. Caller validates existing content first. */
export async function appendLedger(path, line) {
  let handle;
  try {
    handle = await open(path, 'a', 0o600);
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } catch (error) { throw ioError('append', error); }
  finally { if (handle) await handle.close().catch(() => {}); }
}

export async function readTextFile(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw ioError('read', error);
  }
}
