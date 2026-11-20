---
kind: reference
---

# Stage 1 findings

These checks cover login records for Claude Code, Codex, and OpenCode Go on macOS and WSL.

## Login records

On each machine, a TOML parser read back four distinct entries from the private account list.
Both files had mode `0600`.
The two macOS Claude Code configuration directories mapped to distinct Keychain items.
On WSL, both Claude Code login files existed, but `claude auth status` reported that only one account was signed in.
A login locator can exist even when the vendor CLI reports that the account is signed out.

The Codex login files contained a `tokens` key, and the OpenCode login files contained an `opencode-go` key.
Those checks confirm the storage format, not that the provider still accepts the credentials.

## Claude Code access-token expiry

Both macOS entries had about eight hours between the Keychain item's last modification and the expiry of its current access token.
The measurements are from 2026-11-20, and all times are UTC.

| Sample | Keychain item last modified | Stored access-token expiry | State at 12:36 |
| --- | --- | --- | --- |
| Account A | 06:28:34 | 14:28:34 to 14:28:35 | Not expired |
| Account B | 04:10:06 | 12:10:06 to 12:10:07 | Expired |

The start comes from the Keychain item's modification metadata, not a separate token issuance field.
The end comes from the [read-only `quota-axi auth` check](https://github.com/kunchenguid/quota-axi/blob/1f5875c3f3ebf09b0fa04e124e9f395fcec68b25/src/providers/claude.ts), which compares the stored `expiresAt` field with the current time.
Each check used the account's own configuration directory.
A process-local clock bracketed the point at which the check changed from `available` to `expired`.
The checks also ran with the real clock, and the Keychain item modification times did not change during measurement.

The eight-hour intervals describe two access tokens, not the lifetime of either sign-in.
On macOS, `claude auth status` reported both accounts signed in even though one access token had already expired.
The overall sign-in lifetime and refresh-token expiry were not measured.

## Setup-token output

`claude setup-token` prints a one-year OAuth token, not subscription quota windows or reset times.
The [Claude Code command contract](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) describes this output.
The check did not mint a new token.
Anthropic documents that the token can make only model requests.
The [Messages API response](https://platform.claude.com/docs/en/api/messages) reports token counts for the request, not the subscription's remaining quota.

## Renewal

No renewal ran.
The check inspected the scheduler and running processes on both machines before considering a renewal.
The [`quota-axi` renewal delegate](https://github.com/kunchenguid/quota-axi/blob/1f5875c3f3ebf09b0fa04e124e9f395fcec68b25/src/providers/claude.ts) documents that Claude Code clears the saved session if Anthropic rejects its refresh token.
An idle account would still face that risk, so the check stopped before starting `claude doctor`.
