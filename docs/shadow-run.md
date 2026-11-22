---
kind: how-to
---
# Run subquo beside your quota tools

Run subquo on each machine where you already use clauth and quota-axi.
Keep orc and firstmate on their existing readers.

## Before you begin

- A working copy with [dependencies installed](../README.md#install).
- quota-axi on `PATH`, with support for `--profile-only` and `--no-credential-refresh`.
- On macOS, a clauth status file with a named profile for each enrolled Claude account.
- The vendor's own CLI on `PATH` if you need to ask it to renew a login.

## Collect and read a snapshot

1. Fill in the [private account list](accounts.md) on each machine.
1. From the working copy, run `bun run subquo refresh`.
1. Run `bun run subquo read --json` to see the saved snapshot.
1. Use your existing tools to check the readings for the same accounts and windows.
1. To repeat the collection, have your machine's scheduler run `bun run subquo refresh` from the working copy every 60 seconds.

On macOS, the Claude bridge uses the named clauth profiles and keeps their original reading times.
For file-based Claude and Codex logins, it tells quota-axi to use only the named login directory.
For OpenCode Go, it points quota-axi at the named OpenCode data directory without enabling Pi as a source.
The snapshot lives under `$XDG_STATE_HOME/subquo` or, if that variable is unset, under `~/.local/state/subquo`.

## Ask a vendor to renew an idle login

1. Check that the account is idle and that no worker or other tool will use or renew it while the command runs.
1. Run `bun run subquo refresh --renew-idle <account>` with the account ID from your private list.
1. If the command reports `renewed`, run `bun run subquo refresh` and read the next snapshot.

Do not schedule the renewal command alongside the collection job.
It checks for a saved, expired access token with a refresh token before starting Claude Code or Codex.
OpenCode Go uses a key and has no renewal step.
If the vendor takes longer than 45 seconds, leave it running so it can finish writing its own login.
If it reports `auth_required`, use the vendor's sign-in command yourself.
If it reports `auth_unverified`, check the selected login with the vendor's tool before trying again.

## Related topics

- [Account list](accounts.md)
- [The quota snapshot design](design.md)
