import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserError,
  CDPClient,
  Page,
  connectToUserChrome,
  sleep,
  validateEndpoint,
} from "../lib/browser.mjs";
import { activatePage } from "../lib/chatgpt.mjs";

const SILENT = Symbol("no-response");
// Tests must never load an installed user's default adapter configuration.
const isolatedConfigDirectory = await mkdtemp(
  join(
    process.env.CHATGPT_WEB_TEST_TMP_DIR || tmpdir(),
    "browser-config-test-",
  ),
);
const previousDataDirectory = process.env.CHATGPT_WEB_DATA_DIR;
process.env.CHATGPT_WEB_DATA_DIR = isolatedConfigDirectory;
after(async () => {
  if (previousDataDirectory === undefined)
    delete process.env.CHATGPT_WEB_DATA_DIR;
  else process.env.CHATGPT_WEB_DATA_DIR = previousDataDirectory;
  await rm(isolatedConfigDirectory, { recursive: true, force: true });
});

// A deliberately small server fixture exercises Node's actual native WebSocket.
// Only this test code implements frames; production delegates framing to Node.
function frame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const prefix =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.alloc(4);
  if (payload.length >= 126) {
    prefix[0] = 0x80 | opcode;
    prefix[1] = 126;
    prefix.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([prefix, payload]);
}

async function fixture(
  t,
  { command, http, handshake = true, destroyUpgrade = false } = {},
) {
  const requests = [];
  const sockets = new Set();
  let base;
  const server = createServer((req, res) => {
    if (http) return http(req, res, base);
    assert.equal(req.url, "/json/version");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl:
          base.replace("http:", "ws:") + "/devtools/browser/test",
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    if (destroyUpgrade) return socket.destroy();
    if (!handshake) return;
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    const send = (message) => {
      if (!socket.destroyed) socket.write(frame(JSON.stringify(message)));
    };
    let buffered = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        const masked = Boolean(buffered[1] & 128);
        let length = buffered[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        buffered = buffered.subarray(offset + length);
        if (masked)
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) {
          socket.end(frame(payload, 8));
          return;
        }
        if (opcode === 9) {
          socket.write(frame(payload, 10));
          continue;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString("utf8"));
        requests.push(message);
        Promise.resolve(command?.(message, { send, socket }))
          .then((result) => {
            if (result === SILENT || socket.destroyed) return;
            if (result === undefined) {
              if (message.method === "Target.attachToTarget")
                result = { sessionId: "session-" + message.params.targetId };
              else if (message.method === "Runtime.evaluate")
                result = { result: { value: 42 } };
              else if (message.method === "Target.getTargets")
                result = {
                  targetInfos: [
                    { targetId: "one", type: "page", url: "about:blank" },
                    { targetId: "worker", type: "worker" },
                  ],
                };
              else if (message.method === "Target.createTarget")
                result = { targetId: "created" };
              else if (message.method === "Target.closeTarget")
                result = { success: true };
              else result = {};
            }
            send({ id: message.id, result });
          })
          .catch((error) =>
            send({
              id: message.id,
              error: { code: -32000, message: error.message },
            }),
          );
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  return { base, ws: base.replace("http:", "ws:"), requests, sockets };
}

test("endpoint validation accepts local HTTP/WS and rejects remote, credentials and fragments", () => {
  for (const url of [
    "http://localhost:9222",
    "ws://127.0.0.1:9333",
    "http://127.8.2.4:9222",
    "wss://[::1]:9222/",
  ]) {
    assert.ok(validateEndpoint(url) instanceof URL);
  }
  for (const url of [
    "https://example.com",
    "ws://localhost.example.com",
    "file:///tmp/cdp",
    "http://user:password@127.0.0.1",
    "http://localhost/#secret",
    "not a URL",
  ]) {
    assert.throws(() => validateEndpoint(url));
  }
  assert.throws(() =>
    validateEndpoint("http://localhost:9222", { websocketOnly: true }),
  );
});

test("disabled managed launch and invalid durations fail before network or process access", async (t) => {
  const previousManaged = process.env.CHATGPT_WEB_MANAGED;
  process.env.CHATGPT_WEB_MANAGED = "0";
  t.after(() => {
    if (previousManaged === undefined) delete process.env.CHATGPT_WEB_MANAGED;
    else process.env.CHATGPT_WEB_MANAGED = previousManaged;
  });
  await assert.rejects(
    connectToUserChrome({ endpoint: "", browserModule: "" }),
    { code: "ERR_CDP_CONFIGURATION" },
  );
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.2, 2 ** 31]) {
    await assert.rejects(
      connectToUserChrome({ endpoint: "ws://127.0.0.1:9333", timeoutMs }),
      TypeError,
    );
  }
  assert.throws(() => sleep(-1), TypeError);
});

