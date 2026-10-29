# Changelog

## 0.3.1 — 2026-10-29

- Make browser commands honor the same saved endpoint/adapter as tasks; never silently launch a managed browser for an existing connection. Status distinguishes configured policy from online/profile verification, and stop leaves external browsers running. Add explicit `browser ... --managed` selection.
- Add an optional private `profilePath` pin (`CHATGPT_WEB_PROFILE_PATH` for explicit connections). Verify the actual profile of every owned new task tab through the internal version page before navigating that same tab; fail closed on mismatch or unavailable evidence. Keep machine-specific defaults out of the public package.
- 固定开发格式工具并接入现有 CI；补充隔离验证、候选构建、健康检查、代码/数据回退边界与源码阅读路线。运行接口与数据格式保持不变。

## 0.3.0 — 2026-10-25

- Launch an isolated managed browser when no CDP endpoint or adapter is configured: a locally discovered Chromium-family executable (Chrome/Chromium/Edge/Brave; `CHATGPT_WEB_CHROME` or config `chromePath` overrides) with a dedicated fresh profile under the private data directory and an ephemeral loopback debug port. An explicit endpoint or adapter always takes priority, and a configured-but-unreachable endpoint is an error, never a fallback launch trigger.
- The managed browser's first interactive ChatGPT login persists in its profile; every later run reconnects and reuses it without prompting again. Tasks fail fast with `LOGIN_REQUIRED` on the login page instead of waiting out the composer timeout.
- Add the `browser status|start|login|stop` command for the managed lifecycle (read-only status, opt-in headless start, guided first login, graceful shutdown), serialized on the shared browser mutex; add `browser.mjs` entry script.
- Extend private config.json with `chromePath`, `headless` and `managed` (set `false`, or `CHATGPT_WEB_MANAGED=0`, to restore the 0.2.x fail-when-unconfigured behavior); never touch the user's default browser or profiles.

## Unreleased

- Explain CDP endpoint forms in connection failures: `ERR_CDP_DISCOVERY` now states that only http(s) endpoints probe `/json/version`, that ws(s) endpoints connect directly, and that Chrome's `chrome://inspect/#remote-debugging` switch mode intentionally serves 404 there because it exposes only the browser WebSocket endpoint (use the ws:// form, such as a local relay).
- Report unreachable discovery endpoints as `ERR_CDP_DISCOVERY` with the probe URL instead of leaking a raw fetch error, and name the endpoint in WebSocket handshake failures.
- Add a batch image-generation loop template with per-item exit-code checks and a warning against discarding stderr; document `changed: false, verified: true` as the side-effect-free identity assertion before batch runs.

## 0.2.0 — 2026-10-24

- First public release, with Windows Node 22/24 CI and source archive checksums.
- Separate public source from personal configuration and runtime records; adopt MIT.
- Replace implicit sibling-skill imports with an explicit, zero-dependency local CDP transport and optional adapter interface.
- Share CLI validation, task state, structured results, cleanup and one-send behavior across six commands.
- Replace stale-file lock recovery with an OS-owned loopback mutex; serialize quota read/modify/write across processes.
- Reject damaged state and ledger records, preserve valid quota episodes, validate aliases and use the local calendar day.
- Keep reply collection bound to the current user message; preserve reference attachments; distinguish upload failure from explicit quota denial.
- Validate image HTTP response, bounded payload, MIME, basic container structure and requested extension before output replacement.
- Verify the labelled settings email after switching; match explicit targets exactly, or report the observed identity when using existing Google SSO without a target. Remove display-name shortcuts.
- Support image-only galleries tied to the current completed user turn when the website omits an assistant marker; report the final collection URL after a temporary conversation URL becomes durable.
- Recognize full-page account settings, wait for loaded controls across login transitions, and bound harmless form-opening retries without repeating email/SSO submissions.
- Tolerate a temporary Windows port-file sharing lock within the disposable Chrome test startup deadline.
- Validate wait budgets before starting operations and keep native CDP timeout cleanup under one timer, while independently bounding external adapters.
- Add direct-module tests, real CLI subprocesses, multi-process storage tests, disposable local Chrome integration and CI configuration.

Earlier versions were local, environment-specific iterations and were not public releases.
