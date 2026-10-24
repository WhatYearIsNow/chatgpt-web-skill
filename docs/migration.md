# Migrating local installations

This public candidate intentionally keeps personal runtime state out of its source tree. It is not an in-place account/database installer.

1. Stop all old ChatGPT automation processes before switching versions. The old temporary JSON file lock and the new OS-owned lock do not coordinate each other. Do not run old and new task binaries concurrently.
2. Back up your local skill and its `data/` directory privately. Keep old account lists, reviews, conversation URLs and test outputs out of the public checkout.
3. Set `CHATGPT_WEB_DATA_DIR` to a private local directory. If preserving history, copy only your own `usage.jsonl` and `quota-state.json` there, validate them locally, and retain the backup. Corrupt or incompatible data now fails instead of being ignored. This candidate does not merge or rewrite your history automatically.
4. Configure `CHATGPT_WEB_CDP_URL` or a trusted `CHATGPT_WEB_BROWSER_MODULE`. The implicit relative import of a neighboring browser skill was removed. Keep the prior installation available until the selected browser connection and consumers are verified.
5. Test `--help`, `quota --tail 1`, and a harmless `ask`/`followup` before using a real attachment or spending image quota.

## CLI differences

- Six existing script filenames remain; the unified command is `scripts/chatgpt-web.mjs COMMAND`.
- Prompts require exactly one of `--prompt` or `--prompt-file`; unknown, duplicate or missing-value options now fail.
- JSON success results use `outputs` rather than only top-level `out`/`text` fields. Consumers parsing those fields need adjustment; consumers forwarding exit status/output paths may continue unchanged.
- `--keep-tab` aliases `--keep-open`. Both preserve only the task's own tab.
- `--dry-run` prepares a real composer and uploads explicitly supplied attachments, but never sends. For images it prepares one candidate even if more were planned. For account it does not sign out or attempt SSO.
- Errors include structured codes; exit 2 means invalid usage, 3 quota denial, 4 uncertain send. Do not automatically retry exit 4 or a response with `sent: "unknown"`.
- Email SSO requires `--email`; `--google` can use the existing Google session and report its observed settings email. `--expect` is no longer accepted. See [account.md](account.md).
- No temporary diagnostic scripts that clear root tabs, dump page contents, or bypass the shared lifecycle are included.

The open-source tree can be reviewed independently without overwriting a working personal installation.

## Persistent local configuration

When no explicit connection option or environment variable is supplied, the CLI
reads `config.json` in its private runtime data directory. Example:

```json
{"endpoint":"http://127.0.0.1:9222"}
```

Alternatively set `browserModule` to an absolute path to your trusted adapter.
Environment variables or explicit connection arguments take precedence over the
entire persisted connection configuration. Malformed configuration fails closed.
The repository/current directory is never searched for this private file.
