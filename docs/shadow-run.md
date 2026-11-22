---
kind: how-to
---
# Run subquo beside your quota tools

Run subquo on each machine where the vendors saved logins.
Keep orc and firstmate on their existing readers until the staged switch.

## Before you begin

- A working copy with [dependencies installed](../README.md#install).
- The vendor's own CLI on `PATH` if you need to ask it to renew a login.

## Collect and read a snapshot

1. Fill in the [private account list](accounts.md) on each machine.
1. From the working copy, run `bun run subquo refresh`.
1. Run `bun run subquo read --json` to see the saved snapshot.
1. Use your existing tools to check the readings for the same accounts and windows.
1. To repeat the collection, have your machine's scheduler run `bun run subquo refresh` from the working copy every 60 seconds.

Each collector reads only the login named for that account and sends it only to that vendor's usage address.
No other quota reader is required on the machine.
The snapshot lives under `$XDG_STATE_HOME/subquo` or, if that variable is unset, under `~/.local/state/subquo`.

## Ask a vendor to renew an idle login

1. Check that the account is idle and that no worker or other tool will use or renew it while the command runs.
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
