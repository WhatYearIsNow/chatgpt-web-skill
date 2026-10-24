# Architecture

```text
scripts/*.mjs         thin ESM entrypoints
  lib/cli.mjs         argument validation, help, JSON output, exit status
  lib/tasks.mjs       transaction lifecycle, owned tabs, one-send rule, partial results
    lib/chatgpt.mjs   composer, attachments, thinking, send and image DOM operations
    lib/reply.mjs     current-message ownership and stable text collection
    lib/account.mjs   email-verified SSO state machine
    lib/browser.mjs   explicit local CDP transport / external adapter boundary
    lib/quota.mjs     observed usage and local quota episodes
      lib/storage.mjs + lib/lock.mjs   local storage and OS-owned mutexes
```

## Connection boundary

Set `CHATGPT_WEB_CDP_URL` to an existing local HTTP discovery endpoint or browser WebSocket endpoint. Only loopback addresses are accepted, including the discovered WebSocket URL; redirects and credentials in endpoint URLs are rejected. Transport timeouts, command errors, destroyed targets and disconnects propagate and clear pending work. JavaScript errors are not silently treated as false DOM conditions.

Alternatively, `CHATGPT_WEB_BROWSER_MODULE` names an absolute trusted local ESM path/file URL. Its `connectToUserChrome({ timeoutMs })` must return:

```js
{
  call(method, params, sessionId, timeoutMs),
  session(targetId, timeoutMs),
  evaluate(targetId, expression, timeoutMs),
  createTarget(url), targets(), close()
}
```

An adapter may additionally expose `forgetSession(targetId)` to support account read recovery. Without that optional method, recovery fails with the original error; no browser operation is repeated.

An explicit CDP URL takes precedence. There is no auto-discovery of sibling skills, OS approval automation, password handling or implicit browser launch. `connectWithApproval()` remains a compatibility name; the default implementation does not approve anything.
Protocol reference: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

## Task contract

Every task acquires the browser mutex and creates its own page. It never navigates, closes or clears an existing user page. A nonempty composer/attachment or active generation blocks preparation. Each send is attempted once. The sent user message's key is passed to both completion waiting and collection.

`sent` is false before send, `"unknown"` during a send that cannot be confirmed, and true once confirmed. The result includes `stage`, `url`, `outputs` and cleanup/persistence `warnings`. An ambiguous send must be inspected before retrying. Image candidates stop at the first failure and preserve completed outputs.

Image waiting reconnects CDP after send, preserving the target and message cursor. Image data is downloaded in the page, capped at 64 MiB, checked for HTTP status/MIME, then checked in Node for encoding, basic container bounds and matching extension. PNG/JPEG/WebP checks do not replace a full pixel decoder or content review. Output replacement occurs only after validation.

## Storage and concurrency

`CHATGPT_WEB_DATA_DIR` overrides platform defaults:

| Platform | Default |
| --- | --- |
| Windows | `%LOCALAPPDATA%/chatgpt-web` |
| macOS | `~/Library/Application Support/chatgpt-web` |
| Linux | `$XDG_DATA_HOME/chatgpt-web` or `~/.local/share/chatgpt-web` |

`usage.jsonl` records observed events, with no prompt text recorded by the task runner. `quota-state.json` holds local limit evidence. Display-name aliases are fallible; ambiguous alias matching fails. Stored corruption or I/O errors are reported rather than reset to an empty ledger.

The mutex is an exclusive loopback TCP listener owned by the OS. Process death releases it; no process deletes or steals a stale file lock. Separate browser/data namespace port ranges avoid lock-order collisions. A port hash collision or unrelated listener may block a task, never grant concurrent ownership. Browser locks reject same-process reentry; data operations queue and detect recursive calls.

This coordinates one host and local storage. It is not a distributed lock or a guarantee of durability through power loss. State writes use a same-directory temporary file, fsync and rename. See [libuv TCP bind behavior](https://docs.libuv.org/en/v1.x/tcp.html#c.uv_tcp_bind).

## Test boundaries

The task service accepts dependency overrides; production imports are used unchanged in tests. CLI subprocess tests verify real ESM resolution, help, error JSON and exit status. Browser protocol tests use local WS servers; Chrome integration uses a disposable profile and local HTML. Account driver injection tests the state machine separately from current login-page selectors. These layers intentionally separate deterministic contracts from real website drift.
