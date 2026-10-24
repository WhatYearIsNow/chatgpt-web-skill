import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBrowserConfig } from '../lib/config.mjs';
import { connectToUserChrome } from '../lib/browser.mjs';

test('private configuration is optional, validates schema, and rejects corruption', async t => {
  const directory = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'config-test-'));
  const previous = process.env.CHATGPT_WEB_DATA_DIR;
  process.env.CHATGPT_WEB_DATA_DIR = directory;
  t.after(async () => { if (previous === undefined) delete process.env.CHATGPT_WEB_DATA_DIR; else process.env.CHATGPT_WEB_DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await loadBrowserConfig(), {});
  const file = join(directory, 'config.json');
  await writeFile(file, JSON.stringify({ endpoint: 'http://127.0.0.1:9222' }));
  assert.equal((await loadBrowserConfig()).endpoint, 'http://127.0.0.1:9222');
  for (const value of ['{', 'null', '[]', '{"endpoint":true}', '{"endpoint":""}', '{"unexpected":"value"}']) {
    await writeFile(file, value);
    await assert.rejects(loadBrowserConfig(), { code: 'CONFIG_INVALID' });
  }
  // Explicit configuration bypasses even a damaged default file.
  await assert.rejects(connectToUserChrome({ endpoint: 'https://example.invalid', timeoutMs: 100 }), error => error.code !== 'CONFIG_INVALID');
});
