import { DateTime, Effect, Schema } from "effect";
import { clauthProfileName, type EnrolledAccount } from "./accounts";
import { observationAt, type Account, type QuotaWindow, type Snapshot } from "./index";
import { claudeModelScope } from "./usage";

const ClAuthTime = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u))
  .pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));
const ClAuthWindow = Schema.Struct({
  label: Schema.NonEmptyString,
  utilization_pct: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resets_at: Schema.NullOr(ClAuthTime),
});
const ClAuthProfile = Schema.Struct({
  name: Schema.NonEmptyString,
  harness: Schema.optionalKey(Schema.String),
  provider: Schema.String,
  base_url: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
  fetched_at: Schema.NullOr(ClAuthTime),
  windows: Schema.Array(ClAuthWindow),
});
const ClAuthStatus = Schema.Struct({
  schema: Schema.Literals([1, 2]),
  generated_at: ClAuthTime,
  profiles: Schema.Array(ClAuthProfile),
});

class InvalidClAuthStatus extends Schema.TaggedError<InvalidClAuthStatus>()("InvalidClAuthStatus", {}) {}
const decodeClAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(ClAuthStatus));
type ClAuthStatus = typeof ClAuthStatus.Type;
type ClAuthProfile = typeof ClAuthProfile.Type;

export function parseClAuthStatus(input: string): Effect.Effect<ClAuthStatus, InvalidClAuthStatus> {
  return decodeClAuth(input).pipe(Effect.mapError(() => new InvalidClAuthStatus()));
}

const tolerancePoints = 1;
const maxReportAgeMs = 120_000;
type WindowIdentity = Pick<QuotaWindow, "id" | "scope">;
type Measure = Pick<QuotaWindow, "percentLeft" | "resetsAt"> & { readonly status: "fresh" | "stale" };
type ClaudeAccount = Extract<EnrolledAccount, { readonly provider: "claude" }>;
type CompareAccount = Pick<ClaudeAccount, "id" | "clauth_profile">;
type Row = { readonly window: string; readonly subquo?: Measure; readonly clauth?: Measure; readonly differentWindow?: true };

function clauthIdentity(label: string): WindowIdentity | undefined {
  if (label === "5h") return { id: "five-hour", scope: "all" };
  if (label === "7d") return { id: "weekly", scope: "all" };
  return label.startsWith("7d ") ? claudeModelScope(label.slice(3)) : undefined;
}

function clauthWindows(profile: ClAuthProfile, reportAt: number, now: number) {
  const fetchedAt = profile.fetched_at === null ? undefined : DateTime.toEpochMillis(profile.fetched_at);
  const stale = profile.stale || fetchedAt === undefined || fetchedAt > reportAt
    || reportAt > now || now - fetchedAt >= maxReportAgeMs;
  return profile.windows.map(({ label, utilization_pct, resets_at }) => ({
    identity: clauthIdentity(label),
    measure: {
      status: stale || (resets_at !== null && DateTime.toEpochMillis(resets_at) <= now) ? "stale" : "fresh",
      percentLeft: utilization_pct === null ? null : 100 - utilization_pct,
      resetsAt: resets_at === null ? null : DateTime.formatIso(resets_at),
    } satisfies Measure,
  }));
}

function nameWindow({ id, scope }: WindowIdentity): string {
  return scope === "all" ? id : `${id}/${scope}`;
}

function subquoWindows(account: Account | undefined, now: number) {
  if (account === undefined) return [];
  const observation = observationAt(account.observation, now);
  if (observation.status === "unavailable") return [];
  return observation.windows.map((window) => ({
    identity: nameWindow(window),
    measure: { ...window, status: observation.status } satisfies Measure,
  }));
}

function accountRows(own: ReturnType<typeof subquoWindows>, baseline: ReturnType<typeof clauthWindows>): Row[] {
  const matched = new Set<Measure>();
  const rows: Row[] = [];
  for (const { identity, measure } of own) {
    const candidates = baseline.filter((item) => item.identity && nameWindow(item.identity) === identity);
    const [match] = candidates;
    if (candidates.length === 1) {
      matched.add(match.measure);
      rows.push({ window: identity, subquo: measure, clauth: match.measure });
    } else {
      rows.push({
        window: identity, subquo: measure, ...(candidates.length === 0 ? {} : { differentWindow: true }),
      });
    }
  }
  const unmatched = baseline.flatMap(({ identity, measure }, index): Row[] => {
    if (matched.has(measure)) return [];
    return [{
      window: identity === undefined ? `unmapped-clauth-${index + 1}` : nameWindow(identity),
      clauth: measure,
      ...(identity === undefined || own.length > 0 ? { differentWindow: true } : {}),
    }];
  });
  return rows.length + unmatched.length > 0 ? [...rows, ...unmatched] : [{ window: "no-window" }];
}

function verdict({ differentWindow, subquo, clauth }: Row): string {
  const reasons: string[] = [];
  if (subquo === undefined || subquo.percentLeft === null || subquo.resetsAt === null) reasons.push("missing value");
  if (subquo?.status === "stale") reasons.push("stale value");
  const current = clauth?.status === "fresh" ? clauth : undefined;
  if (differentWindow || (subquo?.resetsAt && current?.resetsAt && subquo.resetsAt !== current.resetsAt)) {
    reasons.push("different window");
  }
  if (subquo?.percentLeft != null && current?.percentLeft != null
      && Math.abs(subquo.percentLeft - current.percentLeft) > tolerancePoints) {
    reasons.push(`difference exceeds ${tolerancePoints} percentage point`);
  }
  if (reasons.length > 0) return `WORSE: ${reasons.join(", ")}`;
  if (current === undefined || current.percentLeft === null || current.resetsAt === null) {
    return "UNCHECKED: no current clauth value";
  }
  return "MATCH";
}

function showMeasure(measure: Measure | undefined): string {
  if (measure === undefined) return "missing";
  const percent = measure.percentLeft === null ? "unknown" : `${measure.percentLeft}%`;
  return `${percent}, reset ${measure.resetsAt ?? "unknown"}, ${measure.status}`;
}

export function compareClaude(
  accounts: readonly CompareAccount[],
  snapshot: Pick<Snapshot, "accounts"> | undefined,
  clauth: ClAuthStatus,
  now: number,
): { readonly text: string; readonly matched: boolean } {
  const lines = [
    `Compared at ${new Date(now).toISOString()}, tolerance: ${tolerancePoints} percentage point`,
    "account\twindow\tsubquo left\tclauth left\tresult",
  ];
  const subquoById = new Map(snapshot?.accounts.filter(({ provider }) => provider === "claude").map((account) => [account.id, account]));
  const reportAt = DateTime.toEpochMillis(clauth.generated_at);
  let matched = accounts.length > 0;
  for (const account of accounts) {
    const name = clauthProfileName(account);
    const candidates = clauth.profiles.filter((profile) => profile.name === name
      && (profile.harness === undefined || profile.harness === "claude")
      && profile.provider === "anthropic" && profile.base_url === null);
    const baseline = candidates.length === 1 ? candidates[0] : undefined;
    const own = subquoWindows(subquoById.get(account.id), now);
    const reference = baseline === undefined ? [] : clauthWindows(baseline, reportAt, now);
    for (const row of accountRows(own, reference)) {
      const result = verdict(row);
      if (result !== "MATCH") matched = false;
      lines.push([account.id, row.window, showMeasure(row.subquo), showMeasure(row.clauth), result].join("\t"));
    }
  }
  return { text: lines.join("\n"), matched };
}
