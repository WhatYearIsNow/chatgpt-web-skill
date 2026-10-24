// Local evidence only: these events are not the service's actual quota balance.
// Every read/modify/write (including readers) is serialized across local processes.
import { join } from 'node:path';
import { withDataLock, readJsonFile, writeJsonAtomic, appendLedger, readTextFile, storageError } from './storage.mjs';

const DEFAULT_COOLDOWN_MS = 24 * 3600 * 1000;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function invalid(message) { throw storageError('STORAGE_INVALID', message); }
function assertEvent(event) {
  if (!plainObject(event) || !validDate(event.ts) || typeof event.kind !== 'string' || typeof event.outcome !== 'string') {
    invalid('Stored ledger event is invalid; preserve and repair the ledger before continuing.');
  }
}

async function loadLedger(dir) {
  const raw = await readTextFile(join(dir, 'usage.jsonl'));
  if (raw && !raw.endsWith('\n')) invalid('Stored ledger has an incomplete final record; preserve and repair it before continuing.');
  return raw.split('\n').filter(line => line.trim()).map(line => {
    let event;
    try { event = JSON.parse(line); } catch { invalid('Stored ledger JSON is malformed; preserve and repair the ledger before continuing.'); }
    assertEvent(event);
    return event;
  });
}

/** Records dry-run evidence; dry runs never count as image usage. */
export async function record(evt) {
  const event = { ...evt, ts: new Date().toISOString() };
  assertEvent(event);
  return withDataLock(async dir => {
    await loadLedger(dir);
    await appendLedger(join(dir, 'usage.jsonl'), `${JSON.stringify(event)}\n`);
  });
}

export async function readAll() { return withDataLock(loadLedger); }

function dayKey(date, timeZone) {
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => fields.find(field => field.type === type).value).join('-');
}

/** The local calendar day, not UTC midnight. Optional clock/timezone for callers/tests. */
export async function todayImages(account = null, { now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const today = dayKey(new Date(now), timeZone);
  return (await readAll()).filter(event => event.kind === 'image' && event.outcome === 'ok'
    && dayKey(new Date(event.ts), timeZone) === today && (!account || event.account === account)).length;
}

export async function tail(n = 20) {
  if (!Number.isSafeInteger(n) || n < 0) throw storageError('QUOTA_INVALID', 'Event count must be a nonnegative integer.');
  return n === 0 ? [] : (await readAll()).slice(-n).reverse();
}

async function loadState(dir) {
  const state = await readJsonFile(join(dir, 'quota-state.json'), () => ({ known_limits: {}, accounts: {} }));
  if (!plainObject(state) || !plainObject(state.accounts) || (state.known_limits !== undefined && !plainObject(state.known_limits))) {
    invalid('Stored quota state has an invalid shape; preserve and repair it before continuing.');
  }
  for (const entry of Object.values(state.accounts)) {
    if (!plainObject(entry) || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some(alias => typeof alias !== 'string' || !alias.trim())))
        || ['exhausted_at', 'resets_at', 'last_ok_at'].some(key => entry[key] != null && !validDate(entry[key]))
        || (entry.raw_message != null && typeof entry.raw_message !== 'string')) {
      invalid('Stored account state is invalid; preserve and repair it before continuing.');
    }
  }
  return state;
}

function normalized(value) { return (value || '').trim().toLowerCase(); }
function matches(state, value, fragment = false) {
  const needle = normalized(value);
  if (!needle) return null;
  const entries = Object.entries(state.accounts).filter(([key, entry]) => [key, ...(entry.aliases || [])]
    .some(name => fragment ? normalized(name).includes(needle) : normalized(name) === needle));
  if (entries.length > 1) throw storageError('QUOTA_ALIAS_AMBIGUOUS', 'Account alias matches more than one stored account; use an unambiguous account name.');
  return entries.length ? { ...entries[0][1], key: entries[0][0] } : null;
}

/** Parse explicit English local-time phrases; unknown/invalid phrases use +24h. */
export function parseResetAt(rawMsg, now = Date.now()) {
  const match = /\btomorrow at (\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(rawMsg || '');
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) return now + DEFAULT_COOLDOWN_MS;
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    date.setHours(hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0), minute, 0, 0);
    return date.getTime();
  }
  return now + DEFAULT_COOLDOWN_MS;
}

/** Keep an unexpired episode's precise reset time when a second signal arrives. */
export async function markExhausted(displayName, rawMessage, now = Date.now()) {
  return withDataLock(async dir => {
    const state = await loadState(dir);
    const name = (displayName || '').trim() || '未知账号';
    const existing = matches(state, name);
    const reset = existing?.resets_at ? Date.parse(existing.resets_at) : existing?.exhausted_at ? Date.parse(existing.exhausted_at) + DEFAULT_COOLDOWN_MS : 0;
    if (existing?.exhausted_at && reset > now) return state.accounts[existing.key];
    const key = existing ? existing.key : name;
    const entry = {
      ...(existing ? state.accounts[key] : {}),
      aliases: [...new Set([...(existing?.aliases || []), name])],
      exhausted_at: new Date(now).toISOString(),
      resets_at: new Date(parseResetAt(rawMessage, now)).toISOString(),
      raw_message: (rawMessage || '').slice(0, 300),
    };
    Object.defineProperty(state.accounts, key, { value: entry, enumerable: true, configurable: true, writable: true });
    await writeJsonAtomic(join(dir, 'quota-state.json'), state);
    return entry;
  });
}

export async function markOk(displayName, now = Date.now()) {
  return withDataLock(async dir => {
    const state = await loadState(dir);
    const existing = matches(state, displayName);
    const key = existing ? existing.key : (displayName || '').trim();
    if (!key) return;
    const entry = {
      ...(existing ? state.accounts[key] : {}),
      aliases: [...new Set([...(existing?.aliases || []), key])],
      exhausted_at: null, resets_at: null, raw_message: null,
      last_ok_at: new Date(now).toISOString(),
    };
    Object.defineProperty(state.accounts, key, { value: entry, enumerable: true, configurable: true, writable: true });
    await writeJsonAtomic(join(dir, 'quota-state.json'), state);
  });
}

function usable(entry, now) {
  if (!entry || !entry.exhausted_at) return { ok: true };
  const reset = entry.resets_at ? Date.parse(entry.resets_at) : Date.parse(entry.exhausted_at) + DEFAULT_COOLDOWN_MS;
  if (reset <= now) return { ok: true };
  return { ok: false, key: entry.key, reason: entry.raw_message || '限额', exhausted_at: entry.exhausted_at, resets_at: new Date(reset).toISOString() };
}

export async function checkUsable(displayName, now = Date.now()) {
  return withDataLock(async dir => usable(matches(await loadState(dir), displayName), now));
}

export async function checkUsableByAlias(fragment, now = Date.now()) {
  return withDataLock(async dir => usable(matches(await loadState(dir), fragment, true), now));
}
