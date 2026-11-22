import { Database, SQLiteError } from "bun:sqlite";
import { Effect, FileSystem, Path, Schema } from "effect";
import { parseSnapshot, serializeSnapshot, type Snapshot } from "./index";

class SnapshotUnavailable extends Schema.TaggedError<SnapshotUnavailable>()("SnapshotUnavailable", {}) {}
class StateUnavailable extends Schema.TaggedError<StateUnavailable>()("StateUnavailable", {}) {}

const snapshotUnavailable = () => new SnapshotUnavailable();
const stateUnavailable = () => new StateUnavailable();

export const readSnapshotJson = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.mapError(snapshotUnavailable));
  if (info.type !== "File") return yield* snapshotUnavailable();
  const json = yield* fs.readFileString(file).pipe(Effect.mapError(snapshotUnavailable));
  const snapshot = yield* parseSnapshot(json);
  return yield* serializeSnapshot(snapshot);
}, Effect.timeoutOrElse({ duration: 900, orElse: () => Effect.fail(snapshotUnavailable()) }));

export const writeSnapshot = Effect.fnUntraced(function*(file: string, snapshot: Snapshot) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const json = yield* serializeSnapshot(snapshot);
  const temporaryDir = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(file), prefix: ".snapshot-" });
  const temporaryFile = path.join(temporaryDir, "snapshot");
  yield* fs.writeFileString(temporaryFile, `${json}\n`, { flag: "wx", mode: 0o600 });
  yield* fs.rename(temporaryFile, file);
}, Effect.scoped);

export const withStateLock = Effect.fnUntraced(function*<A, E, R>(lockfile: string, work: Effect.Effect<A, E, R>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(lockfile), { recursive: true, mode: 0o700 });
  const db = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Database(lockfile), catch: stateUnavailable }),
    (connection) => Effect.sync(() => connection.close()),
  );
  class StateBusy extends Schema.TaggedError<StateBusy>()("StateBusy", {}) {}
  const acquired = yield* Effect.try({
    try: () => {
      db.run("PRAGMA busy_timeout = 0");
      db.run("BEGIN IMMEDIATE");
      return true;
    },
    catch: (error) => error instanceof SQLiteError && error.code === "SQLITE_BUSY" ? new StateBusy() : stateUnavailable(),
  }).pipe(Effect.catchTag("StateBusy", () => Effect.succeed(false)));
  if (!acquired) return { status: "busy" } as const;
  return { status: "complete", value: yield* work } as const;
}, Effect.scoped);
