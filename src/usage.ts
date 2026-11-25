import { Option, Schema } from "effect";
import type { Reading } from "./collect";
import { parsePiCodexLogin } from "./pi-codex";
import type { CodexCredentials } from "./codex-credentials";
import { Windows, type QuotaWindow } from "./index";
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeWindows = Schema.decodeUnknownOption(Windows);

export function parseJson(text: string): unknown {
  const decoded = decodeJson(text);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function epochOrIsoToIso(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return isoOrNull(value) ?? undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1000000000000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

export function measuredAt(now: string, windows: readonly QuotaWindow[]): Reading {
  const validated = decodeWindows(windows);
  if (Option.isNone(validated)) return { code: "auth_unverified" };
  return { observedAt: now, windows: validated.value };
}
function claudeWindow(used: unknown, resetsAt: unknown, id: QuotaWindow["id"], scope: QuotaWindow["scope"]): QuotaWindow | undefined {
  const percent = finitePercent(used);
  const reset = isoOrNull(resetsAt);
  if (percent === undefined || reset === undefined) return undefined;
  return { id, scope, percentLeft: 100 - percent, resetsAt: reset };
}

function claudeModelScope(name: string): Pick<QuotaWindow, "id" | "scope"> | undefined {
  const families = name.toLowerCase().split(/[^a-z0-9]+/u);
  const known = (["opus", "sonnet", "haiku", "fable"] as const).filter((family) => families.includes(family));
  const [scope] = known;
  return known.length === 1 ? { id: `${scope}-weekly`, scope } : undefined;
}

function claudeLimitIdentity(entry: Record<string, unknown>): Pick<QuotaWindow, "id" | "scope"> | "unrelated" | "unmapped" {
  if (entry["kind"] === "session") return { id: "five-hour", scope: "all" };
  if (entry["kind"] === "weekly_all") return { id: "weekly", scope: "all" };
  if (entry["kind"] !== "weekly_scoped") return "unrelated";
  const scope = entry["scope"];
  if (!isRecord(scope) || !isRecord(scope["model"])) return "unmapped";
  const name = scope["model"]["display_name"] ?? scope["model"]["id"];
  return (typeof name === "string" ? claudeModelScope(name) : undefined) ?? "unmapped";
}

function addClaudeLegacyWindows(raw: Record<string, unknown>, windows: Map<string, QuotaWindow>): boolean {
  const fields: Array<[string, QuotaWindow["id"], QuotaWindow["scope"]]> = [
    ["five_hour", "five-hour", "all"],
    ["seven_day", "weekly", "all"],
    ["seven_day_opus", "opus-weekly", "opus"],
    ["seven_day_sonnet", "sonnet-weekly", "sonnet"],
  ];
  for (const [field, id, scope] of fields) {
    const entry = raw[field];
    if (windows.has(id) || entry === undefined || entry === null) continue;
    if (!isRecord(entry)) return false;
    const window = claudeWindow(entry["utilization"], entry["resets_at"] ?? entry["reset_at"], id, scope);
    if (!window) return false;
    windows.set(id, window);
  }
  return true;
}

export function parseClaudeUsagePayload(raw: unknown): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const limits = raw["limits"] ?? [];
  if (!Array.isArray(limits)) return undefined;
  const windows = new Map<string, QuotaWindow>();
  for (const entry of limits) {
    if (!isRecord(entry)) return undefined;
    const identity = claudeLimitIdentity(entry);
    if (identity === "unrelated") continue;
    if (identity === "unmapped") return undefined;
    const window = claudeWindow(entry["percent"], entry["resets_at"] ?? entry["reset_at"], identity.id, identity.scope);
    if (!window || windows.has(window.id)) return undefined;
    windows.set(window.id, window);
  }
  if (!addClaudeLegacyWindows(raw, windows) || windows.size === 0) return undefined;
  return [...windows.values()];
}
function relativeReset(value: unknown, now: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(now + value * 1000).toISOString();
}

function durationSeconds(raw: Record<string, unknown>): number | undefined {
  const seconds = raw["limit_window_seconds"];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && Number.isInteger(seconds)) return seconds;
  return undefined;
}

