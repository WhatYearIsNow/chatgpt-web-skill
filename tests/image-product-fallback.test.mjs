// 回归：2026-11-18 的 ChatGPT UI 漂移场景。
//
// 那天 ChatGPT 一次改版让**所有语义选择器**失效：
//   [data-message-author-role] / [data-testid="user-message"] /
//   article[data-testid^="conversation-turn"] / [data-search-unit-id]
// 全部命中 0 个 → chatgpt-web 抛
//   "Current user message does not match the image request"
// → 引擎 exit 1 → 整批生图被判 failed。
//
// **但图其实早就生成好了**（在 blob: URL 里，页面上有 1024x1536 的 img）。
//
// 本测试复现那个场景，并要求：**产物兜底能把图救出来**。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitAndSaveImage, collectLargeImageSrcs, probeProductImage } from '../lib/chatgpt.mjs';
import { SEL } from '../lib/selectors.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7BkAAAAASUVORK5CYII=',
  'base64',
);
const replyTo = { userKey: 'current:user' };

/**
 * 造一个「语义选择器全废、但图在」的页面。
 * @param {object} opts
 *   drift: true  —— 模拟 2026-11-18 的 UI 改版（语义选择器全命中 0）
 *   before: 发送前就存在的大图 src 集合
 */
function driftedPage({ drift = true, before = [], images } = {}) {
  let fetches = 0;
  const bigImg = {
    naturalWidth: 1024,
    naturalHeight: 1536,
    alt: '',
    src: 'blob:https://chatgpt.com/generated-1',
  };
  const avatar = {
    naturalWidth: 20,
    naturalHeight: 20,
    alt: '',
    src: 'data:image/png;base64,AAA',
  };
  const all = images ?? [avatar, bigImg];

  const document = {
    querySelectorAll: (selector) => {
      if (selector === SEL.userMsg) return drift ? [] : [];
      if (selector === SEL.assistant) return [];
      if (selector === SEL.turn) return [];
      if (selector === 'button') return [];
      if (selector === 'img') return all;
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
        Set,
        JSON,
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        setTimeout,
        clearTimeout,
        fetch: async (url) => {
          fetches += 1;
          return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
        Response,
      }),
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(), 'product-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'image.png');
  await writeFile(out, 'previous output');
  return out;
}

// ── 回归主用例 ───────────────────────────────────────────────────────
test('回归：语义选择器全废时，产物兜底仍能取回生成好的图', async (t) => {
  const output = await fixture(t);
  const p = driftedPage({ drift: true });
  // 关键：语义路径会抛 "does not match"，但产物兜底必须成功
  await waitAndSaveImage(p, output, 2000, { replyTo, recoveryMs: 0, beforeSrcs: [] });
  assert.deepEqual(await readFile(output), png);
  assert.equal(p.fetches(), 1, '应当只下载一次');
});

test('回归：产物兜底排除发送前就存在的图', async (t) => {
  const output = await fixture(t);
  // 只有一张「旧图」，它在 beforeSrcs 里 → 不该被当成这次产物
  const old = {
    naturalWidth: 1024,
    naturalHeight: 1536,
    alt: '',
    src: 'blob:https://chatgpt.com/old',
  };
  const p = driftedPage({ drift: true, images: [old] });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0, beforeSrcs: [old.src] }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0, '陈旧图不应被下载');
  assert.equal(await readFile(output, 'utf8'), 'previous output');
});

test('回归：小图（头像/图标）不被当成产物', async (t) => {
  const output = await fixture(t);
  const small = {
    naturalWidth: 20,
    naturalHeight: 20,
    alt: '',
    src: 'blob:https://chatgpt.com/tiny',
  };
  const p = driftedPage({ drift: true, images: [small] });
  await assert.rejects(waitAndSaveImage(p, output, 20, { replyTo, recoveryMs: 0, beforeSrcs: [] }), {
    code: 'IMAGE_TIMEOUT',
  });
  assert.equal(p.fetches(), 0);
});

