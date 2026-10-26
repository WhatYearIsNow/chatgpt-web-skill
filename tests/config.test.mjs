import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBrowserConfig, resolveBrowserOptions } from '../lib/config.mjs';
import { connectToUserChrome } from '../lib/browser.mjs';

test('private configuration is optional, validates schema, and rejects corruption', async (t) => {
  const directory = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'config-test-'));
  const previous = process.env.CHATGPT_WEB_DATA_DIR;
  process.env.CHATGPT_WEB_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHATGPT_WEB_DATA_DIR;
    else process.env.CHATGPT_WEB_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await loadBrowserConfig(), {});
  const file = join(directory, 'config.json');
  await writeFile(file, JSON.stringify({ endpoint: 'http://127.0.0.1:9222' }));
  assert.equal((await loadBrowserConfig()).endpoint, 'http://127.0.0.1:9222');
  await writeFile(
    file,
    JSON.stringify({ managed: false, chromePath: 'C:\\browsers\\chrome.exe', headless: true }),
  );
  const managed = await loadBrowserConfig();
  assert.equal(managed.managed, false);
  assert.equal(managed.chromePath, 'C:\\browsers\\chrome.exe');
  assert.equal(managed.headless, true);
  for (const value of [
    '{',
    'null',
    '[]',
    '{"endpoint":true}',
    '{"endpoint":""}',
    '{"unexpected":"value"}',
    '{"managed":"no"}',
    '{"chromePath":42}',
    '{"headless":"yes"}',
  ]) {
    await writeFile(file, value);
    await assert.rejects(loadBrowserConfig(), { code: 'CONFIG_INVALID' });
  }
  // Explicit configuration bypasses even a damaged default file.
  await assert.rejects(
    connectToUserChrome({ endpoint: 'https://example.invalid', timeoutMs: 100 }),
    (error) => error.code !== 'CONFIG_INVALID',
  );
});

test('saved profile pins are shared by all commands and explicit connections replace the saved policy', async (t) => {
  const directory = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'policy-test-'));
  const keys = [
    'CHATGPT_WEB_DATA_DIR',
    'CHATGPT_WEB_CDP_URL',
    'CHATGPT_WEB_BROWSER_MODULE',
    'CHATGPT_WEB_PROFILE_PATH',
    'CHATGPT_WEB_MANAGED',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CHATGPT_WEB_DATA_DIR = directory;
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'config.json');
  const profilePath = join(directory, 'daily', 'Profile 4');
  await writeFile(
    file,
    JSON.stringify({ browserModule: join(directory, 'adapter.mjs'), profilePath, managed: false }),
  );
  const policy = await resolveBrowserOptions();
  assert.equal(policy.mode, 'adapter');
  assert.equal(policy.profilePath, profilePath);
  const explicit = await resolveBrowserOptions({ endpoint: 'ws://127.0.0.1:9999' });
  assert.equal(explicit.mode, 'endpoint');
  assert.equal(
    explicit.profilePath,
    undefined,
    'an explicit alternative must not inherit the old profile pin',
  );
  assert.equal(explicit.browserModule, undefined);
  await writeFile(file, JSON.stringify({ profilePath }));
  await assert.rejects(resolveBrowserOptions(), { code: 'CONFIG_INVALID' });
  await writeFile(file, JSON.stringify({ endpoint: 'ws://127.0.0.1:9333', profilePath: 'Profile 4' }));
  await assert.rejects(resolveBrowserOptions(), { code: 'CONFIG_INVALID' });
  await writeFile(file, JSON.stringify({ managed: false }));
  assert.equal((await resolveBrowserOptions()).mode, 'disabled');
});
