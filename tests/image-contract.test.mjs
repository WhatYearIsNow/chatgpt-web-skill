import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { imageContractProbe } from '../lib/chatgpt.mjs';
import { SEL } from '../lib/selectors.mjs';

function page({ scopeImgs = [], docImgs = [] } = {}) {
  const document = {
    querySelectorAll: (selector) => {
      if (selector === SEL.userMsg) return [{ getAttribute: () => 'u:user' }];
      if (selector === SEL.assistant) return scopeImgs.length ? [{ querySelectorAll: () => scopeImgs }] : [];
      if (selector === SEL.turn) {
        return scopeImgs.length
          ? [
              {
                querySelectorAll: (s) =>
                  s === '[data-testid="generated-image-gallery"]'
                    ? [{ querySelectorAll: () => scopeImgs }]
                    : [],
              },
            ]
          : [];
      }
      if (selector === 'img') return docImgs;
      throw new Error(`Unknown selector ${selector}`);
    },
  };
  return {
    evaluate: async (expression) =>
      vm.runInNewContext(expression, { document, location: { pathname: '/c/x' } }),
  };
}

const img = (alt) => ({ src: 'http://fixture.invalid/i', alt });

test('imageContractProbe reports a healthy conversation (scope finds what the document has)', async () => {
  const counts = await imageContractProbe(
    page({ scopeImgs: [img('Generated image 1')], docImgs: [img('Generated image 1')] }),
  );
  assert.equal(counts.scopeCount, 1);
  assert.equal(counts.docCount, 1);
});

test('imageContractProbe detects UI drift (image exists only outside the scope paths)', async () => {
  const counts = await imageContractProbe(page({ docImgs: [img('Generated image 1')] }));
  assert.equal(counts.scopeCount, 0);
  assert.equal(counts.docCount, 1);
});

test('imageContractProbe reports zero for a conversation without generated images', async () => {
  const counts = await imageContractProbe(page({}));
  assert.equal(counts.scopeCount, 0);
  assert.equal(counts.docCount, 0);
});