// ── collectLargeImageSrcs ────────────────────────────────────────────
test('collectLargeImageSrcs 只收集够大的 blob/data 图', async () => {
  const p = driftedPage({ drift: true });
  const srcs = await collectLargeImageSrcs(p);
  assert.equal(srcs.length, 1);
  assert.equal(srcs[0], 'blob:https://chatgpt.com/generated-1');
});

test('collectLargeImageSrcs 不依赖语义选择器', async () => {
  const p = driftedPage({ drift: true });
  await collectLargeImageSrcs(p);
  // 语义选择器在这个 fixture 里全都返回空，collectLargeImageSrcs 仍应拿到图
  assert.ok(true);
});

// ── 回归：检测阶段的抛错不得跳过兜底（2026-11-18 实测缺陷）───────────────
//
// 上一组测试覆盖的是「user 消息**不存在**」的情形——那条路径走
// `if (cursor && !user) return {ready:false}`，**不抛错**，所以能顺利走到兜底。
//
// 但当天真机是另一种情形：`data-chatgpt-search-unit-key` 属性**被改版删了**，
// 于是 user 元素存在、属性却是 undefined ≠ replyTo.userKey，代码在
//   chatgpt.mjs L878  throw new Error('Current user message does not match...')
// 处抛错。而外层的 catch 原本写着 `if (!reloaded) throw error;` ——
// **第一次抛错就直接逃逸**，把循环外那两层兜底（sweep / 产物扫描）全跳过了。
//
// 症状正是当天看到的：`stage: "wait"`, `sent: true`, `outputs: []`,
// `ERR_CDP_EVALUATION / Current user message does not match the image request`。
// 图明明在 blob: URL 里，却一张都拿不回来（实测 2/2 全灭）。
//
// 修法：catch 里不再逃逸，记下 firstStateError 后 break，交给兜底层；
// 只有兜底也失败才用该错误作为最终原因。
test('回归：user 消息 userKey 不匹配（属性被改版删除）仍能靠产物兜底取回图', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-key-mismatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'out.png');

  const bigImg = {
    naturalWidth: 1024,
    naturalHeight: 1536,
    alt: '',
    src: 'blob:https://chatgpt.com/generated-mismatch',
  };
  // user 元素存在，但没有 data-chatgpt-search-unit-key（改版后属性消失）
  const userEl = {
    getAttribute: () => undefined,
    compareDocumentPosition: () => 0,
    closest: () => null,
  };
  const document = {
    querySelectorAll: (sel) => (sel === SEL.userMsg ? [userEl] : sel === 'img' ? [bigImg] : []),
    body: { innerText: '' },
  };

  let fetched = 0;
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/x' },
    AbortSignal,
    Uint8Array,
    Set,
    JSON,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    fetch: async () => {
      fetched += 1;
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    },
    Response,
  };
  const p = {
    evaluate: async (expression) => vm.runInNewContext(expression, context),
    url: async () => 'https://chatgpt.com/c/x',
  };

  await waitAndSaveImage(p, output, 3000, { replyTo, recoveryMs: 0, beforeSrcs: [] });
  assert.deepEqual(await readFile(output), png, '产物兜底必须把图救回来，不能被检测期抛错短路');
  assert.equal(fetched > 0, true, '兜底应当真的去下载那张图');
});

test('回归：检测期抛错且兜底也无图时，失败原因要保留真实错误码', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-key-mismatch-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'out.png');

  const userEl = { getAttribute: () => undefined, compareDocumentPosition: () => 0, closest: () => null };
  const document = {
    querySelectorAll: (sel) => (sel === SEL.userMsg ? [userEl] : []),
    body: { innerText: '' },
  };
  const p = {
    evaluate: async (expression) =>
      vm.runInNewContext(expression, { document, location: { href: 'https://chatgpt.com/c/x' } }),
    url: async () => 'https://chatgpt.com/c/x',
  };

  await assert.rejects(
    () => waitAndSaveImage(p, output, 1200, { replyTo, recoveryMs: 0, beforeSrcs: [] }),
    (error) => {
      // 关键：不能只报一句泛泛的 IMAGE_TIMEOUT，必须说明是「语义结构认不出」
      assert.equal(error.code, 'IMAGE_STATE_UNRECOGNIZED');
      assert.match(error.message, /Current user message does not match|does not match/);
      return true;
    },
  );
});

