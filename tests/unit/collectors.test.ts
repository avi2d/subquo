import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
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

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
  return "header." + payload + ".signature";
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

test("a rejected pass that expired mid-read does not read as login needed", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(statusResponse(401));
  const program = Effect.gen(function*() {
    yield* TestClock.setTime(now + 5000);
    return yield* requestClaudeReading({ accessToken: "live-token", expiresAt: now + 1000 }, fetchImpl, now);
  }).pipe(Effect.provide(TestClock.layer()));
  const reading = await Effect.runPromise(program);
  expect(reading).toEqual({ code: "auth_unverified" });
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

test("a scoped Claude reply keeps the model window out of the shared weekly window", async () => {
  const windows = parseClaudeUsagePayload({
    limits: [
      { kind: "session", group: "session", percent: 22, resets_at: reset, scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 41, resets_at: reset, scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 63, resets_at: reset, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
  });
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 78, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 59, resetsAt: reset },
    { id: "fable-weekly", scope: "fable", percentLeft: 37, resetsAt: reset },
  ]);
});

test("a Claude reply with an unmapped scoped limit reads as unchecked rather than dropping that limit", async () => {
  const shared = [
    { kind: "session", percent: 22, resets_at: reset },
    { kind: "weekly_all", percent: 41, resets_at: reset },
  ];
  for (const scope of [{ model: { id: null, display_name: "Mystery" } }, { model: { id: "claude-opus-sonnet" } }, null]) {
    const payload = { limits: [...shared, { kind: "weekly_scoped", percent: 100, resets_at: reset, scope }] };
    expect(parseClaudeUsagePayload(payload)).toBeUndefined();
    const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse(payload));
    const reading = await Effect.runPromise(requestClaudeReading({ accessToken: "live-token" }, fetchImpl, now));
    expect(reading).toEqual({ code: "auth_unverified" });
  }
});

test("an unrelated Claude limit kind does not block the model windows", () => {
  const windows = parseClaudeUsagePayload({
    limits: [
      { kind: "session", percent: 22, resets_at: reset },
      { kind: "fake_unrelated_kind", percent: 90, resets_at: reset },
    ],
  });
  expect(windows).toEqual([{ id: "five-hour", scope: "all", percentLeft: 78, resetsAt: reset }]);
});

test("a Claude kind-only reply neither skips the new session limit nor drops the legacy weekly fallback", () => {
  const windows = parseClaudeUsagePayload({
    limits: [{ kind: "session", percent: 25, resets_at: reset }],
    five_hour: { utilization: 99, resets_at: reset },
    seven_day: { utilization: 80, resets_at: reset },
  });
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 75, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 20, resetsAt: reset },
  ]);
});

test("a malformed refresh expiry does not poison a usable Claude access token", () => {
  expect(parseClaudeCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: "fake-access", expiresAt: now + 2_000, refreshTokenExpiresAt: "not a date" },
  }))).toEqual({ accessToken: "fake-access", expiresAt: now + 2_000 });
});

test("a legacy Claude reply keeps its sonnet window instead of dropping it", async () => {
  const windows = parseClaudeUsagePayload({
    five_hour: { utilization: 18, resets_at: reset },
    seven_day: { utilization: 36, reset_at: reset },
    seven_day_opus: { utilization: 7, resets_at: reset },
    seven_day_sonnet: { utilization: 50, resets_at: reset },
  });
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 82, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 64, resetsAt: reset },
    { id: "opus-weekly", scope: "opus", percentLeft: 93, resetsAt: reset },
    { id: "sonnet-weekly", scope: "sonnet", percentLeft: 50, resetsAt: reset },
  ]);
});

test("a legacy Claude reply with a missing model bucket keeps the windows it has", async () => {
  const windows = parseClaudeUsagePayload({
    five_hour: { utilization: 18, resets_at: reset },
    seven_day_opus: null,
  });
  expect(windows).toEqual([{ id: "five-hour", scope: "all", percentLeft: 82, resetsAt: reset }]);
});

test("a Claude window without a reset keeps a null reset instead of dropping the account", async () => {
  const windows = parseClaudeUsagePayload({ five_hour: { utilization: 60 } });
  expect(windows).toEqual([{ id: "five-hour", scope: "all", percentLeft: 40, resetsAt: null }]);
});

test("a Codex usage reply keeps code review out of the shared limits", async () => {
  const windows = parseCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 88, reset_at: reset, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 60, reset_at: reset, limit_window_seconds: 604800 },
    },
    code_review_rate_limit: { primary_window: { used_percent: 33, reset_at: reset, limit_window_seconds: 18000 } },
  }, now);
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 12, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 40, resetsAt: reset },
    { id: "review-five-hour", scope: "code-review", percentLeft: 67, resetsAt: reset },
  ]);
});

test("a Codex primary window lasting a week reads as weekly, not five-hour", async () => {
  const windows = parseCodexUsagePayload({
    rate_limit: { primary_window: { used_percent: 29, reset_at: reset, limit_window_seconds: 604800 } },
  }, now);
  expect(windows).toEqual([{ id: "weekly", scope: "all", percentLeft: 71, resetsAt: reset }]);
});

test("a Codex review window lasting a week reads as review-weekly, not review-five-hour", async () => {
  const windows = parseCodexUsagePayload({
    code_review_rate_limit: {
      primary_window: { used_percent: 5, reset_at: reset, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 12, reset_at: reset, limit_window_seconds: 18000 },
    },
  }, now);
  expect(windows).toEqual([
    { id: "review-weekly", scope: "code-review", percentLeft: 95, resetsAt: reset },
    { id: "review-five-hour", scope: "code-review", percentLeft: 88, resetsAt: reset },
  ]);
});

