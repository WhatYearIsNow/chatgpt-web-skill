import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitAndSaveImage } from '../lib/chatgpt.mjs';
import { SEL } from '../lib/selectors.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7BkAAAAASUVORK5CYII=',
  'base64',
);
const replyTo = { userKey: 'current:user' };
function page({
  status = 200,
  mime = 'image/png',
  contentLength,
  tail = '',
  oldImage = false,
  hydrate = false,
  galleryOnly = false,
  galleryBeforeUser = false,
  complete = true,
} = {}) {
  let fetches = 0,
    states = 0;
  const gallery = {
    querySelectorAll: () => [
      { naturalWidth: 500, alt: 'Generated image 1', src: 'http://fixture.invalid/image' },
    ],
  };
  const turn = {
    getAttribute: () => (complete ? 'complete' : 'streaming'),
    querySelectorAll: () => (galleryOnly ? [gallery] : []),
  };
  const user = {
    getAttribute: () => replyTo.userKey,
    closest: () => turn,
    compareDocumentPosition: (el) => (oldImage || (el === gallery && galleryBeforeUser) ? 2 : 4),
  };
  const assistant = {
    innerText: tail,
    querySelectorAll: () => [
      { naturalWidth: 500, alt: 'Generated image', src: 'http://fixture.invalid/image' },
    ],
  };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === SEL.userMsg) return hydrate && states++ === 0 ? [] : [user];
      if (selector === SEL.assistant) return galleryOnly ? [] : [assistant];
      if (selector === SEL.turn) return [turn];
      if (selector === 'button') return [];
      throw new Error(`Unknown selector ${selector}`);
    },
  };
  return {
    fetches: () => fetches,
    evaluate: async (expression) =>
      vm.runInNewContext(expression, {
        document,
        location: { href: 'https://chatgpt.com/c/fixture' },
        AbortSignal,
        Uint8Array,
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        fetch: async () => {
          fetches++;
          return new Response(png, {
            status,
            headers: {
              'content-type': mime,
              ...(contentLength ? { 'content-length': contentLength } : {}),
            },
          });
        },
      }),
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'image-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'image.png');
  await writeFile(output, 'previous output');
  return output;
}

test('current generated image is saved through the real page-side fetch expression', async (t) => {
  const output = await fixture(t),
    p = page({ hydrate: true });
  await waitAndSaveImage(p, output, 2000, { replyTo });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});
for (const [name, config] of [
  ['HTTP error', { status: 404 }],
  ['HTML response', { mime: 'text/html' }],
  ['MIME/signature mismatch', { mime: 'image/jpeg' }],
  ['oversized declared response', { contentLength: '67108865' }],
]) {
  test(`${name} cannot replace an existing image output`, async (t) => {
    const output = await fixture(t);
    await assert.rejects(waitAndSaveImage(page(config), output, 1000, { replyTo }));
    assert.equal(await readFile(output, 'utf8'), 'previous output');
  });
}
test('image from an older assistant is never downloaded', async (t) => {
  const output = await fixture(t),
    p = page({ oldImage: true });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo }), { code: 'IMAGE_TIMEOUT' });
  assert.equal(p.fetches(), 0);
});
test('explicit current quota denial retains the raw reset-time evidence', async (t) => {
  const output = await fixture(t);
  const denial = 'You have used all your free images. Try again tomorrow at 12:36 PM';
  await assert.rejects(
    waitAndSaveImage(page({ tail: denial }), output, 1000, { replyTo }),
    (error) => error.name === 'QuotaError' && error.rawMessage === denial,
  );
});

test('image-only gallery in the current completed turn is downloaded without an assistant marker', async (t) => {
  const output = await fixture(t),
    p = page({ galleryOnly: true });
  await waitAndSaveImage(p, output, 1000, { replyTo });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});
for (const config of [
  { galleryOnly: true, galleryBeforeUser: true },
  { galleryOnly: true, complete: false },
]) {
  test(`image-only gallery rejects stale or unfinished content: ${JSON.stringify(config)}`, async (t) => {
    const output = await fixture(t),
      p = page(config);
    await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo }), { code: 'IMAGE_TIMEOUT' });
    assert.equal(p.fetches(), 0);
  });
}
