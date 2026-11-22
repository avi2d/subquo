import { Clock, Effect, FileSystem, Option, Path, Predicate, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { EnrolledAccount } from "./accounts";
import type { Reading } from "./collect";
import { Windows, type FailureCode, type QuotaWindow } from "./index";
import { renewalExpiry } from "./renewal";

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const QuotaAxiReport = Schema.Struct({
  providers: Schema.Array(Schema.Struct({
    provider: Schema.String,
    source: Schema.optional(Schema.String),
    notSetUp: Schema.optional(Schema.Boolean),
    state: Schema.Struct({
      status: Schema.String,
      stale: Schema.Boolean,
      refreshedAt: Schema.optional(Schema.String),
      authStatus: Schema.optional(Schema.String),
    }),
    windows: Schema.Array(Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      percentRemaining: Schema.optional(Percent),
      resetsAt: Schema.optional(Schema.String),
      shareOf: Schema.optional(Schema.String),
    })),
  })),
});
const ClauthReport = Schema.Struct({
  profiles: Schema.Array(Schema.Struct({
    name: Schema.String,
    provider: Schema.String,
    stale: Schema.Boolean,
    fetched_at: Schema.NullOr(Schema.String),
    auth_status: Schema.optional(Schema.String),
    fetch_status: Schema.NullOr(Schema.String),
    windows: Schema.Array(Schema.Struct({
      label: Schema.String,
      utilization_pct: Percent,
      resets_at: Schema.NullOr(Schema.String),
    })),
  })),
});

const OpenCodeAuth = Schema.Struct({
  "opencode-go": Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^[^\s$]+$/u)) }),
  opencode: Schema.optional(Schema.Never),
});
const decodeOpenCodeAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OpenCodeAuth));
const decodeQuotaAxi = Schema.decodeUnknownOption(Schema.fromJsonString(QuotaAxiReport));
const decodeClauth = Schema.decodeUnknownOption(Schema.fromJsonString(ClauthReport));
const decodeWindows = Schema.decodeUnknownOption(Windows);
const unverified = { code: "auth_unverified" } satisfies Reading;
const required = { code: "auth_required" } satisfies Reading;
const limited = { code: "rate_limited" } satisfies Reading;

