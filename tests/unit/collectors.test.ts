import { expect, test } from "bun:test";
import { Effect } from "effect";
import { validClaudeKeychainService } from "../../src/accounts";
import type { FetchImpl } from "../../src/collectors";
import { requestClaudeReading, requestCodexReading, requestOpenCodeReading } from "../../src/collectors";
import {
  parseClaudeCredentials,
  parseClaudeUsagePayload,
  parseCodexCredentials,
  parseCodexUsagePayload,
  parseOpenCodeKey,
  parseOpenCodeUsagePayload,
} from "../../src/usage";

const reset = "2030-01-02T00:00:00.000Z";
const now = Date.parse("2030-01-01T00:00:00.000Z");

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response("", { status });
}

test("a Claude utilization reply leaves the remainder, not the usage, as percent left", async () => {
  const windows = parseClaudeUsagePayload({ five_hour: { utilization: 60, resets_at: reset } });
  expect(windows).toEqual([{ id: "five-hour", scope: "all", percentLeft: 40, resetsAt: reset }]);
});

test("a Claude reply with an unknown window shape reads as unchecked, not fresh", async () => {
  expect(parseClaudeUsagePayload({ five_hour: { utilization: 160, resets_at: reset } })).toBeUndefined();
  expect(parseClaudeUsagePayload({ limits: [{ percent: 10, group: "mystery" }] })).toBeUndefined();
  expect(parseClaudeUsagePayload({})).toBeUndefined();
  expect(parseClaudeCredentials("not json")).toBeUndefined();
});

test("a rejected Claude pass reads as login needed, not unchecked", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(statusResponse(401));
  const reading = await Effect.runPromise(requestClaudeReading({ accessToken: "live-token" }, fetchImpl, now));
  expect(reading).toEqual({ code: "auth_required" });
});

test("a Claude rate limit reads as limited, not unchecked", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(statusResponse(429));
  const reading = await Effect.runPromise(requestClaudeReading({ accessToken: "live-token" }, fetchImpl, now));
  expect(reading).toEqual({ code: "rate_limited" });
});

test("an expired Claude pass reads as unchecked without touching the network", async () => {
  const fetchImpl: FetchImpl = () => { throw new Error("network used"); };
  const reading = await Effect.runPromise(
    requestClaudeReading({ accessToken: "stale-token", expiresAt: now - 1000 }, fetchImpl, now),
  );
  expect(reading).toEqual({ code: "auth_unverified" });
});

test("a fresh Claude reply carries its windows with the read time", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse({ seven_day: { utilization: 88, resets_at: reset } }));
  const reading = await Effect.runPromise(requestClaudeReading({ accessToken: "live-token" }, fetchImpl, now));
  expect(reading).toEqual({
    observedAt: "2030-01-01T00:00:00.000Z",
    windows: [{ id: "weekly", scope: "all", percentLeft: 12, resetsAt: reset }],
  });
});

test("a Codex usage reply keeps code review out of the shared limits", async () => {
  const windows = parseCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 88, reset_at: reset },
      secondary_window: { used_percent: 60, reset_at: reset },
    },
    code_review_rate_limit: { primary_window: { used_percent: 33, reset_at: reset } },
  });
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 12, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 40, resetsAt: reset },
    { id: "review-five-hour", scope: "code-review", percentLeft: 67, resetsAt: reset },
  ]);
});

test("a Codex rejection on every usage address reads as login needed", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    calls.push(url);
    return Promise.resolve(statusResponse(401));
  };
  const reading = await Effect.runPromise(requestCodexReading({ accessToken: "dead-token" }, fetchImpl, now));
  expect(reading).toEqual({ code: "auth_required" });
  expect(calls.length).toBe(2);
});

test("a Codex rate limit on the first address stops without trying the second", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    calls.push(url);
    return Promise.resolve(statusResponse(429));
  };
  const reading = await Effect.runPromise(requestCodexReading({ accessToken: "live-token" }, fetchImpl, now));
  expect(reading).toEqual({ code: "rate_limited" });
  expect(calls.length).toBe(1);
});

test("an OpenCode file holding another entry never selects that entry", async () => {
  expect(parseOpenCodeKey(JSON.stringify({ "opencode-go": { key: "go-key" }, opencode: { key: "other" } }))).toBeUndefined();
  expect(parseOpenCodeKey(JSON.stringify({ "opencode-go": { key: "go-key" } }))).toBe("go-key");
});

test("an OpenCode rejection reads as login needed, not unchecked", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(statusResponse(403));
  const reading = await Effect.runPromise(requestOpenCodeReading("go-key", fetchImpl, now));
  expect(reading).toEqual({ code: "auth_required" });
});

test("an OpenCode usage reply maps rolling and weekly to separate windows", async () => {
  const windows = parseOpenCodeUsagePayload({ usage: { rollingUsage: { percentRemaining: 40, resetsAt: reset }, weeklyUsage: { percent: 88, resetsAt: reset } } });
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 40, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 12, resetsAt: reset },
  ]);
});

test("a named default Keychain login is not rejected as unverified", async () => {
  expect(validClaudeKeychainService({ config_dir: "/home/user/.claude", service: "Claude Code-credentials" })).toBe(true);
  expect(validClaudeKeychainService({ config_dir: "/home/user/.claude", service: "Claude Code-credentials-deadbeef" })).toBe(false);
});

test("a Codex login keeps its account header while the token stays out of the reading", async () => {
  const seen: Record<string, string>[] = [];
  const fetchImpl: FetchImpl = (_url, init) => {
    seen.push(init.headers);
    return Promise.resolve(jsonResponse({ rate_limit: { primary_window: { used_percent: 60, reset_at: reset } } }));
  };
  const credentials = parseCodexCredentials(JSON.stringify({ tokens: { access_token: "secret-token", account_id: "acct-1" } }));
  if (!credentials) throw new Error("test credential rejected");
  const reading = await Effect.runPromise(requestCodexReading(credentials, fetchImpl, now));
  expect(seen[0]?.["ChatGPT-Account-Id"]).toBe("acct-1");
  expect(JSON.stringify(reading)).not.toContain("secret-token");
});