function codexId(
  seconds: number | undefined,
  positional: QuotaWindow["id"],
  session: QuotaWindow["id"],
  weekly: QuotaWindow["id"],
  unfamiliar: (seconds: number) => QuotaWindow["id"],
): QuotaWindow["id"] {
  if (seconds === undefined) return positional;
  if (seconds === 18_000) return session;
  if (seconds === 604_800) return weekly;
  return unfamiliar(seconds);
}

type CodexIdentities = {
  readonly positional: QuotaWindow["id"];
  readonly session: QuotaWindow["id"];
  readonly weekly: QuotaWindow["id"];
  readonly unfamiliar: (seconds: number) => QuotaWindow["id"];
};

function codexPairIdentities(
  session: QuotaWindow["id"],
  weekly: QuotaWindow["id"],
  unfamiliar: (seconds: number) => QuotaWindow["id"],
): readonly [CodexIdentities, CodexIdentities] {
  return [
    { positional: session, session, weekly, unfamiliar },
    { positional: weekly, session, weekly, unfamiliar },
  ];
}

function codexWindow(
  raw: unknown,
  scope: QuotaWindow["scope"],
  now: number,
  identities: CodexIdentities,
): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const percent = finitePercent(raw["used_percent"]);
  if (percent === undefined) return undefined;
  const seconds = durationSeconds(raw);
  const reset = epochOrIsoToIso(raw["reset_at"])
    ?? relativeReset(raw["reset_after_seconds"], now);
  if (reset === undefined) return undefined;
  const id = codexId(seconds, identities.positional, identities.session, identities.weekly, identities.unfamiliar);
  return { id, scope, percentLeft: 100 - percent, resetsAt: reset };
}

function codexPair(
  container: Record<string, unknown>,
  scope: QuotaWindow["scope"],
  now: number,
  primary: CodexIdentities,
  secondary: CodexIdentities,
): QuotaWindow[] | undefined {
  const windows: QuotaWindow[] = [];
  const rawPrimary = container["primary_window"];
  if (rawPrimary !== undefined && rawPrimary !== null) {
    const window = codexWindow(rawPrimary, scope, now, primary);
    if (!window) return undefined;
    windows.push(window);
  }
  const rawSecondary = container["secondary_window"];
  if (rawSecondary !== undefined && rawSecondary !== null) {
    const window = codexWindow(rawSecondary, scope, now, secondary);
    if (!window) return undefined;
    windows.push(window);
  }
  return windows;
}

function codexSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug.slice(0, 48) : undefined;
}

function codexNamedPair(
  item: Record<string, unknown>,
  slug: string,
  now: number,
): QuotaWindow[] | undefined {
  const containerField = item["rate_limit"];
  if (containerField === undefined || containerField === null) return [];
  if (!isRecord(containerField)) return undefined;
  const session = `model-${slug}-5h`;
  const weekly = `model-${slug}-7d`;
  const unfamiliar = (seconds: number): QuotaWindow["id"] => `model-${slug}-window-${seconds}s`;
  const [primary, secondary] = codexPairIdentities(session, weekly, unfamiliar);
  return codexPair(containerField, slug, now, primary, secondary);
}

function codexNamedWindows(raw: unknown, now: number): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  const additionalField = raw["additional_rate_limits"];
  if (additionalField === undefined || additionalField === null) return windows;
  if (!Array.isArray(additionalField)) return undefined;
  for (const item of additionalField) {
    if (item === null) continue;
    if (!isRecord(item)) return undefined;
    const slug = codexSlug(item["metered_feature"] ?? item["limit_name"]);
    if (!slug) continue;
    const pair = codexNamedPair(item, slug, now);
    if (!pair) return undefined;
    windows.push(...pair);
  }
  return windows;
}

