import { Option, Schema } from "effect";
import type { Reading } from "./collect";
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
  if (new Set(windows.map((window) => window.id)).size !== windows.length) return { code: "auth_unverified" };
  return { observedAt: now, windows: validated.value };
}
function claudeWindow(used: unknown, resetsAt: unknown, id: QuotaWindow["id"], scope: QuotaWindow["scope"]): QuotaWindow | undefined {
  const percent = finitePercent(used);
  const reset = isoOrNull(resetsAt);
  if (percent === undefined || reset === undefined) return undefined;
  return { id, scope, percentLeft: 100 - percent, resetsAt: reset };
}

function claudeModelScope(name: string): Pick<QuotaWindow, "id" | "scope"> | undefined {
  if (name.includes("opus")) return { id: "opus-weekly", scope: "opus" };
  if (name.includes("sonnet")) return { id: "sonnet-weekly", scope: "sonnet" };
  if (name.includes("haiku")) return { id: "haiku-weekly", scope: "haiku" };
  if (name.includes("fable")) return { id: "fable-weekly", scope: "fable" };
  return undefined;
}

function claudeScopedWindow(entry: unknown): QuotaWindow | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry["percent"] !== "number") return undefined;
  const resetsAt = entry["resets_at"] ?? entry["reset_at"] ?? null;
  const percent = entry["percent"];
  const scope = isRecord(entry["scope"]) ? entry["scope"] : undefined;
  const model = scope && isRecord(scope["model"]) ? scope["model"] : undefined;
  const display = model ? model["display_name"] : undefined;
  const modelId = model ? model["id"] : undefined;
  const name = (typeof display === "string" ? display : typeof modelId === "string" ? modelId : "").toLowerCase();
  if (name.length > 0) {
    const identity = claudeModelScope(name);
    if (!identity) return undefined;
    return claudeWindow(percent, resetsAt, identity.id, identity.scope);
  }
  if (entry["group"] === "session") return claudeWindow(percent, resetsAt, "five-hour", "all");
  if (entry["group"] === "weekly") return claudeWindow(percent, resetsAt, "weekly", "all");
  return undefined;
}

function claudeTopLevelWindows(raw: Record<string, unknown>): QuotaWindow[] | undefined {
  const fields: Array<[string, QuotaWindow["id"], QuotaWindow["scope"]]> = [
    ["five_hour", "five-hour", "all"],
    ["seven_day", "weekly", "all"],
    ["seven_day_opus", "opus-weekly", "opus"],
    ["seven_day_sonnet", "sonnet-weekly", "sonnet"],
  ];
  const windows: QuotaWindow[] = [];
  for (const [field, id, scope] of fields) {
    const entry = raw[field];
    if (entry === undefined || entry === null) continue;
    if (!isRecord(entry)) return undefined;
    const window = claudeWindow(entry["utilization"], entry["resets_at"] ?? entry["reset_at"] ?? null, id, scope);
    if (!window) return undefined;
    windows.push(window);
  }
  return windows.length > 0 ? windows : undefined;
}

export function parseClaudeUsagePayload(raw: unknown): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const scoped = raw["limits"];
  if (Array.isArray(scoped)) {
    if (scoped.length === 0) return undefined;
    const windows: QuotaWindow[] = [];
    for (const entry of scoped) {
      const window = claudeScopedWindow(entry);
      if (!window) return undefined;
      windows.push(window);
    }
    return windows;
  }
  return claudeTopLevelWindows(raw);
}
function relativeReset(value: unknown, now: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(now + value * 1000).toISOString();
}

function durationSeconds(raw: Record<string, unknown>): number | undefined {
  const seconds = raw["limit_window_seconds"];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && Number.isInteger(seconds)) return seconds;
  const mins = raw["windowDurationMins"];
  if (typeof mins === "number" && Number.isFinite(mins) && mins >= 0 && Number.isInteger(mins)) return mins * 60;
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

function codexWindow(
  raw: unknown,
  scope: QuotaWindow["scope"],
  now: number,
  identities: CodexIdentities,
): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const used = raw["used_percent"] ?? raw["usedPercent"];
  const percent = finitePercent(used);
  if (percent === undefined) return undefined;
  const seconds = durationSeconds(raw);
  const reset = epochOrIsoToIso(raw["reset_at"] ?? raw["resetsAt"] ?? raw["resetAt"])
    ?? relativeReset(raw["reset_after_seconds"], now);
  if (reset === undefined) return undefined;
  const id = codexId(seconds, identities.positional, identities.session, identities.weekly, identities.unfamiliar);
  return { id, scope, percentLeft: 100 - percent, resetsAt: reset };
}

