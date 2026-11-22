import { Effect, Schema } from "effect";

const freshnessMs = 120_000;
const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }),
);
const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
const FailureCode = Schema.Literals(["timeout", "rate_limited", "auth_required", "auth_unverified"]);
const Window = Schema.Struct({
  id: Label,
  scope: Label,
  percentLeft: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resetsAt: Schema.NullOr(Timestamp),
});
const measurement = {
  observedAt: Timestamp,
  source: Schema.Literal("provider"),
  windows: Schema.NonEmptyArray(Window),
};
const Fresh = Schema.Struct({
  status: Schema.Literal("fresh"),
  ...measurement,
  validUntil: Timestamp,
}).check(
  Schema.makeFilter(({ observedAt, windows, validUntil }) => {
    const deadline = windows.reduce(
      (earliest, { resetsAt }) => (resetsAt === null ? earliest : Math.min(earliest, Date.parse(resetsAt))),
      Date.parse(observedAt) + freshnessMs,
    );
    return Date.parse(validUntil) === deadline;
  }),
).pipe(Schema.brand("BoundedFreshObservation"));
const Stale = Schema.Struct({
  status: Schema.Literal("stale"),
  ...measurement,
  code: Schema.NullOr(FailureCode),
});
const Unavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  code: FailureCode,
});

const Observation = Schema.Union([Fresh, Stale, Unavailable]);
type FreshObservation = typeof Fresh.Type;
type Observation = typeof Observation.Type;
const Account = Schema.Struct({
  id: Label,
  provider: Schema.Literals(["claude", "codex", "opencode-go"]),
  observation: Observation,
});

function isFreshAt(observation: FreshObservation, now: number): boolean {
  return Date.parse(observation.observedAt) <= now && now < Date.parse(observation.validUntil);
}

const Snapshot = Schema.Struct({
  version: Schema.Literal("subquo.v1"),
  writtenAt: Timestamp,
  accounts: Schema.Array(Account),
}).check(
  Schema.makeFilter(({ accounts, writtenAt }) => {
    if (new Set(accounts.map(({ id }) => id)).size !== accounts.length) return false;
    const writtenAtMs = Date.parse(writtenAt);
    return accounts.every(({ observation }) => {
      if (observation.status === "unavailable") return true;
      if (observation.status === "stale") return Date.parse(observation.observedAt) <= writtenAtMs;
      return isFreshAt(observation, writtenAtMs);
    });
  }),
);

export type Snapshot = typeof Snapshot.Type;

class InvalidSnapshot extends Schema.TaggedError<InvalidSnapshot>()("InvalidSnapshot", {}) {}

const SnapshotJson = Schema.fromJsonString(Snapshot);
const decodeJson = Schema.decodeUnknownEffect(SnapshotJson, { onExcessProperty: "ignore" });
const encodeJson = Schema.encodeUnknownEffect(SnapshotJson, { onExcessProperty: "ignore" });

const invalidSnapshot = () => new InvalidSnapshot();

export function parseSnapshot(json: string): Effect.Effect<Snapshot, InvalidSnapshot> {
  return decodeJson(json).pipe(Effect.mapError(invalidSnapshot));
}

export function serializeSnapshot(input: unknown): Effect.Effect<string, InvalidSnapshot> {
  return Effect.suspend(() => encodeJson(input)).pipe(
    Effect.mapError(invalidSnapshot),
    Effect.catchDefect(() => Effect.fail(invalidSnapshot())),
  );
}

export function observationAt(observation: Observation, now: number): Observation {
  if (observation.status !== "fresh" || isFreshAt(observation, now)) return observation;
  const { observedAt, source, windows } = observation;
  return { status: "stale", observedAt, source, windows, code: null };
}

export function pickEvidenceAt(observation: Observation, now: number): FreshObservation | undefined {
  const current = observationAt(observation, now);
  if (current.status !== "fresh") return undefined;
  return current.windows.every(({ percentLeft, resetsAt }) => percentLeft !== null && resetsAt !== null)
    ? current
    : undefined;
}