export function parseCodexUsagePayload(raw: unknown, now: number): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  const rateLimitField = raw["rate_limit"];
  if (rateLimitField !== undefined && rateLimitField !== null && !isRecord(rateLimitField)) return undefined;
  const container = isRecord(rateLimitField) ? rateLimitField : undefined;
  if (container) {
    const [primary, secondary] = codexPairIdentities("five-hour", "weekly", (seconds) => `window-${seconds}s`);
    const pair = codexPair(container, "all", now, primary, secondary);
    if (!pair) return undefined;
    windows.push(...pair);
  }
  const reviewField = raw["code_review_rate_limit"];
  if (reviewField !== undefined && reviewField !== null && !isRecord(reviewField)) return undefined;
  const review = isRecord(reviewField) ? reviewField : undefined;
  if (review) {
    const [primary, secondary] = codexPairIdentities("review-five-hour", "review-weekly", (seconds) => `review-window-${seconds}s`);
    const pair = codexPair(review, "code-review", now, primary, secondary);
    if (!pair) return undefined;
    windows.push(...pair);
  }
  const named = codexNamedWindows(raw, now);
  if (!named) return undefined;
  windows.push(...named);
  return windows.length > 0 ? windows : undefined;
}

function openCodeReset(raw: Record<string, unknown>, now: number): string | null | undefined {
  const absolute = epochOrIsoToIso(raw["resetsAt"] ?? raw["resetAt"] ?? raw["reset_at"] ?? raw["nextResetTime"]);
  if (absolute !== undefined && absolute !== null) return absolute;
  const relative = raw["resetInSec"] ?? raw["reset_in_sec"];
  if (relative === undefined || relative === null) return absolute ?? null;
  if (typeof relative !== "number" || !Number.isFinite(relative) || relative < 0) return undefined;
  return new Date(now + relative * 1000).toISOString();
}

function openCodeWindow(raw: unknown, id: QuotaWindow["id"], scope: QuotaWindow["scope"], now: number): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const remaining = raw["percentRemaining"] ?? raw["remainingPercent"];
  const used = raw["percent"] ?? raw["percentUsed"] ?? raw["usedPercent"] ?? raw["usagePercent"];
  let percentLeft: number | undefined;
  if (remaining !== undefined) {
    percentLeft = finitePercent(remaining);
  } else if (used !== undefined) {
    const usedPercent = finitePercent(used);
    percentLeft = usedPercent === undefined ? undefined : 100 - usedPercent;
  } else if (typeof raw["status"] === "string" && raw["status"].toLowerCase() === "rate-limited") {
    percentLeft = 0;
  }
  if (percentLeft === undefined) return undefined;
  const reset = openCodeReset(raw, now);
  if (reset === undefined) return undefined;
  return { id, scope, percentLeft, resetsAt: reset };
}

function openCodeDurationSeconds(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const names = ["windowSeconds", "window_seconds", "cycleSeconds", "cycle_seconds", "durationSeconds", "duration_seconds", "periodSeconds", "period_seconds"];
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) return value;
  }
  return undefined;
}