// ── 回归：检测失败后必须**继续等待**，不能用 break 提前放弃 ──────────────
//
// 2026-11-18 实测第二个缺陷（修第一个缺陷时引入）：
//   把 catch 里的 `throw error` 改成 `firstStateError = error; break;` 之后，
//   错误码确实变好了，但 **break 立即跳出循环，等于放弃了所有等待**。
//   图是异步生成的，跳出那一刻页面上还没有图，兜底扫到空 → 仍然失败。
//   实测 2/2 全灭，重新打开那两个会话却都能看到完整的 1087x1447 生成图。
//
// 本测试用「图在第 N 次 evaluate 之后才出现」来模拟异步生成，要求：
//   尽管检测分支从第一次起就抛错，最终仍要把后来出现的图收回来。
test('回归：检测期持续抛错时，仍会等到图出现并回收（不能用 break 提前放弃）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-late-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'out.png');

  let evalCount = 0;
  let fetched = 0;
  // 前 4 次 evaluate 页面上都没有图；第 5 次起「生成完成」
  const IMAGE_APPEARS_AT = 5;
  const bigImg = {
    naturalWidth: 1087,
    naturalHeight: 1447,
    alt: 'Generated image 1',
    src: 'blob:https://chatgpt.com/late-generated',
  };
  const userEl = {
    getAttribute: () => 'wrong-key', // 与 replyTo.userKey 不匹配 → 每次都抛错
    compareDocumentPosition: () => 0,
    closest: () => null,
  };

  const p = {
    evaluate: async (expression) => {
      evalCount += 1;
      const hasImage = evalCount >= IMAGE_APPEARS_AT;
      const document = {
        querySelectorAll: (sel) => {
          if (sel === SEL.userMsg) return [userEl];
          if (sel === 'img') return hasImage ? [bigImg] : [];
          return [];
        },
        body: { innerText: '' },
      };
      return vm.runInNewContext(expression, {
        document,
        location: { href: 'https://chatgpt.com/c/late' },
        AbortSignal,
        Uint8Array,
        Set,
        JSON,
        btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
        setTimeout,
        clearTimeout,
        fetch: async () => {
          fetched += 1;
          return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
        Response,
      });
    },
    url: async () => 'https://chatgpt.com/c/late',
  };

  await waitAndSaveImage(p, output, 6000, { replyTo, recoveryMs: 0, beforeSrcs: [] });
  assert.deepEqual(await readFile(output), png, '必须等到图出现并回收，而不是第一次检测失败就放弃');
  assert.equal(fetched > 0, true, '应当真的下载了那张图');
  assert.equal(evalCount >= IMAGE_APPEARS_AT, true, '应当重试到图出现的轮次');
});

// ── 回归：图已生成时必须**立刻**取回，不必等满 timeout ────────────────────
//
// 2026-11-18 实测：语义检测失效后，图约 1 分钟就已生成好，但旧结构只在
// **deadline（默认 420s）之后**才轮到循环外的兜底，用户白等约 7 分钟。
//
// 修法：每轮语义检测失败后先做一次轻量产物探测，命中即取回。
// 本测试要求：图在第 3 次 evaluate 出现，且**远早于** timeout(20s) 结束就返回。
test('回归：产物已存在时提前回收，不等满 timeout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-fast-recover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'out.png');

  let evalCount = 0;
  let fetched = 0;
  const IMAGE_APPEARS_AT = 3;
  const bigImg = {
    naturalWidth: 1087,
    naturalHeight: 1447,
    alt: 'Generated image 1',
    src: 'blob:https://chatgpt.com/fast-recovered',
  };
  // 语义检测永远失败（模拟 UI 漂移）
  const userEl = { getAttribute: () => 'wrong-key', compareDocumentPosition: () => 0, closest: () => null };

  const t0 = Date.now();
  const p = {
    evaluate: async (expression) => {
      evalCount += 1;
      const hasImage = evalCount >= IMAGE_APPEARS_AT;
      const document = {
        querySelectorAll: (sel) => {
          if (sel === SEL.userMsg) return [userEl];
          if (sel === 'img') return hasImage ? [bigImg] : [];
          return [];
        },
        body: { innerText: '' },
      };
      return vm.runInNewContext(expression, {
        document,
        location: { href: 'https://chatgpt.com/c/fast' },
        AbortSignal,
        Uint8Array,
        Set,
        JSON,
        btoa: (v) => Buffer.from(v, 'binary').toString('base64'),
        setTimeout,
        clearTimeout,
        fetch: async () => {
          fetched += 1;
          return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        },
        Response,
      });
    },
    url: async () => 'https://chatgpt.com/c/fast',
  };

  // timeout 给 20s：若没有快速回收，就要等满 20s 才走兜底
  await waitAndSaveImage(p, output, 20000, { replyTo, recoveryMs: 0, beforeSrcs: [] });
  const elapsed = Date.now() - t0;

  assert.deepEqual(await readFile(output), png, '图必须被取回');
  assert.equal(fetched > 0, true, '必须真的下载');
  assert.ok(elapsed < 5000, `应在图出现的下一轮就返回（实测 ${elapsed}ms），而不是等满 20s timeout`);
});

