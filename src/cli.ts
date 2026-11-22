#!/usr/bin/env -S bun --no-env-file
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Path, Schema, Stdio, Stream } from "effect";
import { loadAccounts } from "./accounts";
import { readAccount } from "./collectors";
import { collectSnapshot } from "./collect";
import { renewIdleLogin } from "./renewal";
import { readSnapshotJson, withStateLock, writeSnapshot } from "./storage";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {}) {}

const writeLine = Effect.fnUntraced(function*(line: string, output: "stdout" | "stderr") {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio[output]()));
});

const statePaths = Effect.fnUntraced(function*(home: string, stateHome: string | undefined) {
  const path = yield* Path.Path;
  const state = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(home, ".local", "state");
  const directory = path.join(state, "subquo");
  return {
    accounts: path.join(home, ".config", "subquo", "accounts.toml"),
    lock: path.join(directory, "refresh.sqlite"),
    snapshot: path.join(directory, "snapshot.json"),
    renewalLock: path.join(directory, "renewal.sqlite"),
  };
});

const run = Effect.fnUntraced(function*(home: string, stateHome: string | undefined, executablePath: string | undefined) {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const [command, flag, id] = args;
  const path = yield* Path.Path;
  if (!path.isAbsolute(home)) {
    yield* writeLine("An absolute HOME is required.", "stderr");
    return yield* new CommandFailed();
  }
  const files = yield* statePaths(home, stateHome);

  if (command === "read" && flag === "--json" && args.length === 2) {
    const json = yield* readSnapshotJson(files.snapshot).pipe(
      Effect.tapError(() => writeLine("No readable subquo snapshot.", "stderr")),
    );
    return yield* writeLine(json, "stdout");
  }

  if (command === "refresh" && args.length === 1) {
    return yield* withStateLock(files.lock, Effect.gen(function*() {
      const { accounts } = yield* loadAccounts(files.accounts);
      const snapshot = yield* collectSnapshot(accounts.map((account) => ({
        id: account.id, provider: account.provider, read: readAccount(account),
      })));
      yield* writeSnapshot(files.snapshot, snapshot);
    })).pipe(Effect.tapError(() => writeLine("Could not refresh subquo. Check the account list and state directory.", "stderr")));
  }

  if (command === "refresh" && flag === "--renew-idle" && args.length === 3) {
    const { accounts } = yield* loadAccounts(files.accounts).pipe(
      Effect.tapError(() => writeLine("Could not read the subquo account list.", "stderr")),
    );
    const account = accounts.find((entry) => entry.id === id);
    if (account === undefined) {
      yield* writeLine("Not an enrolled subquo account.", "stderr");
      return yield* new CommandFailed();
    }
    const result = yield* withStateLock(files.renewalLock, Effect.gen(function*() {
      yield* Effect.sleep(45_000).pipe(
        Effect.andThen(writeLine("The vendor tool is still running. Let it finish before you retry.", "stderr")),
        Effect.orElseSucceed(() => undefined),
        Effect.interruptible,
        Effect.forkScoped,
      );
      return yield* Effect.uninterruptible(renewIdleLogin(account, { HOME: home, PATH: executablePath }));
    }).pipe(Effect.scoped));
    if (result.status === "busy") {
      yield* writeLine("A renewal is already running.", "stderr");
      return yield* new CommandFailed();
    }
    yield* writeLine(result.value, "stdout");
    if (result.value === "auth_required" || result.value === "auth_unverified") return yield* new CommandFailed();
    return;
  }

  yield* writeLine("Usage: subquo refresh [--renew-idle <account>] | subquo read --json", "stderr");
  return yield* new CommandFailed();
});

BunRuntime.runMain(run(Bun.env.HOME ?? "", Bun.env.XDG_STATE_HOME, Bun.env.PATH).pipe(
  Effect.provide(BunServices.layer),
), { disableErrorReporting: true });
