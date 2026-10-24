# Changelog

## 0.2.0 — 2026-10-23 (release candidate)

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
