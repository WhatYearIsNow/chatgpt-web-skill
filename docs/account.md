# Account switching

`account` reuses an existing email or Google SSO session in the configured browser.
Email SSO requires a target email. Google accepts either an exact target email or
`--google` alone to use the existing Google session. Success always requires an
email read from a labelled account-settings field. With an explicit target, it must
match that target (ignoring case and surrounding whitespace). Without a target,
the result includes `identityMatch: "observed"`: it reports the signed-in identity
without claiming to match a preselected account.

```sh
node scripts/chatgpt-web.mjs account --email user@example.com --keep-open
node scripts/chatgpt-web.mjs account --email user@example.com --provider google --keep-open
node scripts/chatgpt-web.mjs account --google --keep-open
```

`--google` is an alias for `--provider google`; choose one spelling. The command
does not bundle an account registry, import local account lists, read passwords or
verification codes, or create accounts. It opens its own page. Signing out changes
the shared ChatGPT login session in that browser profile, including other open
ChatGPT pages. Only the command's own page is eligible for cleanup.

Use `--keep-open` to inspect the result or take over a login that requires manual
interaction. Without it, the runner closes its page after success or failure.
`--dry-run` opens a task page and reports the requested account/provider; it does
not sign out, fill login fields or verify SSO availability.

## Interface

```js
import { switchAccount, AccountError } from '../lib/account.mjs';

const result = await switchAccount(page, cdp, sessionId, {
  email: 'user@example.com',
  provider: 'email', // 'email' or 'google'
  timeoutMs: 120000,
  log: console.error,
});
// { email: 'user@example.com', provider: 'email', changed: true, verified: true }
```

The caller supplies its own page and CDP session and owns the task lock and
connection/page lifecycle. The function never enumerates or closes other pages.
When the initial settings email already matches, `changed` is `false` and no
logout/login is attempted. Display names, arbitrary page text and the email
typed into the login form never establish account identity. The Google account
chooser must offer the exact requested email if selection is necessary. Without
a target email, a chooser stops for manual selection; the tool never picks an
arbitrary account. An existing Google session that redirects directly can complete
automatically.

Because an already-matching target returns `changed: false, verified: true`
without attempting a logout, running `account --email TARGET` before a batch is a
side-effect-free identity assertion: it either switches to the target or confirms
the current session already is the target.

The default driver recognizes the existing `/settings/account` route and the
`#settings/Account` account-settings context. It accepts explicit settings email
fields, associated email labels, and the full-page settings Change email control.
If a UI revision hides those fields, the operation fails with `ACCOUNT_IDENTITY_UNVERIFIED`; it does not substitute a
display name. A `driver` and `clock` can be injected for isolated state-machine
tests; they are test boundaries, not a separate browser API.

## Migration from local versions

- Replace `--email ADDRESS --expect DISPLAY_NAME` with `--email ADDRESS`.
- Bare `--google` uses the existing Google session and verifies the observed
  settings email. Add `--email ADDRESS` when exact target matching is required.
- `--expect` is rejected. Its former display-name and whole-page text matching
  could accept the wrong account.
- Other commands' `--account DISPLAY_NAME_FRAGMENT` remains an advisory display
  label check. It does not provide the exact email verification of `account`.
- Personal email/alias lists and observed account limits belong in local runtime
  configuration or records and are excluded from the public package.

## Errors

`AccountError` exposes `code` and `message`. The CLI returns a nonzero exit code
and structured error. These terminal states stop the flow immediately:

