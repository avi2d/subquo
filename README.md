# subquo

subquo reads how much quota is left on each paid AI coding subscription a person names, such as Claude, OpenAI Codex and OpenCode Go accounts.
It writes each account's windows, percent left and reset times into one snapshot file.
A scheduler, a dashboard or a launch guard then reads the same data.
You can collect and read snapshots beside your existing quota tools without changing any reader.

## Before you begin

- Bun.
- Linux x64 or macOS arm64 for the compiled executable.

## Install

To install subquo:

1. Add the package:

   ```sh
   bun add @avi2dg/subquo
   ```

1. Run the command:

   ```sh
   bunx subquo read
   ```

The command runs from source when the compiled executable is unavailable.

## Run beside your quota tools

[Collect snapshots and renew idle logins](docs/shadow-run.md) on each machine where the vendors saved logins.

## Check a change

To run the checks a pull request runs, clone the repository and install dependencies with the Bun version in `.bun-version`.
Run `bun install` from the repository root, then follow these steps:

1. Run oxlint and every gate of the checks kit:

   ```sh
   bun run lint
   ```

1. Run the type check and the Effect diagnostics:

   ```sh
   bun run typecheck
   ```

1. Run the tests:

   ```sh
   bun run test
   ```

A passing lint ends with `checks-lint: <count> gate(s) pass`.

## Where things are

| Path | What it holds |
| --- | --- |
| `VISION.md` | what subquo is for and what it refuses |
| `docs/design.md` | the reader and snapshot design, with its open questions |
| `docs/accounts.md` | the private account list format and a copyable example |
| `docs/stage-1-findings.md` | what the login checks show about expiry, setup tokens and renewal |
| `src/index.ts` | the snapshot schema and the helpers that read, write and check its age |
| `src/cli.ts` | the `refresh` and `read` commands |
| `tests/unit/` | tests |
| `tests/fixtures/snapshots/` | sample snapshots with made-up accounts |
| `templates/` | the page templates a new doc starts from |
| `.github/workflows/` | the CI callers the checks kit writes |

## Related topics

- [The quota snapshot design](docs/design.md)
- [The account list](docs/accounts.md)
- [Stage 1 findings](docs/stage-1-findings.md)
- [The checks kit](https://github.com/avi2d/checks)
