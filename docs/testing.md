# Test strategy and verification

The automated suite uses direct ESM imports, real CLI subprocesses, temporary
local data, local WebSocket servers and an optional disposable Chromium profile.
It never uploads private files, switches a real account, or consumes image quota.

## Current Windows record — 2026-10-25

| Runtime | Environment | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Node.js v24.15.0 | Windows, disposable Chrome enabled | 169 | 0 | 0 |

The 0.3.0 tree adds managed-browser unit tests (executable discovery, port-file
parsing, reuse/launch/shutdown), connect-priority tests (explicit endpoint wins,
unconfigured launches, opt-out fails closed), browser-command dispatch tests,
a fail-fast `LOGIN_REQUIRED` task test and a real-Chrome integration test that
launches, reuses, reconnects and gracefully stops a disposable managed browser.
The full suite must not run concurrently with a real task: both share the
machine-local browser mutex, and the lock tests use the real namespace, so a
concurrent production task manifests as `LOCK_TIMEOUT` in those tests. Live
authorized smoke on 2026-10-25: a zero-config first run with a temporary data
directory launched the managed browser, detected the logged-out landing page and
returned structured `LOGIN_REQUIRED` (exit 1, stage `prepare`); `browser status`
reported discovery and endpoint state read-only; `browser stop` shut the instance
down gracefully (`stopped: true`). A stale DevToolsActivePort file after a killed
process was discarded by connect verification and the browser relaunched.

## Previous Windows record — 2026-10-24

| Runtime | Environment | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Node.js v22.23.4 | Windows, disposable Chrome enabled | 154 | 0 | 0 |
| Node.js v24.15.0 | Windows, disposable Chrome enabled | 154 | 0 | 0 |

The Node 22 executable was downloaded from the official distribution with its
published SHA-256 verified. Chrome integration uses a fresh temporary profile,
loopback HTML and restricted external networking. It is separate from real-site
acceptance. Current work prioritizes Windows; further Linux testing is deferred.
GitHub Actions currently targets Windows Node 22/24 with the isolated Chrome
fixture enabled in both jobs. The remote verification record below confirms
their successful execution. macOS and Linux CI are not enabled in this phase.

## Coverage of behavior

| Layer | Covered behavior |
| --- | --- |
| CLI | Real ESM entrypoints, help, unknown/missing arguments, prompt/files, bounds, JSON and exit status |
| Tasks | Single send, uncertain sends, owned-tab cleanup, reconnect failure, partial candidates, persistence warnings, dry-run and guards |
| Replies | Current user key, old-reply exclusion, scoped collection, streaming/Stop rejection, stable final text, exact prompt |
| Images | Bounded fetch/encoding, MIME/extension/container checks, preserving existing output, current-turn image-only galleries, stale/unfinished gallery rejection |
| Storage | Multi-process exclusion and updates, process-death recovery, foreign listeners, reentry, damaged data, I/O errors, alias ambiguity and local dates |
| Browser | Local endpoints, protocol/JS errors, timeouts and late cleanup, invalidated sessions, real local DOM and reconnects |
| Accounts | Explicit target versus observed Google identity, labelled settings fields, chooser/manual states, loading documents, late form-opener handlers, bounded opener retries, owned-session read recovery, navigation reconciliation without resubmission |

```sh
npm run check
npm test
npm run test:coverage
```

Set `CHATGPT_WEB_TEST_CHROME` to a Chrome executable to enable integration.
Without it, that parent test is explicitly skipped and its child tests do not run.
Set `CHATGPT_WEB_TEST_TMP_DIR` to a writable local directory when a restricted
Windows temporary directory refuses rename. Fixture subdirectories are cleaned;
production atomic replacement is never weakened. Run the suite when no other
chatgpt-web task holds the machine-wide browser mutex.

## Real-site acceptance

