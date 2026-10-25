# Reporting issues

Report reproducible bugs with the command name, Node/browser versions, error code and a minimal synthetic fixture. Remove email addresses, conversation IDs, cookies, local file paths, account labels and prompt text from logs before sharing.

Do not post secrets in a public issue. For a sensitive finding, use the repository's private vulnerability reporting feature once the maintainer enables it. No private reporting address is bundled in this release.

The CDP endpoint provides extensive control of its browser profile. This tool accepts only loopback endpoints and never copies browser profiles or exports authentication material. An explicit external adapter is executable local configuration and must be trusted.

When no endpoint is configured, the managed browser is an isolated dedicated profile under the private data directory (`<data dir>/browser`), launched with an ephemeral loopback debug port. The user's default browser and its profiles are never read, copied or modified; the managed profile holds its own ChatGPT login state, so treat the private data directory as sensitive — it authenticates the configured account. Shut it down with `browser stop` when the machine is shared. A configured-but-unreachable endpoint is an error, never a trigger to launch a fallback browser.

The mutex coordinates processes on one host. It is not a distributed lock for shared network storage. Hash collisions or an unrelated listener can block work; they do not authorize stealing the lock. Runtime records should remain in a private local data directory.