test("managed launch fills the unconfigured gap; explicit endpoints and opt-outs never launch", async (t) => {
  const previousManaged = process.env.CHATGPT_WEB_MANAGED;
  const previousChrome = process.env.CHATGPT_WEB_CHROME;
  t.after(() => {
    for (const [key, value] of [
      ["CHATGPT_WEB_MANAGED", previousManaged],
      ["CHATGPT_WEB_CHROME", previousChrome],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let launches = 0;
  const counting = async () => {
    launches++;
    throw new Error("managed launch must not happen");
  };

  // An explicit endpoint wins and never launches.
  const server = await fixture(t);
  const explicit = await connectToUserChrome({
    endpoint: server.ws,
    timeoutMs: 2000,
    managedLauncher: counting,
  });
  explicit.close();
  assert.equal(launches, 0);

  // Unconfigured defaults to the managed launcher, with env chromePath and no headless default.
  delete process.env.CHATGPT_WEB_MANAGED;
  const sentinel = { close() {} };
  let received = null;
  const client = await connectToUserChrome({
    endpoint: "",
    browserModule: "",
    timeoutMs: 500,
    managedLauncher: async (options) => {
      received = options;
      return { client: sentinel };
    },
  });
  assert.equal(client, sentinel);
  assert.equal(launches, 0);
  assert.equal(received.executable, null);
  assert.equal(received.headless, false);

  // CHATGPT_WEB_CHROME flows through as the executable hint.
  const hint = "C:\\somewhere\\chrome.exe";
  process.env.CHATGPT_WEB_CHROME = hint;
  await connectToUserChrome({
    endpoint: "",
    browserModule: "",
    timeoutMs: 500,
    managedLauncher: async (options) => {
      received = options;
      return { client: sentinel };
    },
  });
  assert.equal(received.executable, hint);
  delete process.env.CHATGPT_WEB_CHROME;

  // CHATGPT_WEB_MANAGED=0 restores the explicit-configuration error.
  process.env.CHATGPT_WEB_MANAGED = "0";
  await assert.rejects(
    connectToUserChrome({
      endpoint: "",
      browserModule: "",
      timeoutMs: 500,
      managedLauncher: counting,
    }),
    (error) =>
      error.code === "ERR_CDP_CONFIGURATION" &&
      error.message.includes("managed"),
  );
});

test("HTTP discovery and actual WebSocket execute CDP methods and reuse one flattened session", async (t) => {
  const server = await fixture(t);
  const client = await connectToUserChrome({
    endpoint: server.base,
    timeoutMs: 2000,
  });
  t.after(() => client.close());
  assert.equal(await client.evaluate("one", "21 * 2"), 42);
  assert.deepEqual(
    await Promise.all([client.session("one"), client.session("one")]),
    ["session-one", "session-one"],
  );
  assert.deepEqual(await client.targets(), [
    { targetId: "one", type: "page", url: "about:blank" },
  ]);
  assert.equal(await client.createTarget(), "created");
  await new Page(client, "created").close();
  assert.equal(
    server.requests.filter(
      (request) => request.method === "Target.attachToTarget",
    ).length,
    1,
  );
  const evaluation = server.requests.find(
    (request) => request.method === "Runtime.evaluate",
  );
  assert.equal(evaluation.sessionId, "session-one");
  assert.equal(evaluation.params.returnByValue, true);
  assert.equal(evaluation.params.awaitPromise, true);
  assert.equal(client.pending.size, 0);
  assert.equal(client.sessions.size, 1);
  client.close();
  assert.equal(client.sessions.size, 0);
  await assert.rejects(client.call("Target.getTargets"), {
    code: "ERR_CDP_CLOSED",
  });
  assert.ok(
    !server.requests.some(
      (request) =>
        request.method === "Browser.close" ||
        request.method === "Page.handleJavaScriptDialog",
    ),
  );
});

test("concurrent session attachment is deduplicated", async (t) => {
  const server = await fixture(t, {
    command: async (message) => {
      if (message.method === "Target.attachToTarget") {
        await sleep(20);
        return { sessionId: "shared" };
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  assert.deepEqual(
    await Promise.all([client.session("new"), client.session("new")]),
    ["shared", "shared"],
  );
  assert.equal(
    server.requests.filter(
      (request) => request.method === "Target.attachToTarget",
    ).length,
    1,
  );
});

test(
  "closeTarget waits beyond its success acknowledgement until only its target disappears",
  { timeout: 5000 },
  async (t) => {
    let gone = false;
    let signalQuery;
    const queried = new Promise((resolveQuery) => {
      signalQuery = resolveQuery;
    });
    const server = await fixture(t, {
      command: (message) => {
        if (message.method === "Target.getTargets") {
          signalQuery();
          return {
            targetInfos: [
              { targetId: "unrelated", type: "page" },
              ...(!gone ? [{ targetId: "owned", type: "page" }] : []),
            ],
          };
        }
      },
    });
    const client = await CDPClient.connect(server.ws);
    t.after(() => client.close());
    await client.session("owned");
    let settled = false;
    const closure = client
      .closeTarget("owned", { timeoutMs: 1000, pollingMs: 5 })
      .then((result) => {
        settled = true;
        return result;
      });
    await queried;
    assert.equal(
      settled,
      false,
      "the acknowledgement must not resolve closeTarget while its target remains",
    );
    gone = true;
    assert.deepEqual(await closure, { success: true });
    assert.equal(client.sessions.has("owned"), false);
    assert.ok(
      server.requests.filter(
        (request) => request.method === "Target.getTargets",
      ).length >= 2,
    );
    assert.deepEqual(
      server.requests
        .filter((request) => request.method === "Target.closeTarget")
        .map((request) => request.params.targetId),
      ["owned"],
    );
    assert.deepEqual(await client.targets(), [
      { targetId: "unrelated", type: "page" },
    ]);
  },
);

test("closeTarget has one bounded deadline when an acknowledged target never disappears", async (t) => {
  const server = await fixture(t, {
    command: (message) => {
      if (message.method === "Target.getTargets")
        return { targetInfos: [{ targetId: "owned", type: "page" }] };
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  const started = performance.now();
  await assert.rejects(
    client.closeTarget("owned", { timeoutMs: 50, pollingMs: 5 }),
    { code: "ERR_BROWSER_TIMEOUT" },
  );
  assert.ok(performance.now() - started < 1000);
  assert.equal(client.pending.size, 0);
  assert.equal(
    server.requests.filter((request) => request.method === "Target.closeTarget")
      .length,
    1,
  );
});

test("a failed close acknowledgement propagates without waiting for disappearance", async (t) => {
  const server = await fixture(t, {
    command: (message) => {
      if (message.method === "Target.closeTarget") return { success: false };
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(client.closeTarget("owned"), {
    code: "ERR_CDP_PROTOCOL",
  });
  assert.equal(
    server.requests.filter((request) => request.method === "Target.getTargets")
      .length,
    0,
  );
});

test("protocol and JavaScript exceptions keep their error details", async (t) => {
  const server = await fixture(t, {
    command: (message, { send }) => {
      if (message.method === "Test.error") {
        send({
          id: message.id,
          error: { code: -32601, message: "Unknown test method" },
        });
        return SILENT;
      }
      if (message.method === "Runtime.evaluate")
        return {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "TypeError: local fixture failure" },
          },
        };
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(client.call("Test.error"), {
    code: -32601,
    method: "Test.error",
    message: "Unknown test method",
  });
  await assert.rejects(client.evaluate("one", "bad()"), {
    code: "ERR_CDP_EVALUATION",
    message: /TypeError: local fixture failure/,
  });
  assert.equal(client.pending.size, 0);
});

test("command timeouts remove pending entries and ignore late responses", async (t) => {
  let replyLate;
  const server = await fixture(t, {
    command: (message, { send }) => {
      if (message.method === "Test.slow") {
        replyLate = () => send({ id: message.id, result: "late" });
        return SILENT;
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(client.call("Test.slow", {}, null, 30), {
    code: "ERR_BROWSER_TIMEOUT",
    method: "Test.slow",
  });
  assert.equal(client.pending.size, 0);
  replyLate();
  assert.deepEqual(await client.call("Test.next"), {});
  assert.equal(client.pending.size, 0);
});

test("serialization/send errors clean pending commands", async (t) => {
  const server = await fixture(t);
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  const circular = {};
  circular.circular = circular;
  await assert.rejects(client.call("Test.circular", circular), {
    code: "ERR_CDP_SEND",
  });
  assert.equal(client.pending.size, 0);
  assert.deepEqual(await client.call("Test.next"), {});
});

test("client close rejects all outstanding commands immediately and is idempotent", async (t) => {
  const server = await fixture(t, {
    command: (message) =>
      message.method.startsWith("Test.") ? SILENT : undefined,
  });
  const client = await CDPClient.connect(server.ws);
  const first = assert.rejects(client.call("Test.first"), {
    code: "ERR_CDP_CLOSED",
  });
  const second = assert.rejects(client.call("Test.second"), {
    code: "ERR_CDP_CLOSED",
  });
  client.close();
  client.close();
  await Promise.all([first, second]);
  assert.equal(client.pending.size, 0);
  assert.equal(client.attaching.size, 0);
});

test("peer disconnect rejects in-flight evaluation", async (t) => {
  const server = await fixture(t, {
    command: (message, { socket }) => {
      if (message.method === "Runtime.evaluate") {
        socket.destroy();
        return SILENT;
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  await assert.rejects(client.evaluate("one", "42"), {
    code: "ERR_CDP_CLOSED",
  });
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
});

test("malformed protocol frames reject pending commands and close the client", async (t) => {
  const server = await fixture(t, {
    command: (message, { socket }) => {
      if (message.method === "Test.bad") {
        socket.write(frame("not JSON"));
        return SILENT;
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  await assert.rejects(client.call("Test.bad"), { code: "ERR_CDP_PROTOCOL" });
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
});

test("detached sessions invalidate the cache and reject their commands", async (t) => {
  const server = await fixture(t, {
    command: (message, { send }) => {
      if (message.method === "Runtime.evaluate") {
        send({
          method: "Target.detachedFromTarget",
          params: { sessionId: message.sessionId },
        });
        return SILENT;
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(client.evaluate("one", "42"), {
    code: "ERR_CDP_DETACHED",
  });
  assert.equal(client.sessions.size, 0);
  assert.equal(client.pending.size, 0);
  assert.equal(await client.session("one"), "session-one");
  assert.equal(
    server.requests.filter(
      (request) => request.method === "Target.attachToTarget",
    ).length,
    2,
  );
});

test("JavaScript dialogs are left for the user", async (t) => {
  const server = await fixture(t, {
    command: (message, { send }) => {
      if (message.method === "Test.dialog")
        send({
          method: "Page.javascriptDialogOpening",
          params: { type: "confirm", message: "Fixture confirmation" },
        });
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await client.call("Test.dialog");
  await sleep(10);
  assert.ok(
    !server.requests.some(
      (request) => request.method === "Page.handleJavaScriptDialog",
    ),
  );
});

test("destroyed targets reject in-flight session commands promptly", async (t) => {
  const server = await fixture(t, {
    command: (message, { send }) => {
      if (message.method === "Runtime.evaluate") {
        send({ method: "Target.targetDestroyed", params: { targetId: "one" } });
        return SILENT;
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(client.evaluate("one", "42"), {
    code: "ERR_CDP_DETACHED",
  });
  assert.equal(client.sessions.size, 0);
  assert.equal(client.pending.size, 0);
});

test("discovery rejects redirects, malformed responses and remote discovered endpoints", async (t) => {
  for (const scenario of ["redirect", "json", "missing", "remote", "large"]) {
    await t.test(scenario, async (subtest) => {
      const server = await fixture(subtest, {
        http: (_, res, base) => {
          if (scenario === "redirect") {
            res.writeHead(302, { Location: base + "/elsewhere" });
            return res.end();
          }
          if (scenario === "json") return res.end("<html>Not CDP</html>");
          if (scenario === "large") return res.end("x".repeat(1024 * 1024 + 1));
          res.end(
            JSON.stringify(
              scenario === "missing"
                ? {}
                : {
                    webSocketDebuggerUrl:
                      "ws://example.com:9222/devtools/browser/x",
                  },
            ),
          );
        },
      });
      await assert.rejects(
        connectToUserChrome({ endpoint: server.base, timeoutMs: 2000 }),
      );
    });
  }
});

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("discovery failures explain endpoint forms and Chrome switch-mode 404", async (t) => {
  const server = await fixture(t, {
    http: (_, res) => {
      res.writeHead(404);
      res.end("not found");
    },
  });
  const error = await connectToUserChrome({
    endpoint: server.base,
    timeoutMs: 2000,
  }).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error.code, "ERR_CDP_DISCOVERY");
  assert.match(
    error.message,
    new RegExp(escaped(`${server.base}/json/version`)),
  );
  assert.match(error.message, /HTTP 404/);
  assert.match(error.message, /ws\(s\) endpoints connect directly/);
  assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
  assert.match(error.message, /ws:\/\/127\.0\.0\.1:9333/);
});

test("unreachable discovery endpoints report ERR_CDP_DISCOVERY with the probe URL", async () => {
  const temp = createServer();
  await new Promise((resolveListen) =>
    temp.listen(0, "127.0.0.1", resolveListen),
  );
  const dead = "http://127.0.0.1:" + temp.address().port;
  await new Promise((resolveClose) => temp.close(resolveClose));
  const error = await connectToUserChrome({
    endpoint: dead,
    timeoutMs: 2000,
  }).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error.code, "ERR_CDP_DISCOVERY");
  assert.match(error.message, new RegExp(escaped(`${dead}/json/version`)));
  assert.match(error.message, /ws\(s\) endpoints connect directly/);
});

test("handshake failures name the endpoint", async (t) => {
  const server = await fixture(t, { destroyUpgrade: true });
  const error = await connectToUserChrome({
    endpoint: server.ws,
    timeoutMs: 2000,
  }).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error.code, "ERR_CDP_CONNECT");
  assert.match(error.message, new RegExp(escaped(server.ws)));
});

test("discovery, WebSocket handshake and initialization each have bounded timeouts", async (t) => {
  for (const phase of ["discovery", "handshake", "initialization"]) {
    await t.test(phase, async (subtest) => {
      const server = await fixture(subtest, {
        ...(phase === "discovery" ? { http: () => {} } : {}),
        handshake: phase !== "handshake",
        command: (message) =>
          phase === "initialization" &&
          message.method === "Target.setDiscoverTargets"
            ? SILENT
            : undefined,
      });
      const started = performance.now();
      await assert.rejects(
        connectToUserChrome({
          endpoint: phase === "discovery" ? server.base : server.ws,
          timeoutMs: 50,
        }),
        { code: "ERR_BROWSER_TIMEOUT" },
      );
      assert.ok(
        performance.now() - started < 1500,
        "timeout must bound connection setup",
      );
    });
  }
});

test("evaluation deadline includes session attachment", async (t) => {
  const server = await fixture(t, {
    command: async (message) => {
      if (message.method === "Target.attachToTarget") {
        await sleep(60);
        return { sessionId: "slow-session" };
      }
      if (message.method === "Runtime.evaluate") {
        await sleep(60);
        return { result: { value: 42 } };
      }
    },
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  const started = performance.now();
  await assert.rejects(client.evaluate("one", "42", 100), {
    code: "ERR_BROWSER_TIMEOUT",
  });
  assert.ok(performance.now() - started < 500);
  assert.equal(client.pending.size, 0);
});

test("Page polling resolves truthy values and stops at its own deadline", async () => {
  const calls = [];
  const page = new Page(
    {
      evaluate: async (target, expression, ms) => {
        calls.push({ target, expression, ms });
        return calls.length >= 3 ? "ready" : false;
      },
    },
    "fixture",
  );
  assert.equal(
    await page.waitForFunction("window.ready", {
      pollingMs: 1,
      timeoutMs: 100,
    }),
    "ready",
  );
  assert.ok(calls.every((call) => call.target === "fixture" && call.ms <= 100));
  const absent = new Page({ evaluate: async () => false }, "fixture");
  const started = performance.now();
  await assert.rejects(
    absent.waitForFunction("false", { timeoutMs: 25, pollingMs: 200 }),
    { code: "ERR_BROWSER_TIMEOUT" },
  );
  assert.ok(performance.now() - started < 500);
});

test("Page only retries transient navigation context errors", async () => {
  let attempts = 0;
  const page = new Page(
    {
      evaluate: async () => {
        if (++attempts === 1)
          throw new BrowserError("Execution context was destroyed.", {
            code: -32000,
          });
        return true;
      },
    },
    "fixture",
  );
  assert.equal(
    await page.waitForFunction("true", { timeoutMs: 100, pollingMs: 1 }),
    true,
  );
  const failure = new BrowserError("ReferenceError: broken", {
    code: "ERR_CDP_EVALUATION",
  });
  const broken = new Page(
    {
      evaluate: async () => {
        throw failure;
      },
    },
    "fixture",
  );
  await assert.rejects(
    broken.waitForFunction("broken"),
    (error) => error === failure,
  );
});

test("Page waiting stays bounded when an external adapter ignores its timeout", async () => {
  const page = new Page({ evaluate: () => new Promise(() => {}) }, "fixture");
  await assert.rejects(page.waitForFunction("true", { timeoutMs: 25 }), {
    code: "ERR_BROWSER_TIMEOUT",
  });
});

test("Page selector expression safely encodes selectors and closes only its target", async () => {
  const calls = [];
  const page = new Page(
    {
      evaluate: async (target, expression) => {
        calls.push({ target, expression });
        return true;
      },
      call: async (method, params) => {
        calls.push({ method, params });
        return method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "unrelated", type: "page" }] }
          : { success: true };
      },
    },
    "owned-target",
  );
  const selector = 'input[data-label="someone\'s input"]';
  assert.equal(await page.waitForSelector(selector, { visible: true }), true);
  assert.ok(calls[0].expression.includes(JSON.stringify(selector)));
  assert.ok(calls[0].expression.includes("style.visibility"));
  await page.close();
  assert.deepEqual(calls[1], {
    method: "Target.closeTarget",
    params: { targetId: "owned-target" },
  });
  assert.deepEqual(calls[2], { method: "Target.getTargets", params: {} });
  assert.throws(() => new Page({}, "x"), TypeError);
  assert.throws(() => page.waitForSelector(""), TypeError);
  await assert.rejects(page.waitForFunction("", {}), TypeError);
});

test("Page.close waits for target disappearance with an ack-only external adapter", async () => {
  let polls = 0;
  const adapter = {
    evaluate() {},
    closeTarget: async (targetId) => {
      assert.equal(targetId, "owned");
      return { success: true };
    },
    call: async (method) => {
      assert.equal(method, "Target.getTargets");
      return {
        targetInfos: [
          { targetId: "unrelated", type: "page" },
          ...(++polls < 3 ? [{ targetId: "owned", type: "page" }] : []),
        ],
      };
    },
  };
  assert.deepEqual(
    await new Page(adapter, "owned").close({ timeoutMs: 1000, pollingMs: 1 }),
    { success: true },
  );
  assert.equal(polls, 3);
});

test("Page.close bounds an external adapter that ignores the polling timeout", async () => {
  const page = new Page(
    {
      evaluate() {},
      closeTarget: async () => ({ success: true }),
      call: () => new Promise(() => {}),
    },
    "owned",
  );
  await assert.rejects(page.close({ timeoutMs: 25 }), {
    code: "ERR_BROWSER_TIMEOUT",
  });
});

test("explicit trusted browser adapter supports file URLs and cleans late/invalid clients", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-web-adapter-test-"));
  assert.equal(dirname(directory), resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "adapter.mjs");
  await writeFile(
    path,
    `
    export const state = { closed: 0, options: null };
    export async function connectToUserChrome(options) {
      state.options = options;
      return { call() {}, session() {}, evaluate() {}, createTarget() {}, targets() {}, close() { state.closed++; } };
    }
  `,
  );
  const url = pathToFileURL(path).href;
  const client = await connectToUserChrome({
    endpoint: "",
    browserModule: url,
    timeoutMs: 1000,
  });
  client.close();
  const { state } = await import(url);
  assert.equal(state.closed, 1);
  assert.ok(state.options.timeoutMs > 0 && state.options.timeoutMs <= 1000);
  await assert.rejects(
    connectToUserChrome({ endpoint: "", browserModule: "relative.mjs" }),
    TypeError,
  );
  await assert.rejects(
    connectToUserChrome({
      endpoint: "",
      browserModule: "file://remote-host/share/adapter.mjs",
    }),
    /local file/,
  );
  const invalidPath = join(directory, "invalid.mjs");
  await writeFile(
    invalidPath,
    "export const state = { closed: false }; export async function connectToUserChrome() { return { close() { state.closed = true; } }; }",
  );
  await assert.rejects(
    connectToUserChrome({ endpoint: "", browserModule: invalidPath }),
    /must implement call/,
  );
  assert.equal(
    (await import(pathToFileURL(invalidPath).href)).state.closed,
    true,
  );
  const slowPath = join(directory, "slow.mjs");
  await writeFile(
    slowPath,
    "export const state = { closed: false }; export async function connectToUserChrome() { await new Promise(r => setTimeout(r, 100)); return { close() { state.closed = true; } }; }",
  );
  await assert.rejects(
    connectToUserChrome({
      endpoint: "",
      browserModule: slowPath,
      timeoutMs: 30,
    }),
    { code: "ERR_BROWSER_TIMEOUT" },
  );
  await sleep(120);
  assert.equal((await import(pathToFileURL(slowPath).href)).state.closed, true);
});

test("explicit CDP endpoint takes precedence over optional adapter", async (t) => {
  const server = await fixture(t);
  const client = await connectToUserChrome({
    endpoint: server.ws,
    browserModule: "not-a-valid-path",
    timeoutMs: 1000,
  });
  client.close();
});

test("a silent target-disappearance query times out with no native pending request", async (t) => {
  const server = await fixture(t, {
    command: (message) =>
      message.method === "Target.getTargets" ? SILENT : undefined,
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  await assert.rejects(
    client.closeTarget("owned", { timeoutMs: 40, pollingMs: 5 }),
    { code: "ERR_BROWSER_TIMEOUT" },
  );
  assert.equal(client.pending.size, 0);
  assert.equal(
    server.requests.filter((r) => r.method === "Target.closeTarget").length,
    1,
  );
  assert.equal(
    server.requests.filter((r) => r.method === "Target.getTargets").length,
    1,
  );
});
test("waitForFunction timeout finishes native evaluation cleanup before it rejects", async (t) => {
  const server = await fixture(t, {
    command: (message) =>
      message.method === "Runtime.evaluate" ? SILENT : undefined,
  });
  const client = await CDPClient.connect(server.ws);
  t.after(() => client.close());
  const page = new Page(client, "owned");
  await assert.rejects(
    page.waitForFunction("true", { timeoutMs: 40, pollingMs: 5 }),
    { code: "ERR_BROWSER_TIMEOUT" },
  );
  assert.equal(client.pending.size, 0);
});

test("activatePage retries a transient -32000 attach error and surfaces real errors", async () => {
  const calls = [];
  let attempts = 0;
  const cdp = {
    async call(method) {
      calls.push(method);
      if (method === "Page.setWebLifecycleState") {
        attempts++;
        if (attempts === 1)
          throw new BrowserError("Not attached to an active page", {
            code: -32000,
          });
      }
      return {};
    },
  };
  await activatePage(cdp, "target", "session");
  assert.equal(attempts, 2);
  assert.ok(calls.includes("Emulation.setFocusEmulationEnabled"));

  const failing = {
    async call() {
      throw new BrowserError("boom", { code: "ERR_CDP_PROTOCOL" });
    },
  };
  await assert.rejects(activatePage(failing, "target", "session"), /boom/);
});