| Flow | Evidence | Status |
| --- | --- | --- |
| Text ask | Exact harmless requested text collected | Passed earlier local smoke |
| Durable follow-up | Distinct requested response collected from the specified persistent test conversation, including installed private configuration | Passed earlier local smoke |
| Transient conversation URL | Browser-local URL redirected home; command stopped before sending | Failure handled, no persistence guarantee |
| Generated image | One new authorized public CLI request completed generation, download and saving of a 1254 by 1254 PNG; file opened and visually checked | Complete single-image live sample passed |
| Email SSO | Installed public CLI switched from Google to the exact requested email; a fresh settings page independently verified restoration | Passed this live sample |
| Google SSO | Bare `--google` reused existing login and returned a verified observed identity; exact-target chooser paths covered offline | Existing-session live sample passed; other chooser states remain offline coverage |

No real account, conversation ID, profile path, prompt log or image output belongs
in the public package. Live evidence remains in private local records. Earlier Windows UI inspection could not establish the current browser URL, so that
tool was stopped as required. Later authorized CLI checks connected normally to
the configured CDP browser. Earlier navigation timeouts did not recur. A separate
form-opening failure was reproduced, fixed with loaded-state checks and bounded
opener retries, and rechecked live. A timeout does not establish whether a login
already happened: inspect identity before deciding on another run.

## Earlier baselines

On 2026-10-23, the 137-test Windows Node 24 baseline passed with Chrome
155.0.8059.85. Process-side coverage was 86.12% lines, 85.76% branches and 78.88%
functions. Those figures are **not** a measurement of the current 154-test tree.
Browser/VM serialized expressions have different attribution from ordinary Node
code, so behavioral assertions and local DOM tests are the primary evidence there.

The initial installed rollout passed 139 tests after private configuration
isolation and a Windows mutex-port fix. Data mutex ports are 42000–48999, below
Windows' default dynamic range. Reserved ports fail closed; there is no alternate
port probing that could grant two owners different locks. Do not mix lock protocol
versions during an upgrade.

The image smoke initially reported a browser-local conversation URL. Its kept
page later showed a durable URL; the task service now uses the URL returned by
image collection instead of retaining the pre-collection address. Subsequent result-URL and timeout-cleanup refinements were covered by dedicated
protocol/task regressions and the complete Windows suites, without consuming
another generation. The earlier recovered-image
attempt remains historical evidence; it was not counted as this complete smoke.

## GitHub Actions verification — 2026-10-24

The first successful [Windows verification run](https://github.com/WhatYearIsNow/chatgpt-web-skill/actions/runs/40049595602)
tested commit [`099c32d`](https://github.com/WhatYearIsNow/chatgpt-web-skill/commit/099c32d9479c91706582f5eec9f8da8390d88766).
Both `windows-latest` jobs, Node 22 and Node 24, passed **154 tests, 0 failed,
0 skipped**, including their isolated Chrome fixture. Source validation and the
npm distribution dry run passed in both jobs. The workflow grants repository
read access, pins official Actions by commit, and performs no real-site login,
private-file upload or image generation.

## Platform scope

Windows local and remote CI acceptance is complete for this release. Linux
checks remain deferred at the user's request; macOS is unverified. Neither
platform has an enabled CI job in this phase. The successful Windows jobs do not
establish support for those platforms.

The first Windows Node 22 rerun exposed a temporary `EBUSY` while reading the
new disposable Chrome's DevToolsActivePort file. The test now waits for that
Windows-only transient error within its original startup deadline and still
rejects unrelated I/O errors. The subsequent Node 22 and Node 24 suites, including the final result-URL
regression, each passed all 154 tests with the real local Chrome fixture enabled. Production
storage behavior was not weakened.

An installed-tree offline rerun also exposed a deadline race in native target
cleanup: a competing outer timeout could return before its CDP request cleared.
Native waits now use the request's own bounded timer, while external adapters
remain independently bounded. Budgets are validated before operations start.
Silent-query and hanging-evaluation regressions verify that timeout rejection
leaves no native pending request. The failing logs are retained privately alongside
the successful reruns; no assertion was relaxed to mask the failure.

Windows can also deny a randomly selected test data directory's hashed mutex port.
Storage fixtures preflight their new temporary namespaces; on Windows `EACCES`
they allocate a different temporary directory, with a 24-attempt bound. Production
mutexes still use one fixed port per namespace and fail closed on denial. No
production lock-port probing or quota assertion was weakened.