function codexContainer(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const nested = raw["rate_limit"] ?? raw["rateLimits"] ?? raw["rate_limits"];
  if (isRecord(nested)) return nested;
  if (isRecord(raw["primary_window"]) || isRecord(raw["primary"])) return raw;
  return undefined;
}

function codexPair(
  container: Record<string, unknown>,
  scope: QuotaWindow["scope"],
  now: number,
  primary: CodexIdentities,
  secondary: CodexIdentities,
): QuotaWindow[] | undefined {
  const windows: QuotaWindow[] = [];
  const rawPrimary = container["primary_window"] ?? container["primary"];
  if (rawPrimary !== undefined && rawPrimary !== null) {
    const window = codexWindow(rawPrimary, scope, now, primary);
    if (!window) return undefined;
    windows.push(window);
  }
  const rawSecondary = container["secondary_window"] ?? container["secondary"];
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

function codexNamedWindows(raw: unknown, now: number): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  const additional = Array.isArray(raw["additional_rate_limits"]) ? raw["additional_rate_limits"] : [];
  for (const item of additional) {
    if (!isRecord(item)) return undefined;
    const slug = codexSlug(item["metered_feature"] ?? item["limit_name"]);
    const container = isRecord(item["rate_limit"]) ? item["rate_limit"] : undefined;
    if (!slug || !container) continue;
    const pair = codexPair(container, slug, now, {
      positional: `model-${slug}-5h`,
      session: `model-${slug}-5h`,
      weekly: `model-${slug}-7d`,
      unfamiliar: (seconds) => `model-${slug}-window-${seconds}s`,
    }, {
      positional: `model-${slug}-7d`,
      session: `model-${slug}-5h`,
      weekly: `model-${slug}-7d`,
      unfamiliar: (seconds) => `model-${slug}-window-${seconds}s`,
    });
    if (!pair) return undefined;
    windows.push(...pair);
  }
  return windows;
}

export function parseCodexUsagePayload(raw: unknown, now: number): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  const container = codexContainer(raw);
  if (container) {
    const pair = codexPair(container, "all", now, {
      positional: "five-hour",
      session: "five-hour",
      weekly: "weekly",
      unfamiliar: (seconds) => `window-${seconds}s`,
    }, {
      positional: "weekly",
      session: "five-hour",
      weekly: "weekly",
      unfamiliar: (seconds) => `window-${seconds}s`,
    });
    if (!pair) return undefined;
    windows.push(...pair);
  }
  const review = isRecord(raw["code_review_rate_limit"]) ? raw["code_review_rate_limit"] : undefined;
  if (review) {
    const pair = codexPair(review, "code-review", now, {
      positional: "review-five-hour",
      session: "review-five-hour",
      weekly: "review-weekly",
      unfamiliar: (seconds) => `review-window-${seconds}s`,
    }, {
      positional: "review-weekly",
      session: "review-five-hour",
      weekly: "review-weekly",
      unfamiliar: (seconds) => `review-window-${seconds}s`,
    });
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
  const nested = isRecord(raw["usage"]) ? raw["usage"] : undefined;
  const pick = (names: readonly string[]): unknown => {
    for (const name of names) {
      const fromNested = nested?.[name];
      if (isRecord(fromNested)) return fromNested;
      const fromRoot = raw[name];
      if (isRecord(fromRoot)) return fromRoot;
    }
    return undefined;
  };
  const rolling = pick(["rollingUsage", "rolling"]);
  const buckets: Array<[unknown, QuotaWindow["id"], QuotaWindow["scope"]]> = [
    [rolling, openCodeDurationSeconds(rolling) === 18_000 ? "five-hour" : "rolling", "all"],
    [pick(["weeklyUsage", "weekly"]), "weekly", "all"],
    [pick(["monthlyUsage", "monthly"]), "monthly", "all"],
  ];
  const windows: QuotaWindow[] = [];
  for (const [bucket, id, scope] of buckets) {
    if (bucket === undefined || bucket === null) continue;
    const window = openCodeWindow(bucket, id, scope, now);
    if (!window) return undefined;
    windows.push(window);
  }
  return windows.length > 0 ? windows : undefined;
}
export type ClaudeCredentials = { readonly accessToken: string; readonly expiresAt?: number };
export type CodexCredentials = { readonly accessToken: string; readonly accountId?: string; readonly expiresAt?: number };

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
  const oauth = isRecord(value["claudeAiOauth"]) ? value["claudeAiOauth"] : value;
  const token = oauth["accessToken"] ?? oauth["access_token"];
  if (typeof token !== "string" || token.length === 0) return undefined;
  const expiresAt = oauth["expiresAt"];
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) return undefined;
  return expiresAt === undefined ? { accessToken: token } : { accessToken: token, expiresAt };
}

function codexCredentialsFrom(value: unknown): CodexCredentials | undefined {
  if (!isRecord(value)) return undefined;
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
