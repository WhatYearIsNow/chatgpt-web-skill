// Browser tasks share one machine-local kernel mutex. Keep this namespace stable
// across releases. Stop legacy script processes before upgrading: legacy TEMP
// JSON locks use a different protocol and are intentionally never touched.
import { acquireMutex } from './storage.mjs';

const BROWSER_NAMESPACE = 'chatgpt-web:browser:v1';
let held = null;

/** Returns an idempotent release closure tied to this exact acquisition. */
export async function acquireLock(task, { timeoutMs = 600000, pollMs = 2000 } = {}) {
  const unlock = await acquireMutex(BROWSER_NAMESPACE, { timeoutMs, pollMs });
  const acquisition = { task, release: null };
  let releasing;
  acquisition.release = () => {
    releasing ??= unlock().finally(() => {
      if (held === acquisition) held = null;
    });
    return releasing;
  };
  held = acquisition;
  return acquisition.release;
}

/** Compatibility API: another process cannot release this process's mutex. */
export async function releaseLock() {
  if (held) await held.release();
}