export function parseOpenCodeUsagePayload(raw: unknown, now: number): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const usageField = raw["usage"];
  if (usageField !== undefined && usageField !== null && !isRecord(usageField)) return undefined;
  const nested = isRecord(usageField) ? usageField : undefined;
  const bucket = (names: readonly string[]): Record<string, unknown> | null | undefined => {
    for (const source of [nested, raw]) {
      if (source === undefined) continue;
      for (const name of names) {
        const value = source[name];
        if (value === undefined || value === null) continue;
        if (!isRecord(value)) return null;
        return value;
      }
    }
    return undefined;
  };
  const rolling = bucket(["rollingUsage", "rolling"]);
  if (rolling === null) return undefined;
  const weekly = bucket(["weeklyUsage", "weekly"]);
  if (weekly === null) return undefined;
  const monthly = bucket(["monthlyUsage", "monthly"]);
  if (monthly === null) return undefined;
  const buckets: Array<[Record<string, unknown> | undefined, QuotaWindow["id"], QuotaWindow["scope"]]> = [
    [rolling, openCodeDurationSeconds(rolling) === 18_000 ? "five-hour" : "rolling", "all"],
    [weekly, "weekly", "all"],
    [monthly, "monthly", "all"],
  ];
  const windows: QuotaWindow[] = [];
  for (const [entry, id, scope] of buckets) {
    if (entry === undefined) continue;
    const window = openCodeWindow(entry, id, scope, now);
    if (!window) return undefined;
    windows.push(window);
  }
  return windows.length > 0 ? windows : undefined;
}
const ClaudeAccess = Schema.Struct({ accessToken: Schema.NonEmptyString, expiresAt: Schema.optionalKey(Schema.Finite) });
const earliestRefreshExpiry = Date.UTC(2020, 0, 1);
const latestDateValue = 8.64e15;
const RefreshExpiry = Schema.Struct({ refreshTokenExpiresAt: Schema.Int.check(Schema.isBetween({ maximum: latestDateValue, minimum: earliestRefreshExpiry })) });
type ClaudeAccess = typeof ClaudeAccess.Type;
export type ClaudeCredentials = ClaudeAccess & { readonly refreshExpiresAt?: number };
const decodeClaudeAccess = Schema.decodeUnknownOption(ClaudeAccess);
const decodeRefreshExpiry = Schema.decodeUnknownOption(RefreshExpiry);

function decodeJwtExp(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload || /[^A-Za-z0-9\-_]/.test(payload)) return undefined;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = parseJson(atob(padded));
  if (!isRecord(decoded)) return undefined;
  const exp = decoded["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

function claudeCredentialsFrom(value: unknown): ClaudeCredentials | undefined {
  if (!isRecord(value)) return undefined;
  const savedOAuth = value["claudeAiOauth"];
  const oauth = isRecord(savedOAuth) ? savedOAuth : value;
  const expiresAt = oauth["expiresAt"];
  const access = decodeClaudeAccess({
    accessToken: oauth["accessToken"] ?? oauth["access_token"],
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (Option.isNone(access)) return undefined;
  const expiry = decodeRefreshExpiry(savedOAuth);
  return Option.isSome(expiry)
    ? { ...access.value, refreshExpiresAt: expiry.value.refreshTokenExpiresAt }
    : access.value;
}

function codexCredentialsFrom(value: unknown): CodexCredentials | undefined {
  if (!isRecord(value)) return undefined;
  if (value["openai-codex"] !== undefined) return parsePiCodexLogin(value["openai-codex"]);
  const tokens = isRecord(value["tokens"]) ? value["tokens"] : undefined;
  if (!tokens) return undefined;
  const token = tokens["access_token"] ?? tokens["accessToken"];
  if (typeof token !== "string" || token.length === 0) return undefined;
  const accountId = value["account_id"] ?? value["accountId"] ?? tokens["account_id"] ?? tokens["accountId"];
  if (accountId !== undefined && (typeof accountId !== "string" || accountId.length === 0)) return undefined;
  const expiresAt = decodeJwtExp(token);
  if (typeof accountId === "string") {
    return expiresAt === undefined ? { accessToken: token, accountId } : { accessToken: token, accountId, expiresAt };
  }
  return expiresAt === undefined ? { accessToken: token } : { accessToken: token, expiresAt };
}

export function parseClaudeCredentials(json: string): ClaudeCredentials | undefined {
  return claudeCredentialsFrom(parseJson(json));
}

export function parseCodexCredentials(json: string): CodexCredentials | undefined {
  return codexCredentialsFrom(parseJson(json));
}

export function parseOpenCodeKey(json: string): string | undefined {
  const value = parseJson(json);
  if (!isRecord(value)) return undefined;
  const entry = value["opencode-go"];
  if (!isRecord(entry)) return undefined;
  const key = entry["key"] ?? entry["apiKey"] ?? entry["api_key"];
  if (typeof key !== "string" || key.length === 0) return undefined;
  if (/\s/u.test(key)) return undefined;
  return key;
}