function isoTime(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function windowIdentity(id: string): Pick<QuotaWindow, "id" | "scope"> | undefined {
  switch (id.toLowerCase()) {
    case "5h":
    case "five_hour":
      return { id: "five-hour", scope: "all" };
    case "7d":
    case "weekly":
    case "seven_day":
      return { id: "weekly", scope: "all" };
    case "30d":
    case "monthly":
      return { id: "monthly", scope: "all" };
    case "rolling":
      return { id: "rolling", scope: "all" };
    case "code_review_five_hour":
      return { id: "review-five-hour", scope: "code-review" };
    case "code_review_weekly":
      return { id: "review-weekly", scope: "code-review" };
    case "7d opus":
    case "seven_day_opus":
      return { id: "opus-weekly", scope: "opus" };
    case "7d sonnet":
    case "seven_day_sonnet":
      return { id: "sonnet-weekly", scope: "sonnet" };
    case "7d fable":
      return { id: "fable-weekly", scope: "fable" };
    case "7d haiku":
      return { id: "haiku-weekly", scope: "haiku" };
    default: {
      const model = /^model:claude-(opus|sonnet|fable|haiku)(?:-[0-9]+)+$/u.exec(id)?.at(1);
      return model === undefined ? undefined : { id: `${model}-weekly`, scope: model };
    }
  }
}

function measured(
  stamp: string | null | undefined,
  windows: readonly QuotaWindow[],
  staleCode?: FailureCode | null,
): Reading {
  const observedAt = isoTime(stamp);
  const validated = decodeWindows(windows);
  if (observedAt === null || Option.isNone(validated)) return unverified;
  if (new Set(windows.map(({ id }) => id)).size !== windows.length) return unverified;
  return staleCode === undefined
    ? { observedAt, windows: validated.value }
    : { observedAt, windows: validated.value, staleCode };
}

export function parseClauthReading(json: string, profileName: string): Reading {
  const report = decodeClauth(json);
  if (Option.isNone(report)) return unverified;
  const matches = report.value.profiles.filter(({ name, provider }) => name === profileName && provider === "anthropic");
  if (matches.length > 1) return unverified;
  const profile = matches.at(0);
  if (!profile || profile.auth_status === "broken") return required;
  if (profile.auth_status === "expired" || profile.fetch_status === "AuthExpired") return unverified;
  const windows: QuotaWindow[] = [];
  for (const { label, utilization_pct, resets_at } of profile.windows) {
    const identity = windowIdentity(label);
    if (!identity) return unverified;
    windows.push({ ...identity, percentLeft: 100 - utilization_pct, resetsAt: isoTime(resets_at) });
  }
  if (profile.fetch_status === "RateLimited") {
    return windows.length === 0 ? limited : measured(profile.fetched_at, windows, "rate_limited");
  }
  return measured(profile.fetched_at, windows,
    profile.fetch_status === "Failed" ? "auth_unverified" : profile.stale ? null : undefined);
}

function quotaAxiWindows(rows: typeof QuotaAxiReport.Type.providers[number]["windows"]): QuotaWindow[] | undefined {
  const windows: QuotaWindow[] = [];
  for (const window of rows) {
    if (window.shareOf !== undefined || window.kind === "credits" || window.id === "extra_usage") continue;
    const identity = windowIdentity(window.id);
    if (!identity) return undefined;
    windows.push({ ...identity, percentLeft: window.percentRemaining ?? null, resetsAt: isoTime(window.resetsAt) });
  }
  return windows;
}

export function parseQuotaAxiReading(json: string, provider: EnrolledAccount["provider"]): Reading {
  const report = decodeQuotaAxi(json);
  if (Option.isNone(report)) return unverified;
  const rows = report.value.providers.filter((entry) => entry.provider === provider);
  if (rows.length !== 1) return unverified;
  const [row] = rows;
  const { status, stale, refreshedAt, authStatus } = row.state;
  if (authStatus === "expired_refreshable") return unverified;
  if (row.notSetUp || status === "auth_required") return required;
  if (status === "rate_limited") return limited;
  if (status !== "fresh" && status !== "stale") return unverified;
  if (row.source !== (provider === "opencode-go" ? "api" : "oauth")) return unverified;
  const windows = quotaAxiWindows(row.windows);
  return windows ? measured(refreshedAt, windows, stale || status === "stale" ? null : undefined) : unverified;
}

const runQuotaAxi = Effect.fnUntraced(function*(env: Record<string, string | undefined>, provider: EnrolledAccount["provider"]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = ["quota", "--provider", provider, "--json", "--full", "--no-credential-refresh"];
  if (provider !== "opencode-go") args.push("--profile-only");
  const command = ChildProcess.make("quota-axi", args, { env, stdin: "ignore", stderr: "ignore", killSignal: "SIGKILL" });
  const child = yield* spawner.spawn(command);
  const json = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
  return (yield* child.exitCode) === 0 ? parseQuotaAxiReading(json, provider) : unverified;
});

export const readAccount = Effect.fnUntraced(function*(account: EnrolledAccount, home: string, executablePath: string | undefined) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (account.login.store === "macos-keychain") {
    const profile = account.login.clauth_profile;
    return yield* fs.readFileString(path.join(home, ".clauth", "status.json")).pipe(
      Effect.map((json) => parseClauthReading(json, profile)),
      Effect.orElseSucceed(() => unverified),
    );
  }
  const file = account.login.path;
  const info = yield* fs.stat(file).pipe(Effect.result);
  if (Result.isFailure(info)) return Predicate.isTagged(info.failure.reason, "NotFound") ? required : unverified;
  if (info.success.type !== "File") return unverified;

  const configDir = path.dirname(file);
  const env = { HOME: home, PATH: executablePath };
  const scopedEnv = account.provider === "claude" ? { ...env, CLAUDE_CONFIG_DIR: configDir }
    : account.provider === "codex" ? { ...env, CODEX_HOME: configDir }
    : { ...env, XDG_DATA_HOME: path.dirname(configDir) };
  if (account.provider === "opencode-go") {
    const valid = yield* fs.readFileString(file).pipe(
      Effect.map((json) => Option.isSome(decodeOpenCodeAuth(json))),
      Effect.orElseSucceed(() => false),
    );
    if (!valid) return unverified;
  }
  const reading = yield* Effect.scoped(runQuotaAxi(scopedEnv, account.provider)).pipe(Effect.orElseSucceed(() => unverified));
  if (account.provider === "opencode-go" || !("code" in reading) || reading.code !== "auth_required") return reading;

  const provider = account.provider;
  const expires = yield* fs.readFileString(file).pipe(
    Effect.map((json) => renewalExpiry(provider, json)),
    Effect.orElseSucceed(() => undefined),
  );
  return expires !== undefined && expires <= (yield* Clock.currentTimeMillis) ? unverified : reading;
});
