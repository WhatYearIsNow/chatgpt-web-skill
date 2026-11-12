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
  recoverAfterReload = false,
  newUi = false,
  undecoded = false,
  fallbackOnly = false,
  fallbackStale = false,
} = {}) {
  let fetches = 0,
    states = 0;
  let reloaded = false;
  const gallery = {
    querySelectorAll: () => [
      {
        naturalWidth: undecoded ? 0 : 500,
        alt: 'Generated image 1',
        src: 'http://fixture.invalid/image',
      },
    ],
  };
  const turn = {
    getAttribute: () => (complete ? 'complete' : 'streaming'),
    querySelectorAll: (selector) =>
      selector === '[data-testid="generated-image-gallery"]' ? (galleryOnly || newUi ? [gallery] : []) : [],
  };
  const assistantImg = {
    naturalWidth: 500,
    alt: 'Generated image',
    src: 'conversation-internal',
  };
  const docImg = {
    naturalWidth: 500,
    alt: 'Generated image',
    src: 'http://fixture.invalid/image',
  };
  const docImgs = fallbackOnly || fallbackStale ? [docImg] : [];
  const user = {
    getAttribute: () => replyTo.userKey,
    closest: () => turn,
    compareDocumentPosition: (el) =>
      oldImage || (el === gallery && galleryBeforeUser) || (fallbackStale && el === docImg) ? 2 : 4,
  };
  const assistant = {
    innerText: tail,
    querySelectorAll: (selector) =>
      selector === 'img' ? (galleryOnly || newUi || fallbackOnly ? [] : [assistantImg]) : [],
  };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === SEL.userMsg) {
        if (recoverAfterReload && !reloaded) return [];
        return hydrate && states++ === 0 ? [] : [user];
      }
      if (selector === SEL.assistant) return galleryOnly ? [] : [assistant];
      if (selector === SEL.turn) return [turn];
      if (selector === 'button') return [];
      if (selector === 'img') return docImgs;
      throw new Error(`Unknown selector ${selector}`);
    },
  };
  return {
    fetches: () => fetches,
    evaluate: async (expression) =>
      vm.runInNewContext(expression, {
        document,
        location: {
          href: 'https://chatgpt.com/c/fixture',
          reload: () => {
            reloaded = true;
          },
        },
        AbortSignal,
        Uint8Array,
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        setTimeout,
        clearTimeout,
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
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0);
});
test('deadline sweep reloads the conversation and recovers a finished image', async (t) => {
  const output = await fixture(t),
    p = page({ recoverAfterReload: true });
  await waitAndSaveImage(p, output, 30, { replyTo, recoveryMs: 800 });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});
test('image timeout fires only after the recovery grace window', async (t) => {
  const output = await fixture(t),
    p = page({ complete: false });
  await assert.rejects(waitAndSaveImage(p, output, 30, { replyTo, recoveryMs: 200 }), {
    code: 'IMAGE_TIMEOUT',
  });
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

test('gallery image outside the assistant marker is collected (2026-11-12 UI drift)', async (t) => {
  const output = await fixture(t),
    p = page({ newUi: true });
  await waitAndSaveImage(p, output, 1000, { replyTo });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});

test('undecoded gallery image still downloads via src fetch (minimized-window fallback)', async (t) => {
  const output = await fixture(t),
    p = page({ newUi: true, undecoded: true });
  await waitAndSaveImage(p, output, 1000, { replyTo });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});

test('gallery outside the assistant marker rejects a stale-position gallery', async (t) => {
  const output = await fixture(t),
    p = page({ newUi: true, galleryBeforeUser: true });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0);
});

test('gallery outside the assistant marker still waits for turn completion', async (t) => {
  const output = await fixture(t),
    p = page({ newUi: true, complete: false });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0);
});
for (const config of [
  { galleryOnly: true, galleryBeforeUser: true },
  { galleryOnly: true, complete: false },
]) {
  test(`image-only gallery rejects stale or unfinished content: ${JSON.stringify(config)}`, async (t) => {
    const output = await fixture(t),
      p = page(config);
    await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 }), {
      code: 'IMAGE_TIMEOUT',
    });
    assert.equal(p.fetches(), 0);
  });
}

test('fallback sweep saves a completed image the detection scope cannot see', async (t) => {
  const output = await fixture(t),
    p = page({ fallbackOnly: true });
  await waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1);
});

test('fallback sweep never adopts an image positioned before the current user message', async (t) => {
  const output = await fixture(t),
    p = page({ fallbackOnly: true, fallbackStale: true });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0 }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0);
});