| Code | Meaning |
| --- | --- |
| `ACCOUNT_INVALID_ARGUMENT` | Missing/invalid target email (required for email SSO), provider or timeout |
| `ACCOUNT_PASSWORD_REQUIRED` | Password input appeared; continue manually |
| `ACCOUNT_VERIFICATION_REQUIRED` | Verification/code flow appeared; continue manually |
| `ACCOUNT_SIGNUP_REQUIRED` | Registration flow appeared; finish setup manually |
| `ACCOUNT_CHALLENGE_REQUIRED` | Browser challenge requires manual interaction |
| `ACCOUNT_REGION_REQUIRED` | Login reports the current region is unavailable |
| `ACCOUNT_GOOGLE_SELECTION_REQUIRED` | Chooser needs manual selection or the requested email is absent |
| `ACCOUNT_IDENTITY_UNVERIFIED` | Signed-in state appeared but settings email was unavailable |
| `ACCOUNT_MISMATCH` | Settings email differs from the requested email |
| `ACCOUNT_INPUT_FAILED` | Native email input did not match; Continue was untouched |
| `ACCOUNT_UI_CHANGED` | Expected visible login control was unavailable |
| `ACCOUNT_NAVIGATION_FAILED` | CDP reported navigation failure |
| `ACCOUNT_UI_TIMEOUT` / `ACCOUNT_TIMEOUT` | Page response or login state timed out |

## Verification status and live checks

As of 2026-10-24, the complete automated suite passes on Windows Node 22 and 24
(154 tests each), including account state-machine, DOM-probe and native-input
tests. Automated tests never connect to a real site or sign out a local browser.

Authorized live checks through the installed public CLI passed:

- An already-active exact target returned `changed: false`, `verified: true`.
- Bare `--google` switched from the email account through its existing Google
  session and returned `changed: true`, `verified: true`, `identityMatch: "observed"`.
- Email SSO switched back from Google with `changed: true`, `verified: true`,
  matching the explicit target. A separate fresh settings page then independently
  confirmed restoration to this run's initial account.
- 2026-10-25: a 16-image batch completed across two accounts through a loopback
  relay endpoint. After an observed limit the loop stopped; an email-SSO switch
  reported `ACCOUNT_VERIFICATION_REQUIRED` under `--keep-open`, the verification
  code was entered manually, and re-running the same command returned
  `changed: false`, `verified: true`. Resuming the loop while skipping existing
  outputs produced the remaining images without further intervention.

Earlier navigation timeouts were not reproduced in those successful runs; their
precise earlier cause is not claimed to be established. A separate live failure
exposed a form-opening readiness issue: a visible login button did not open the
form on its first click, but did on a later fresh observation. The state machine
now waits for document loading across logout/login transitions and may reobserve
and click the harmless form opener at most four times, waiting up to eight seconds
for each resulting form state within the overall timeout. The fixed live email
flow exercised that retry and completed. Email and Google SSO submissions remain
single attempts. No password or verification code was entered by automation.

The driver can also attempt one owned-target reattachment for a failed read, or
reconcile an already-committed navigation after a timeout. It never repeats a
navigation or SSO submission. A timeout is not evidence that a login did not happen:
inspect the current settings identity before deciding on another run.

These are observed live samples, not guarantees across accounts, site languages,
future UI revisions or every challenge state. See [the verification record](testing.md)
for platform and release limits.

```sh
node --test tests/account.test.mjs
node scripts/chatgpt-web.mjs account --email user@example.com --dry-run --keep-open
```

For an intentional live check, use a browser profile prepared with your own test
accounts and an existing SSO session, then run the real command with
`--keep-open`. Confirm the following outcomes in the browser and CLI:

1. The already-active target returns `changed: false` without navigating to logout.
2. Switching from a different account returns `changed: true`, `verified: true`
   and the expected email visible in account settings.
3. Repeat with `--provider google`; if a chooser appears, only the exact requested
   email is selected.
4. A password, verification or registration requirement produces the corresponding
   error and stops; the kept page remains available for manual login. No password
   or code is entered.
5. A missing settings email fails explicitly. Unrelated browser pages remain open.

Record the date, browser/runtime versions, provider, result/error code and selector
compatibility when documenting a live check. Public verification reports should
use synthetic account labels and omit actual addresses, account/session IDs and
browser-profile paths.
