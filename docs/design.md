---
kind: explanation
---
# The quota snapshot design

subquo splits collecting quota from reading it, so a tool that picks an account reads one local file and never waits on a vendor.
No reader code exists yet, and every number below is a starting target, not a measurement.

## Two commands

`subquo refresh` reads every account the account list names and writes a new snapshot.
A scheduler the machine already has runs it, every 60 seconds to start.
It reads accounts side by side under a concurrency cap.
Each account has a 5 second limit, and the whole refresh has a 10 second limit, so one slow vendor times out alone.
It replaces the snapshot file whole, so a killed refresh never leaves half a file.
When another refresh holds the lock, it skips its turn instead of queueing.
On a rate limit it waits for the retry time the vendor sends.

`subquo read --json` prints the last complete snapshot.
It never contacts the network, waits on a lock or triggers a refresh.
Its deadline is one second, with 200 milliseconds as the normal target.

## The account list

Each machine keeps a private account list that names every paid account, its provider and where its saved login lives.
It holds places, never secrets, and it never leaves the machine.
A named account whose login is missing shows as login needed, and subquo never reads another account's login in its place.
Two logins of one subscription count once only when the vendor's identity proves it, never from an email, a label or a matching token.

## The snapshot

The JSON snapshot holds a `version` of `subquo.v1`, a `writtenAt` time, and an array of `accounts`.
Each account has a unique `id`, a `provider`, and an `observation`.
An enrolled account that cannot be read stays in the snapshot with its reason.

| Observation `status` | What it holds | What a reader may do with it |
| --- | --- | --- |
| `fresh` | `observedAt`, `validUntil`, `source`, and at least one window | treat a current reading with known values as evidence for a pick, not as permission |
| `stale` | `observedAt`, `source`, the last observed windows, and a safe `code` or `null` | show it with `observedAt`, never pick from it |
| `unavailable` | a safe `code`: `timeout`, `rate_limited`, `auth_required`, or `auth_unverified` | claim no capacity |

The two auth codes mean login needed and login unchecked, respectively.
A stale reading without a failed refresh has a `null` code.
A window holds `id`, `scope`, `percentLeft`, and `resetsAt`.
A measured percent is a finite number from 0 to 100.
An unknown percent or reset is `null`.
A reset time is never filled in from a login's expiry or a plan's name.
Times are UTC strings with millisecond precision, such as `2030-01-01T00:00:00.000Z`.

The deadline is the earlier of 120 seconds after `observedAt` and the first known window reset.
At the deadline, the reading becomes stale.
Recheck the reading's age at the time of use, even if the file marks it `fresh`.
The pick helper rejects unknown percentages and resets.
After a reset, subquo waits for a new reading rather than assuming the window is full again.

The account ID comes from the private account list.
Window IDs and scopes are labels the reader assigns, not text taken from vendor replies.
These labels use 1 to 64 lowercase letters, digits, hyphens, or underscores and start with a letter or digit.
The snapshot codec drops fields not in the schema and returns `InvalidSnapshot` without the input if validation fails.
See the [fresh sample](../tests/fixtures/snapshots/fresh.json) and the [sample with missing readings](../tests/fixtures/snapshots/incomplete.json).

## Headroom is the smallest limit

An account's usable headroom is the smallest of the limits that apply to a job, never their sum.
With 40% left in a five-hour window and 12% left in a weekly window, the headroom is 12%.
A window that covers only one kind of work, such as code review, does not limit other jobs.
A limit with an unknown value leaves the headroom unknown.

## Logins

Each vendor's own tool signs in, saves the login and renews it.
subquo reads a saved login into memory, sends it only to that vendor's usage address and forgets it after the read.
It never renews a login, because two programs rewriting one login at once can sign out a running worker.
An idle account whose short pass expired reads as login unchecked, which is not proof of a sign-out.
An account whose renewal fails reads as login needed, and only its owner signing in again clears it.

## Secrets

Output holds only listed fields and safe error codes, never a vendor's response body.
No token reaches standard output, standard error, the snapshot, diagnostics, process arguments or test files.
Tests plant fake tokens and check that no success or failure path prints them.

## Reused code

Other MIT-licensed quota readers already parse these vendors' responses.
ccstatusline selects a named Claude login and parses its usage replies.
opencode-quota holds small OpenCode Go and Codex parsing functions.
CodexBar serves as a cross-check of response shapes and account boundaries.
subquo copies only small parts, keeps their licence notices and names the source in the commit.

## Open questions

The design sources leave these open:

- How long an ordinary Claude sign-in lives, since Anthropic does not publish the length.
- Whether the replies to a long-lived Claude token carry usage, which would let subquo read without the ordinary sign-in.
- Whether macOS asks for permission the first time subquo reads a login from the Keychain.
- Whether OpenCode Go still issues a pasted key, and which login store an owner's Go account uses.
- How long the Claude, ChatGPT and OpenCode usage addresses keep their response shapes, since none of them is a published contract.
- Which refresh interval the vendors' rate limits allow, after measuring them.
- Where the account list lives and which format it takes.
- Whether the repository stays named subquo, since the design reports call the tool subscription-quota.

## Related topics

- [Vision](../VISION.md)
