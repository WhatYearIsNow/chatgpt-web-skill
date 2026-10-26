# Migrating local installations

This public release intentionally keeps personal runtime state out of its source tree. It is not an in-place account/database installer.

1. Stop all old ChatGPT automation processes before switching versions. The old temporary JSON file lock and the new OS-owned lock do not coordinate each other. Do not run old and new task binaries concurrently.
2. Back up your local skill and its `data/` directory privately. Keep old account lists, reviews, conversation URLs and test outputs out of the public checkout.
3. Set `CHATGPT_WEB_DATA_DIR` to a private local directory. If preserving history, copy only your own `usage.jsonl` and `quota-state.json` there, validate them locally, and retain the backup. Corrupt or incompatible data now fails instead of being ignored. This release does not merge or rewrite your history automatically.
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

Since 0.3.0 the file also accepts managed-browser keys: `chromePath` (executable
hint for the isolated managed browser), `headless` (boolean) and `managed`
(boolean, set `false` to restore the 0.2.x behavior of failing when no endpoint
is configured). With none of `endpoint`/`browserModule` present and `managed`
not disabled, the CLI launches a dedicated managed browser under
`<data dir>/browser` whose first interactive login persists and is reused;
configure an explicit `endpoint` to keep using an existing browser instead.

Since the next patch, `browser status|start|login|stop` follows this same policy.
`status` only reports the selected connection; it does not connect, verify a
profile or open a browser. `start` checks an existing endpoint/adapter, and
`login` opens its own login tab there. Neither silently launches a managed
browser on connection failure. `stop` never shuts down an external browser.
Use `browser ... --managed` only when explicitly selecting the isolated managed
instance, including to inspect or stop a previously launched one.

To pin an existing browser profile, add `profilePath` with its absolute path
from `chrome://version` to your private configuration. For example, generate
the file locally, substituting the actual selected profile directory:

```powershell
$profilePath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Profile 4'
@{ endpoint = 'ws://127.0.0.1:9333'; profilePath = $profilePath; managed = $false } |
  ConvertTo-Json | Set-Content -Encoding utf8NoBOM (Join-Path $env:LOCALAPPDATA 'chatgpt-web\config.json')
```

This is a per-machine choice, not a bundled default or browser launcher. Check
existing configuration before changing it. Each new task tab first reads the
browser's Profile Path on its internal version page, then navigates that same
verified tab. A missing/unreadable path or mismatch stops the task before site
navigation (`PROFILE_UNVERIFIED` or `PROFILE_MISMATCH`); only its owned tab is
closed. It never reads cookies or copies a profile. A pin requires an endpoint
or adapter and cannot silently become a managed launch directory.

An explicit `CHATGPT_WEB_CDP_URL`/`CHATGPT_WEB_BROWSER_MODULE` replaces the whole
saved connection, including its pin, when intentionally selecting another
browser. `CHATGPT_WEB_PROFILE_PATH` can supply a pin for that explicit connection.
Changing `CHATGPT_WEB_DATA_DIR` also selects a different configuration namespace;
carry your connection policy into that directory when it should still apply.
