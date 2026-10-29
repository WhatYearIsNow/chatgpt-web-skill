/**
 * Opt-in integration test: set CHATGPT_WEB_TEST_CHROME to a Chromium/Chrome/Edge
 * executable. Starts a headless browser with a new disposable profile and a
 * loopback-only fixture. Never connects to an existing browser or ChatGPT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Page, connectToUserChrome, sleep, withProfileGuard } from '../lib/browser.mjs';
import { ensureManagedBrowser, closeManagedBrowser, browserStatus } from '../lib/launch.mjs';
import { fillPrompt, sendAndConfirm, waitTurnComplete, collectReply, attachFiles } from '../lib/chatgpt.mjs';

const binary = process.env.CHATGPT_WEB_TEST_CHROME;

test(
  'real Chromium CDP lifecycle with an isolated local fixture',
  {
    skip: binary ? false : 'Set CHATGPT_WEB_TEST_CHROME to run the offline browser integration test',
    timeout: 45_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'chatgpt-web-chrome-test-'));
    assert.equal(dirname(directory), resolve(tmpdir()));
    const mechanicalFixture = await readFile(new URL('./fixtures/chatgpt-page.html', import.meta.url));
    let browser;
    let browserError;
    let cdp;
    let server;
    const sockets = new Set();
    t.after(async () => {
      // Browser.close is scoped to the disposable process launched by this test.
      // The production transport never sends this command.
      if (cdp && !cdp.closed) {
        await cdp.call('Browser.close', {}, null, 1500).catch(() => {});
        cdp.close();
      }
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        browser.kill();
        const deadline = performance.now() + 3000;
        while (browser.exitCode === null && browser.signalCode === null && performance.now() < deadline)
          await sleep(50);
      }
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
      // Only the verified mkdtemp directory created by this test is removed.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/mechanical') return res.end(mechanicalFixture);
      res.end(`<!doctype html><html><head><title>Offline browser fixture</title></head>
      <body><textarea id="composer"></textarea><div id="hidden" style="display:none">Hidden</div>
      <script>setTimeout(() => { const el = document.createElement('button'); el.id = 'ready';
      el.textContent = 'Ready'; document.body.append(el); }, 150);</script></body></html>`);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${directory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-extensions',
      '--metrics-recording-only',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    browser = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
    browser.on('error', (error) => {
      browserError = error;
    });
    let port;
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      if (browserError) throw browserError;
      if (browser.exitCode !== null)
        throw new Error(`Disposable browser exited with code ${browser.exitCode}`);
      try {
        const text = await readFile(join(directory, 'DevToolsActivePort'), 'utf8');
        port = Number(text.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536) break;
      } catch (error) {
        // On Windows Chrome briefly locks this file while publishing the port.
        // Keep the original startup deadline; do not retry unrelated I/O errors.
        if (error.code !== 'ENOENT' && !(process.platform === 'win32' && error.code === 'EBUSY')) throw error;
      }
      await sleep(50);
    }
    assert.ok(port, 'Chrome must publish a debugging port within 15 seconds');
    cdp = await connectToUserChrome({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 10_000 });
    const preserved = await cdp.createTarget('about:blank');
    await t.test('new task tab profile is verified against the actual Chromium profile path', async () => {
      const guarded = withProfileGuard(cdp, join(directory, 'Default'));
      const verified = await guarded.createTarget(fixtureUrl);
      const checkedPage = new Page(guarded, verified);
      await checkedPage.waitForSelector('#composer', { timeoutMs: 5000 });
      await checkedPage.close();
      const before = (await cdp.targets()).map((target) => target.targetId).sort();
      await assert.rejects(withProfileGuard(cdp, join(directory, 'wrong-profile')).createTarget(fixtureUrl), {
        code: 'PROFILE_MISMATCH',
      });
      assert.deepEqual((await cdp.targets()).map((target) => target.targetId).sort(), before);
      assert.ok(before.includes(preserved));
    });
    const owned = await cdp.createTarget(fixtureUrl);
    const page = new Page(cdp, owned);
    try {
      assert.equal(await page.waitForSelector('#composer', { timeoutMs: 5000 }), true);
    } catch (cause) {
      const state = await page.evaluate(
        'JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 500)})',
      );
      throw new Error(`Local fixture did not load: ${state}`, { cause });
    }
    assert.equal(
      await page.waitForSelector('#ready', { visible: true, timeoutMs: 5000, pollingMs: 20 }),
      true,
    );
    assert.equal(await page.evaluate('document.title'), 'Offline browser fixture');
    assert.equal(await page.evaluate('Promise.resolve(21 * 2)'), 42);
    assert.deepEqual(await page.evaluate('({unicode: "测试", nested: [1, true]})'), {
      unicode: '测试',
      nested: [1, true],
    });
    assert.equal(await page.evaluate('undefined'), undefined);
    assert.ok(Number.isNaN(await page.evaluate('NaN')));
    assert.equal(await page.evaluate('123n'), 123n);
    await assert.rejects(page.evaluate('throw new Error("offline fixture failure")'), {
      code: 'ERR_CDP_EVALUATION',
      message: /offline fixture failure/,
    });
    await assert.rejects(page.waitForSelector('#hidden', { visible: true, timeoutMs: 100, pollingMs: 10 }), {
      code: 'ERR_BROWSER_TIMEOUT',
    });
    await assert.rejects(page.waitForSelector('#does-not-exist', { timeoutMs: 100, pollingMs: 10 }), {
      code: 'ERR_BROWSER_TIMEOUT',
    });
    await assert.rejects(page.evaluate('new Promise(() => {})', 100), { code: 'ERR_BROWSER_TIMEOUT' });
    assert.equal(await page.evaluate('1 + 1'), 2, 'a timed-out evaluation must not poison later commands');
    await page.close();
    const remainingTargets = await cdp.targets();
    assert.ok(remainingTargets.some((target) => target.targetId === preserved));
    assert.ok(!remainingTargets.some((target) => target.targetId === owned));
    assert.equal(cdp.pending.size, 0);
    cdp.close();
    // Disconnect leaves the browser alive, so a fresh client can reconnect.
    cdp = await connectToUserChrome({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
    assert.ok((await cdp.targets()).some((target) => target.targetId === preserved));

    const mechanicalTarget = await cdp.createTarget(fixtureUrl + 'mechanical');
    const mechanicalPage = new Page(cdp, mechanicalTarget);
    const sid = await cdp.session(mechanicalTarget);
    await mechanicalPage.waitForFunction('!!window.fixture', { timeoutMs: 5000 });
    const quiet = () => {};
    const collectOptions = { stableIterations: 1, pollingMs: 10, waitContentMs: 150 };
    const reset = () => mechanicalPage.evaluate('window.fixture.reset()');

    await t.test('real textarea events preserve a multi-file upload through fill and sending', async () => {
      await reset();
      const files = [join(directory, 'fixture-first.txt'), join(directory, 'fixture-second.txt')];
      await Promise.all(
        files.map((path, index) => writeFile(path, `Offline test attachment ${index + 1}`, 'utf8')),
      );
      assert.equal(await attachFiles(mechanicalPage, cdp, sid, files, { retries: 1, log: quiet }), true);
      const prompt = 'Use both local attachments.\nKeep the final marker: Ω';
      assert.equal(await fillPrompt(mechanicalPage, cdp, sid, prompt, { log: quiet }), prompt.length);
      assert.equal(await mechanicalPage.evaluate('document.querySelector("#composer").value'), prompt);
      assert.deepEqual(
        await mechanicalPage.evaluate(
          '[...document.querySelectorAll("#chips button")].map(button => button.getAttribute("aria-label"))',
        ),
        ['Remove fixture-first.txt', 'Remove fixture-second.txt'],
      );
      const cursor = await sendAndConfirm(mechanicalPage, { confirmTimeoutMs: 1000, log: quiet });
      assert.match(cursor.userKey, /^fixture-\d+:user$/);
      assert.notEqual(cursor.userKey, 'fixture-old:user');
      const state = await mechanicalPage.evaluate('window.fixtureState');
      assert.equal(state.pasteEvents, 1, 'fill must dispatch the accepted clipboard event');
      assert.ok(state.inputEvents >= 3, 'clear, paste and send must trigger input events');
      assert.deepEqual(state.uploadEvents, [
        { input: 'Attach files', names: ['fixture-first.txt', 'fixture-second.txt'] },
      ]);
      assert.deepEqual(state.sends, [
        {
          userKey: cursor.userKey,
          text: prompt,
          attachments: ['Remove fixture-first.txt', 'Remove fixture-second.txt'],
        },
      ]);
      assert.equal(await mechanicalPage.evaluate('document.querySelector("#composer").value'), '');
    });

    await t.test('a completed historical answer cannot satisfy the new user turn', async () => {
      const cursor = { userKey: await mechanicalPage.evaluate('window.fixtureState.sends[0].userKey') };
      // Even a completed new turn cannot borrow an assistant located before it.
      await mechanicalPage.evaluate('window.fixture.markComplete()');
      await assert.rejects(waitTurnComplete(mechanicalPage, 120, { replyTo: cursor }), {
        code: 'ERR_BROWSER_TIMEOUT',
      });
      await assert.rejects(
        collectReply(mechanicalPage, { ...collectOptions, replyTo: cursor }),
        /src=awaiting-current-assistant/,
      );
    });

    await t.test(
      'streaming turns and Stop both block collection until the current reply completes',
      async () => {
        const cursor = { userKey: await mechanicalPage.evaluate('window.fixtureState.sends[0].userKey') };
        await mechanicalPage.evaluate(
          'window.fixture.respond("Current partial text", { complete: false, stop: false })',
        );
        await assert.rejects(waitTurnComplete(mechanicalPage, 120, { replyTo: cursor }), {
          code: 'ERR_BROWSER_TIMEOUT',
        });
        await assert.rejects(
          collectReply(mechanicalPage, { ...collectOptions, replyTo: cursor }),
          /未完成或未稳定/,
        );
        await mechanicalPage.evaluate(
          'window.fixture.respond("ChatGPT said: Current local response", { complete: true, stop: true })',
        );
        await assert.rejects(waitTurnComplete(mechanicalPage, 120, { replyTo: cursor }), {
          code: 'ERR_BROWSER_TIMEOUT',
        });
        await assert.rejects(
          collectReply(mechanicalPage, { ...collectOptions, replyTo: cursor }),
          /未完成或未稳定/,
        );
        await mechanicalPage.evaluate('document.querySelector("#fixture-stop").remove()');
        await waitTurnComplete(mechanicalPage, 1000, { replyTo: cursor });
        assert.deepEqual(
          await collectReply(mechanicalPage, { ...collectOptions, waitContentMs: 1000, replyTo: cursor }),
          { text: 'Current local response', src: 'assistant.innerText' },
        );
        // A later send changes ownership; the former cursor can no longer collect.
        await fillPrompt(mechanicalPage, cdp, sid, 'The second current prompt', { log: quiet });
        const next = await sendAndConfirm(mechanicalPage, { confirmTimeoutMs: 1000, log: quiet });
        assert.notEqual(next.userKey, cursor.userKey);
        await assert.rejects(
          collectReply(mechanicalPage, { ...collectOptions, replyTo: cursor }),
          /src=user-mismatch/,
        );
      },
    );

    await t.test('a matching prefix and length cannot hide a corrupted prompt ending', async () => {
      await reset();
      await mechanicalPage.evaluate('window.fixtureState.pasteMode = "corrupt-tail"');
      const prompt = 'A long matching prefix that passes the first forty characters check.\nFinal marker Ω';
      await assert.rejects(fillPrompt(mechanicalPage, cdp, sid, prompt, { log: quiet }), {
        code: 'PROMPT_MISMATCH',
      });
      const state = await mechanicalPage.evaluate('window.fixtureState');
      assert.equal(state.sends.length, 0, 'prompt validation must not send anything');
      assert.equal(state.pasteEvents, 1);
      const actual = await mechanicalPage.evaluate('document.querySelector("#composer").value');
      assert.equal(actual.length, prompt.length);
      assert.equal(actual.slice(0, 40), prompt.slice(0, 40));
      assert.notEqual(actual, prompt);
    });

    await t.test('a partial multi-file upload is rejected despite an existing remove chip', async () => {
      await reset();
      await mechanicalPage.evaluate('window.fixtureState.uploadMode = "partial"');
      const files = [join(directory, 'fixture-first.txt'), join(directory, 'fixture-second.txt')];
      await assert.rejects(
        attachFiles(mechanicalPage, cdp, sid, files, { retries: 1, log: quiet }),
        /附件挂载失败/,
      );
      assert.equal(await mechanicalPage.evaluate('document.querySelectorAll("#chips button").length'), 1);
      assert.equal(await mechanicalPage.evaluate('window.fixtureState.sends.length'), 0);
    });

    await t.test('a send click without a new user key is reported as unconfirmed', async () => {
      await reset();
      await mechanicalPage.evaluate('window.fixtureState.sendMode = "unconfirmed"');
      const prompt = 'Unconfirmed local request';
      await fillPrompt(mechanicalPage, cdp, sid, prompt, { log: quiet });
      await assert.rejects(sendAndConfirm(mechanicalPage, { confirmTimeoutMs: 100, log: quiet }), {
        code: 'SEND_UNCONFIRMED',
      });
      assert.equal(await mechanicalPage.evaluate('window.fixtureState.sends.length'), 0);
      assert.equal(await mechanicalPage.evaluate('document.querySelector("#composer").value'), prompt);
    });
    await mechanicalPage.close();
  },
);

test(
  'managed browser lifecycle: launch, reuse, connect, stop',
  {
    skip: binary ? false : 'Set CHATGPT_WEB_TEST_CHROME to run the offline browser integration test',
    timeout: 60_000,
  },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chatgpt-web-managed-test-'));
    assert.equal(dirname(dataDir), resolve(tmpdir()));
    t.after(async () => {
      // Only this test's own disposable launch is stopped; then the verified
      // mkdtemp directory is removed.
      await closeManagedBrowser({ dataDir, waitMs: 5000 });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    const statusBefore = await browserStatus({ dataDir });
    assert.equal(statusBefore.running, false);
    assert.equal(
      statusBefore.executable,
      binary,
      'CHATGPT_WEB_TEST_CHROME must be discoverable as the executable',
    );
    assert.equal(statusBefore.endpoint, null);

    const launched = await ensureManagedBrowser({
      dataDir,
      executable: binary,
      headless: true,
      timeoutMs: 30_000,
    });
    assert.equal(launched.reused, false);
    assert.match(launched.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    launched.client.close();

    // A second call must reuse the running instance, not launch a second browser.
    const reused = await ensureManagedBrowser({
      dataDir,
      executable: binary,
      headless: true,
      timeoutMs: 30_000,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.endpoint, launched.endpoint);
    const targetId = await reused.client.createTarget('about:blank');
    assert.equal(await reused.client.evaluate(targetId, '2 + 3'), 5);
    reused.client.close();

    const statusRunning = await browserStatus({ dataDir });
    assert.equal(statusRunning.running, true);
    assert.equal(statusRunning.endpoint, launched.endpoint);

    // connectToUserChrome's unconfigured path reaches the same managed browser.
    const client = await connectToUserChrome({
      timeoutMs: 30_000,
      managedLauncher: (options) => ensureManagedBrowser({ ...options, dataDir, executable: binary }),
    });
    assert.ok((await client.targets()).length >= 1);
    client.close();

    const stopped = await closeManagedBrowser({ dataDir, waitMs: 10_000 });
    assert.equal(
      stopped.stopped,
      true,
      'the managed browser must exit and remove its DevToolsActivePort file',
    );
    const statusAfter = await browserStatus({ dataDir });
    assert.equal(statusAfter.running, false);
  },
);