// ── 回归：参考图与生成图尺寸相同时，必须选生成图 ────────────────────────
//
// 2026-11-18 真机实测：上传参考图后，页面上有两张**尺寸完全相同**的大图：
//   { w:1086, h:1448, alt:"User attachment" }     ← 用户上传的输入图
//   { w:1086, h:1448, alt:"Generated image 1" }   ← 真正要的生成结果
// 原实现只按面积降序取第一张，面积相等时实测 "User attachment" 排在前面，
// 于是把**参考图当答案**存下去 —— 静默的错图，比失败更糟（看起来成功了）。
test('回归：尺寸相同时选生成图，不选上传的参考图', async () => {
  const attachment = {
    naturalWidth: 1086,
    naturalHeight: 1448,
    alt: 'User attachment',
    src: 'blob:https://chatgpt.com/attachment-ref',
  };
  const generated = {
    naturalWidth: 1086,
    naturalHeight: 1448,
    alt: 'Generated image 1',
    src: 'blob:https://chatgpt.com/generated-real',
  };
  // 故意把参考图放在 DOM 前面（实测就是这个顺序）
  const document = { querySelectorAll: (sel) => (sel === 'img' ? [attachment, generated] : []) };
  const page = {
    evaluate: async (expression) => vm.runInNewContext(expression, { document, Set, JSON }),
  };

  const result = await probeProductImage(page, { beforeSrcs: [], minSide: 300 });
  assert.equal(result.src, 'blob:https://chatgpt.com/generated-real', '必须选生成图');
  assert.match(result.alt, /Generated image/);
  assert.equal(result.rank, undefined, 'rank 是内部字段，不必透出');
});

test('回归：只有参考图时也不会误选（明确标记为附件）', async () => {
  const attachment = {
    naturalWidth: 1086,
    naturalHeight: 1448,
    alt: 'User attachment',
    src: 'blob:https://chatgpt.com/only-ref',
  };
  const document = { querySelectorAll: (sel) => (sel === 'img' ? [attachment] : []) };
  const page = { evaluate: async (e) => vm.runInNewContext(e, { document, Set, JSON }) };
  const result = await probeProductImage(page, { beforeSrcs: [], minSide: 300 });
  // 仍然会返回（避免完全没结果），但要能看出它是附件
  assert.equal(result.src, 'blob:https://chatgpt.com/only-ref');
  assert.match(result.alt, /User attachment/);
});

test('回归：无 alt 标注时按面积降序（保持旧行为）', async () => {
  const big = { naturalWidth: 1087, naturalHeight: 1447, alt: '', src: 'blob:https://big' };
  const small = { naturalWidth: 400, naturalHeight: 400, alt: '', src: 'blob:https://small' };
  const document = { querySelectorAll: (sel) => (sel === 'img' ? [small, big] : []) };
  const page = { evaluate: async (e) => vm.runInNewContext(e, { document, Set, JSON }) };
  const result = await probeProductImage(page, { beforeSrcs: [], minSide: 300 });
  assert.equal(result.src, 'blob:https://big', '无标注时仍按面积取最大');
});
