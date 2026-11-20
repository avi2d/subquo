# Project agent memory

subquo reads the quota left on paid AI coding accounts into one snapshot, and `README.md` holds what a person reads.
`VISION.md` holds what subquo is for and what it refuses, so read it before adding scope.

## Before you change a part

- The snapshot, a reader or a login read: read [The quota snapshot design](docs/design.md) first, and keep its open questions open until a source settles them.
- A doc page: start from its template in `templates/`, and read [checks-docs](https://github.com/avi2d/checks/blob/main/docs/gates/checks-docs.md) for the rules.
- A workflow: rewrite the callers with `bunx checks-workflows --write`, and never edit `.github/workflows/` by hand.
- A check: run `bun run lint` and `bun run typecheck` before a pull request.

## Public repository

- No token, login path, account name or machine name goes into a file, a fixture or a log, as [Secrets](docs/design.md#secrets) says.
