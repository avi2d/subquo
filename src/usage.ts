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
  if (value === undefined) return null;
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
  if (entry["group"] === "session") return claudeWindow(percent, resetsAt, "five-hour", "all");
  if (entry["group"] === "weekly") return claudeWindow(percent, resetsAt, "weekly", "all");
  const scope = isRecord(entry["scope"]) ? entry["scope"] : undefined;
  const model = scope && isRecord(scope["model"]) ? scope["model"] : undefined;
  const display = model ? model["display_name"] : undefined;
  const modelId = model ? model["id"] : undefined;
  const name = (typeof display === "string" ? display : typeof modelId === "string" ? modelId : "").toLowerCase();
  const identity = claudeModelScope(name);
  if (!identity) return undefined;
  return claudeWindow(percent, resetsAt, identity.id, identity.scope);
}

function claudeTopLevelWindows(raw: Record<string, unknown>): QuotaWindow[] | undefined {
  const fields: Array<[string, QuotaWindow["id"], QuotaWindow["scope"]]> = [
    ["five_hour", "five-hour", "all"],
    ["seven_day", "weekly", "all"],
    ["seven_day_opus", "opus-weekly", "opus"],
  ];
  const windows: QuotaWindow[] = [];
  for (const [field, id, scope] of fields) {
    const entry = raw[field];
    if (entry === undefined) continue;
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
function codexWindow(raw: unknown, id: QuotaWindow["id"], scope: QuotaWindow["scope"]): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const used = raw["used_percent"] ?? raw["usedPercent"];
  const percent = finitePercent(used);
  if (percent === undefined) return undefined;
  const reset = epochOrIsoToIso(raw["reset_at"] ?? raw["resetsAt"] ?? raw["resetAt"]);
  if (reset === undefined) return undefined;
  return { id, scope, percentLeft: 100 - percent, resetsAt: reset };
}

function codexContainer(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const nested = raw["rate_limit"] ?? raw["rateLimits"] ?? raw["rate_limits"];
  if (isRecord(nested)) return nested;
  if (isRecord(raw["primary_window"]) || isRecord(raw["primary"])) return raw;
  return undefined;
}

function codexPair(container: Record<string, unknown>, first: QuotaWindow["id"], second: QuotaWindow["id"], scope: QuotaWindow["scope"]): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const primary = codexWindow(container["primary_window"] ?? container["primary"], first, scope);
  const secondary = codexWindow(container["secondary_window"] ?? container["secondary"], second, scope);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

export function parseCodexUsagePayload(raw: unknown): QuotaWindow[] | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  const container = codexContainer(raw);
  if (container) windows.push(...codexPair(container, "five-hour", "weekly", "all"));
  const review = isRecord(raw["code_review_rate_limit"]) ? raw["code_review_rate_limit"] : undefined;
  if (review) windows.push(...codexPair(review, "review-five-hour", "review-weekly", "code-review"));
  return windows.length > 0 ? windows : undefined;
}

function openCodeWindow(raw: unknown, id: QuotaWindow["id"], scope: QuotaWindow["scope"]): QuotaWindow | undefined {
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
  const reset = epochOrIsoToIso(raw["resetsAt"] ?? raw["resetAt"] ?? raw["reset_at"] ?? raw["nextResetTime"]);
  if (reset === undefined) return undefined;
  return { id, scope, percentLeft, resetsAt: reset };
}

export function parseOpenCodeUsagePayload(raw: unknown): QuotaWindow[] | undefined {
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
  const windows: QuotaWindow[] = [];
  const rolling = openCodeWindow(pick(["rollingUsage", "rolling"]), "five-hour", "all");
  const weekly = openCodeWindow(pick(["weeklyUsage", "weekly"]), "weekly", "all");
  const monthly = openCodeWindow(pick(["monthlyUsage", "monthly"]), "monthly", "all");
  if (rolling) windows.push(rolling);
  if (weekly) windows.push(weekly);
  if (monthly) windows.push(monthly);
  return windows.length > 0 ? windows : undefined;
}
export type ClaudeCredentials = { readonly accessToken: string; readonly expiresAt?: number };
export type CodexCredentials = { readonly accessToken: string; readonly accountId?: string };

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
  return typeof accountId === "string" ? { accessToken: token, accountId } : { accessToken: token };
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
  if (value["opencode"] !== undefined) return undefined;
  const entry = value["opencode-go"];
  if (!isRecord(entry)) return undefined;
  const key = entry["key"] ?? entry["apiKey"] ?? entry["api_key"];
  if (typeof key !== "string" || key.length === 0) return undefined;
  if (/\s/u.test(key)) return undefined;
  return key;
}
