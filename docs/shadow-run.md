---
kind: how-to
---
# Run subquo beside your quota tools

Run subquo on each machine where the vendors saved logins.

## Before you begin

- A working copy with [dependencies installed](../README.md#install).
- The vendor's own CLI on `PATH` if you need to ask it to renew a login.

## Collect and read a snapshot

To collect quota for the accounts on this machine:

1. Fill in the [private account list](accounts.md) on each machine.
1. From the working copy, run `bun run subquo refresh`.
1. Run `bun run subquo read --json` to see the saved snapshot.
1. Have your machine's scheduler run `bun run subquo refresh` from the working copy every 60 seconds.

Each collector reads only the login named for that account and sends it only to that vendor's usage address.
No other quota reader is required on the machine.
The snapshot lives under `$XDG_STATE_HOME/subquo` when `XDG_STATE_HOME` is an absolute path.
Otherwise, it lives under `~/.local/state/subquo`.
Run `bun run subquo read` to see the sign-in countdown as of the time the snapshot was written.
If the saved Claude login gave no usable refresh-token expiry, the command shows `login end unknown`.
If the saved Claude sign-in has already ended, the command shows `login has ended` and still lists the quota it read.

## Ask a vendor to renew an idle login

To ask the vendor's tool to renew a saved login:

1. Make sure the account is idle.
1. Keep other tools from using or renewing the account while the command runs.
1. Run `bun run subquo refresh --renew-idle <account>` with the account ID from your private list.
1. If the command reports `renewed`, run `bun run subquo refresh` and read the next snapshot.

Do not schedule the renewal command alongside the collection job.
It starts Claude Code or Codex only with a saved, expired access token.
OpenCode Go uses a key and has no renewal step.
If the vendor takes longer than 45 seconds, leave it running so it can finish writing its own login.
If it reports `auth_required`, use the vendor's sign-in command yourself.
If it reports `auth_unverified`, check the selected login with the vendor's tool before trying again.

## Related topics

- [Account list](accounts.md)
- [The quota snapshot design](design.md)
