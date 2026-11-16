/**
 * Regression tests for the dedicated-browser reuse guard.
 *
 * A persistent browser can retain proxy settings from an earlier launch.
 * Compare the active process arguments with the current configuration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInstanceProxy,
  commandLineMentionsDir,
  dedicatedLaunchArgs,
  stopListenerProcess,
} from '../lib/launch.mjs';

const PROXY = 'http://127.0.0.1:7897';

test('checkInstanceProxy: proxy required and present', () => {
  const r = checkInstanceProxy({
    commandLine: `chrome --proxy-server=${PROXY} about:blank`,
    proxyServer: PROXY,
  });
  assert.equal(r.known, true);
  assert.equal(r.matches, true);
  assert.equal(r.reason, null);
});

test('checkInstanceProxy: proxy required but absent is a mismatch', () => {
  // The exact failure shape from the incident: live port, no proxy flag.
  const r = checkInstanceProxy({
    commandLine: 'chrome --user-data-dir=C:/p --remote-debugging-port=9230',
    proxyServer: PROXY,
  });
  assert.equal(r.known, true);
  assert.equal(r.matches, false);
  assert.equal(r.reason, 'INSTANCE_WITHOUT_PROXY');
});

test('checkInstanceProxy: different proxy is a mismatch, not a match', () => {
  const r = checkInstanceProxy({
    commandLine: 'chrome --proxy-server=http://127.0.0.1:1080',
    proxyServer: PROXY,
  });
  assert.equal(r.matches, false);
  assert.equal(r.reason, 'INSTANCE_PROXY_MISMATCH');
});

test('checkInstanceProxy: stale proxy when none is configured', () => {
  // Config dropped the proxy but the old instance still routes through it.
  const r = checkInstanceProxy({ commandLine: `chrome --proxy-server=${PROXY}`, proxyServer: null });
  assert.equal(r.matches, false);
  assert.equal(r.reason, 'INSTANCE_HAS_PROXY');
});

test('checkInstanceProxy: no proxy on either side matches', () => {
  const r = checkInstanceProxy({ commandLine: 'chrome about:blank', proxyServer: null });
  assert.equal(r.matches, true);
});

test('checkInstanceProxy: unreadable command line is unknown, never a pass', () => {
  for (const commandLine of [null, undefined, '', '   ']) {
    const r = checkInstanceProxy({ commandLine, proxyServer: PROXY });
    assert.equal(r.known, false, `known must be false for ${JSON.stringify(commandLine)}`);
    assert.equal(r.matches, false);
    assert.equal(r.reason, 'UNKNOWN_COMMAND_LINE');
  }
});

test('commandLineMentionsDir: separator and case insensitive', () => {
  const dir = 'profiles/chatgpt-web/dedicated';
  // Chrome echoes whichever separator it was handed, so both forms must match.
  assert.equal(commandLineMentionsDir('chrome --user-data-dir=profiles\\chatgpt-web\\dedicated', dir), true);
  assert.equal(commandLineMentionsDir(`chrome --user-data-dir=${dir}`, dir), true);
  assert.equal(
    commandLineMentionsDir('chrome "--user-data-dir=profiles\\chatgpt-web\\dedicated"', dir),
    true,
  );
});

test('commandLineMentionsDir: foreign profile is not ours', () => {
  const dir = 'profiles/chatgpt-web/dedicated';
  assert.equal(commandLineMentionsDir('chrome --user-data-dir=profiles/other/profile', dir), false);
  assert.equal(commandLineMentionsDir('', dir), false);
  assert.equal(commandLineMentionsDir(null, dir), false);
});

test('dedicatedLaunchArgs: proxy flag appears only when configured', () => {
  const withProxy = dedicatedLaunchArgs({ profileDir: 'C:/p', port: 9230, proxyServer: PROXY });
  assert.ok(withProxy.includes(`--proxy-server=${PROXY}`));
  const withoutProxy = dedicatedLaunchArgs({ profileDir: 'C:/p', port: 9230 });
  assert.ok(!withoutProxy.some((a) => a.startsWith('--proxy-server=')));
});

test('profile identity rejects prefix directories and references in unrelated flags', () => {
  const dir = 'profiles/chatgpt-web/dedicated';
  assert.equal(commandLineMentionsDir('chrome --user-data-dir=' + dir + '-other', dir), false);
  assert.equal(commandLineMentionsDir('chrome --log-file=' + dir, dir), false);
  assert.equal(
    commandLineMentionsDir('chrome "--user-data-dir=C:/space dir/profile"', 'C:/space dir/profile'),
    true,
  );
  assert.equal(
    commandLineMentionsDir('chrome --user-data-dir="C:/space dir/profile"', 'C:/space dir/profile'),
    true,
  );
});

test('quoted proxy arguments compare correctly', () => {
  assert.equal(
    checkInstanceProxy({ commandLine: 'chrome "--proxy-server=' + PROXY + '"', proxyServer: PROXY }).matches,
    true,
  );
  assert.equal(
    checkInstanceProxy({ commandLine: 'chrome --proxy-server="' + PROXY + '"', proxyServer: PROXY }).matches,
    true,
  );
});

test('listener replacement rechecks ownership and rejects a changed process', async () => {
  let killed = false;
  const expected = 'chrome --user-data-dir=profiles/dedicated';
  const result = await stopListenerProcess(9230, {
    expectedCommandLine: expected,
    expectedProfileDir: 'profiles/dedicated',
    findPidImpl: () => 100,
    readCommandLineImpl: () => 'chrome --user-data-dir=profiles/other',
    kill: () => {
      killed = true;
    },
  });
  assert.equal(result.reason, 'LISTENER_CHANGED');
  assert.equal(killed, false);
  const stopped = await stopListenerProcess(9230, {
    expectedCommandLine: expected,
    expectedProfileDir: 'profiles/dedicated',
    findPidImpl: () => 100,
    readCommandLineImpl: () => expected,
    kill: (pid) => {
      assert.equal(pid, 100);
      killed = true;
    },
    probeImpl: async () => false,
  });
  assert.equal(stopped.stopped, true);
  assert.equal(killed, true);
});
