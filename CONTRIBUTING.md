# Contributing

Use Node.js 22.15 or newer. No dependency installation is required.

1. Run `npm run check` and `npm test` before submitting a change.
2. For browser/mechanical changes, configure `CHATGPT_WEB_TEST_CHROME` and run the local browser integration too.
3. Add behavioral tests for the bug or changed contract. Prefer direct imports and real CLI subprocesses over rewriting source strings to mock imports.
4. State whether a check used fixtures, a disposable local browser, or the real site. Live tests require permission and should use harmless prompts; never silently spend image quota or sign out a contributor.
5. Keep credentials, usage records, account identities, private paths, prompt contents and real conversation URLs out of commits, screenshots and issues.

Keep browser transport, mechanical selectors, command transactions and storage independent. New send paths must keep the one-send rule and pass the returned message cursor into collection. Cleanup must target only pages created by that transaction.

Run `npm pack --dry-run --json` to inspect the distributable allowlist. CI currently runs Node 22/24 on Windows with a disposable Chrome fixture. Linux/macOS jobs are deferred; a configured workflow is not evidence of a platform pass.