test("a Codex reply with relative resets counts them from the read time", async () => {
  const windows = parseCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 29, reset_at: 1783374300, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 57, reset_after_seconds: 3600 },
    },
  }, now);
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 71, resetsAt: new Date(1783374300 * 1000).toISOString() },
    { id: "weekly", scope: "all", percentLeft: 43, resetsAt: "2030-01-01T01:00:00.000Z" },
  ]);
});

test("a Codex reply with an exhausted model bucket keeps that bucket, not just the shared windows", async () => {
  const windows = parseCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 15, reset_at: 1783374300, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 48, reset_after_seconds: 3600 },
    },
    code_review_rate_limit: {
      primary_window: { used_percent: 5, reset_after_seconds: 1800 },
      secondary_window: { used_percent: 12, reset_after_seconds: 7200 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-Preview-Spark",
        metered_feature: "codex_previewfeature",
        rate_limit: {
          primary_window: { used_percent: 33, reset_after_seconds: 1200 },
          secondary_window: { used_percent: 70, reset_after_seconds: 5400 },
        },
      },
    ],
  }, now);
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 85, resetsAt: new Date(1783374300 * 1000).toISOString() },
    { id: "weekly", scope: "all", percentLeft: 52, resetsAt: "2030-01-01T01:00:00.000Z" },
    { id: "review-five-hour", scope: "code-review", percentLeft: 95, resetsAt: "2030-01-01T00:30:00.000Z" },
    { id: "review-weekly", scope: "code-review", percentLeft: 88, resetsAt: "2030-01-01T02:00:00.000Z" },
    { id: "model-codex_previewfeature-5h", scope: "codex_previewfeature", percentLeft: 67, resetsAt: "2030-01-01T00:20:00.000Z" },
    { id: "model-codex_previewfeature-7d", scope: "codex_previewfeature", percentLeft: 30, resetsAt: "2030-01-01T01:30:00.000Z" },
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

test("a rejected Codex pass that expired mid-read still probes both addresses before reading unchecked", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    calls.push(url);
    return Promise.resolve(statusResponse(401));
  };
  const credentials = parseCodexCredentials(JSON.stringify({ tokens: { access_token: fakeJwt(now / 1000 + 1) } }));
  if (!credentials) throw new Error("test credential rejected");
  expect(credentials.expiresAt).toBe(now + 1000);
  const program = Effect.gen(function*() {
    yield* TestClock.setTime(now + 5000);
    return yield* requestCodexReading(credentials, fetchImpl, now);
  }).pipe(Effect.provide(TestClock.layer()));
  const reading = await Effect.runPromise(program);
  expect(calls.length).toBe(2);
  expect(reading).toEqual({ code: "auth_unverified" });
});

test("a rejection followed by a miss does not read as unchecked when the pass was valid", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = (url) => {
    calls.push(url);
    return Promise.resolve(statusResponse(url.endsWith("/wham/usage") ? 401 : 404));
  };
  const program = Effect.gen(function*() {
    yield* TestClock.setTime(now);
    return yield* requestCodexReading({ accessToken: "live-token", expiresAt: now + 60000 }, fetchImpl, now);
  }).pipe(Effect.provide(TestClock.layer()));
  const reading = await Effect.runPromise(program);
  expect(calls.length).toBe(2);
  expect(reading).toEqual({ code: "auth_required" });
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

test("an unrelated OpenCode entry does not block the enrolled Go key", async () => {
  expect(parseOpenCodeKey(JSON.stringify({ "opencode-go": { key: "go-key" }, opencode: { key: "other" } }))).toBe("go-key");
  expect(parseOpenCodeKey(JSON.stringify({ "opencode-go": { key: "go-key" } }))).toBe("go-key");
});

test("an OpenCode rejection reads as login needed, not unchecked", async () => {
  const fetchImpl: FetchImpl = () => Promise.resolve(statusResponse(403));
  const reading = await Effect.runPromise(requestOpenCodeReading("go-key", fetchImpl, now));
  expect(reading).toEqual({ code: "auth_required" });
});

test("an OpenCode usage reply maps rolling and weekly to separate windows", async () => {
  const windows = parseOpenCodeUsagePayload({ usage: { rollingUsage: { percentRemaining: 40, resetsAt: reset, windowSeconds: 18000 }, weeklyUsage: { percent: 88, resetsAt: reset } } }, now);
  expect(windows).toEqual([
    { id: "five-hour", scope: "all", percentLeft: 40, resetsAt: reset },
    { id: "weekly", scope: "all", percentLeft: 12, resetsAt: reset },
  ]);
});

test("an OpenCode reply without a rolling duration keeps rolling separate from five-hour", async () => {
  const windows = parseOpenCodeUsagePayload({
    rollingUsage: { usagePercent: 18, resetInSec: 3600 },
    weeklyUsage: { usagePercent: 42, resetInSec: 604800 },
    monthlyUsage: { usagePercent: 7, resetInSec: 2592000 },
  }, now);
  expect(windows).toEqual([
    { id: "rolling", scope: "all", percentLeft: 82, resetsAt: "2030-01-01T01:00:00.000Z" },
    { id: "weekly", scope: "all", percentLeft: 58, resetsAt: "2030-01-08T00:00:00.000Z" },
    { id: "monthly", scope: "all", percentLeft: 93, resetsAt: "2030-01-31T00:00:00.000Z" },
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
