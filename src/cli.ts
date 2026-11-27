#!/usr/bin/env -S bun --no-env-file
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Effect, Path, Schema, Stdio, Stream } from "effect";
import { loadAccounts } from "./accounts";
import { readAccount } from "./collectors";
import { collectSnapshot } from "./collect";
import { type Snapshot, observationAt, serializeSnapshot } from "./index";
import { renewIdleLogin } from "./renewal";
import { readSnapshot, withStateLock, writeSnapshot } from "./storage";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {}) {}

const writeLine = Effect.fnUntraced(function*(line: string, output: "stdout" | "stderr") {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio[output]()));
});

function loginNotice(days: Snapshot["accounts"][number]["loginEndsInDays"]): string {
  if (days === undefined) return "";
  if (days === null) return ", login end unknown";
  if (days === 0) return ", login has ended";
  return days === 1 ? ", login ends in 1 day" : `, login ends in ${days} days`;
}

function renderAccount(account: Snapshot["accounts"][number], now: number): string[] {
  const observation = observationAt(account.observation, now);
  const reason = observation.status === "fresh" || observation.code === null ? "" : ` (${observation.code})`;
  const heading = `${account.id}: ${observation.status}${reason}${loginNotice(account.loginEndsInDays)}`;
  if (observation.status === "unavailable") return [heading];
  return [heading, ...observation.windows.map(({ id, percentLeft, resetsAt }) => {
    const percent = percentLeft === null ? "unknown" : `${percentLeft}% left`;
    return `  ${id}: ${percent}, resets at ${resetsAt ?? "an unknown time"}`;
  })];
}

function renderSnapshot(snapshot: Snapshot, now: number): string {
  return [`Snapshot written at ${snapshot.writtenAt}`, ...snapshot.accounts.flatMap((account) => renderAccount(account, now))].join("\n");
}

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

const renew = Effect.fnUntraced(function*(
  files: { readonly accounts: string; readonly renewalLock: string },
  id: string | undefined,
  env: { readonly HOME: string; readonly PATH: string | undefined },
) {
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
      Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
      Effect.interruptible,
      Effect.forkScoped,
    );
    return yield* Effect.uninterruptible(renewIdleLogin(account, env));
  }).pipe(Effect.scoped));
  if (result.status === "busy") {
    yield* writeLine("A renewal is already running.", "stderr");
    return yield* new CommandFailed();
  }
  yield* writeLine(result.value, "stdout");
  if (result.value === "auth_required" || result.value === "auth_unverified") return yield* new CommandFailed();
});

const run = Effect.fnUntraced(function*(home: string, stateHome: string | undefined, executablePath: string | undefined) {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const [command, flag, id] = args;
  if (command === "--help" && args.length === 1) {
    return yield* writeLine("Usage: subquo refresh [--renew-idle <account>] | subquo read [--json]", "stdout");
  }
  const path = yield* Path.Path;
  if (!path.isAbsolute(home)) {
    yield* writeLine("An absolute HOME is required.", "stderr");
    return yield* new CommandFailed();
  }
  const files = yield* statePaths(home, stateHome);

  if (command === "read" && (args.length === 1 || (flag === "--json" && args.length === 2))) {
    const snapshot = yield* readSnapshot(files.snapshot).pipe(
      Effect.tapError(() => writeLine("No readable subquo snapshot.", "stderr")),
    );
    const now = yield* Clock.currentTimeMillis;
    const output = flag === "--json" ? yield* serializeSnapshot(snapshot) : renderSnapshot(snapshot, now);
    return yield* writeLine(output, "stdout");
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
    return yield* renew(files, id, { HOME: home, PATH: executablePath });
  }

  yield* writeLine("Usage: subquo refresh [--renew-idle <account>] | subquo read [--json]", "stderr");
  return yield* new CommandFailed();
});

// The mutation runner imports every mutated module before the tests, so an unguarded entry runs the CLI inside the test process.
if (import.meta.main) {
  BunRuntime.runMain(run(Bun.env.HOME ?? "", Bun.env.XDG_STATE_HOME, Bun.env.PATH).pipe(
    Effect.provide(BunServices.layer),
  ), { disableErrorReporting: true });
}
