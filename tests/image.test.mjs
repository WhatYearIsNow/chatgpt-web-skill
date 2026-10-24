import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateImagePayload, saveImagePayload } from '../lib/image.mjs';

const png = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7BkAAAAASUVORK5CYII=' };
test('image bytes, MIME and requested file extension must agree', () => {
  assert.ok(validateImagePayload(png, 'out.png').length > 0);
  assert.throws(() => validateImagePayload(png, 'out.jpg'), { code: 'IMAGE_EXTENSION' });
  assert.throws(() => validateImagePayload({ ...png, mime: 'text/html' }, 'out.png'), { code: 'IMAGE_INVALID' });
  for (const payload of [{ mime: 'image/png', base64: Buffer.from('<html>error</html>').toString('base64') },
    { mime: 'image/png', base64: '' }, { mime: 'image/png', base64: '%%%%' }, {}])
    assert.throws(() => validateImagePayload(payload, 'out.png'), { code: 'IMAGE_INVALID' });
});
test('truncated PNG headers and empty JPEG containers are not accepted as images', () => {
  const truncatedPng = { ...png, base64: Buffer.from(png.base64, 'base64').subarray(0, 24).toString('base64') };
  assert.throws(() => validateImagePayload(truncatedPng, 'out.png'), { code: 'IMAGE_INVALID' });
  assert.throws(() => validateImagePayload({ mime: 'image/jpeg', base64: Buffer.from([255,216,255,217]).toString('base64') }, 'out.jpg'), { code: 'IMAGE_INVALID' });
});
test('a failed image download validation leaves an existing output untouched', async () => {
  const dir = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'image-test-'));
  try {
    const out = join(dir, 'out.png');
    await writeFile(out, 'original');
    await assert.rejects(saveImagePayload({ mime: 'text/html', base64: Buffer.from('error').toString('base64') }, out));
    assert.equal(await readFile(out, 'utf8'), 'original');
    await saveImagePayload(png, out);
    assert.deepEqual(await readFile(out), Buffer.from(png.base64, 'base64'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
