import { expect, test } from "bun:test";
import {
  parseCodexCredentials,
  parseCodexUsagePayload,
  parseOpenCodeKey,
  parseOpenCodeUsagePayload,
} from "../../src/usage";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const reset = "2030-01-02T00:00:00.000Z";

test("Codex credentials preserve each account-ID alias instead of losing the selected account", () => {
  for (const tokenField of ["access_token", "accessToken"]) {
    for (const accountField of ["account_id", "accountId"]) {
      for (const atRoot of [true, false]) {
        const account = { [accountField]: "synthetic-account" };
        const tokens = { [tokenField]: "synthetic-access", ...(atRoot ? {} : account) };
        expect(parseCodexCredentials(JSON.stringify({ tokens, ...(atRoot ? account : {}) }))).toEqual({
          accessToken: "synthetic-access", accountId: "synthetic-account",
        });
      }
    }
  }
});

test("Codex credentials reject malformed token containers rather than accepting another record", () => {
  for (const raw of [null, [], "synthetic-access", {}, { access_token: "synthetic-access" }]) {
    expect(parseCodexCredentials(JSON.stringify(raw))).toBeUndefined();
  }
  for (const tokens of [null, [], "synthetic-access", {}]) {
    expect(parseCodexCredentials(JSON.stringify({ tokens }))).toBeUndefined();
  }
  for (const field of ["access_token", "accessToken"]) {
    for (const token of ["", 7, false, [], {}]) {
      expect(parseCodexCredentials(JSON.stringify({ tokens: { [field]: token } }))).toBeUndefined();
    }
  }
  expect(parseCodexCredentials("{")).toBeUndefined();
  expect(parseCodexCredentials(JSON.stringify({ tokens: { accessToken: "synthetic-access" } }))).toEqual({
    accessToken: "synthetic-access",
  });
});

test("Codex credentials reject invalid account IDs rather than silently dropping account selection", () => {
  for (const field of ["account_id", "accountId"]) {
    for (const value of ["", 7, false, [], {}]) {
      for (const atRoot of [true, false]) {
        const account = { [field]: value };
        const tokens = { access_token: "synthetic-access", ...(atRoot ? {} : account) };
        expect(parseCodexCredentials(JSON.stringify({ tokens, ...(atRoot ? account : {}) }))).toBeUndefined();
      }
    }
  }
});

test("a selected Pi Codex login cannot be replaced by a different tokens login", () => {
  const tokens = { access_token: "synthetic-other" };
  expect(parseCodexCredentials(JSON.stringify({
    "openai-codex": { type: "oauth", access: "synthetic-pi", accountId: "synthetic-pi-account", expires: now },
    tokens,
  }))).toEqual({ accessToken: "synthetic-pi", accountId: "synthetic-pi-account", expiresAt: now });
  for (const login of [null, [], {}, { type: "api_key", access: "synthetic-pi" }]) {
    expect(parseCodexCredentials(JSON.stringify({ "openai-codex": login, tokens }))).toBeUndefined();
  }
});

test("JWT expiry uses NumericDate seconds rather than milliseconds and keeps epoch zero", () => {
  for (const [exp, expiresAt] of [[0, 0], [1_893_456_000, now], [1_893_456_000.5, now + 500]]) {
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    const accessToken = `synthetic.${payload}.signature`;
    for (const account of [{}, { account_id: "synthetic-account" }]) {
      expect(parseCodexCredentials(JSON.stringify({ tokens: { access_token: accessToken, ...account } }))).toEqual({
        accessToken, ...(account.account_id ? { accountId: account.account_id } : {}), expiresAt,
      });
    }
  }
});

test("missing or invalid JWT expiry leaves the token usable without inventing an expiry", () => {
  for (const claims of [null, [], {}, { exp: null }, { exp: "1893456000" }, { exp: false }]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const accessToken = `synthetic.${payload}.signature`;
    expect(parseCodexCredentials(JSON.stringify({ tokens: { access_token: accessToken } }))).toEqual({ accessToken });
  }
  for (const accessToken of ["synthetic-opaque", "synthetic..signature", "synthetic.!.signature"]) {
    expect(parseCodexCredentials(JSON.stringify({ tokens: { access_token: accessToken } }))).toEqual({ accessToken });
  }
});

test("Codex duration labels follow the duration in both positions and every scope, not the position alone", () => {
  const cases = [
    { seconds: 18_000, shared: "five-hour", review: "review-five-hour", named: "model-spark-5h" },
    { seconds: 604_800, shared: "weekly", review: "review-weekly", named: "model-spark-7d" },
    { seconds: 3_600, shared: "window-3600s", review: "review-window-3600s", named: "model-spark-window-3600s" },
    { seconds: 0, shared: "window-0s", review: "review-window-0s", named: "model-spark-window-0s" },
  ];
  for (const { seconds, shared, review, named } of cases) {
    for (const { field, scope, id } of [
      { field: "rate_limit", scope: "all", id: shared },
      { field: "code_review_rate_limit", scope: "code-review", id: review },
      { field: "named", scope: "spark", id: named },
    ]) {
      for (const position of ["primary_window", "secondary_window"]) {
        const pair = { [position]: { used_percent: 25, limit_window_seconds: seconds } };
        const raw = field === "named"
          ? { additional_rate_limits: [{ metered_feature: "spark", rate_limit: pair }] }
          : { [field]: pair };
        expect(parseCodexUsagePayload(raw, now)).toEqual([
          { id, scope, percentLeft: 75, resetsAt: null },
        ]);
      }
    }
  }
});

test("invalid Codex durations keep positional labels rather than inventing fractional or negative windows", () => {
  for (const seconds of [undefined, null, "18000", -1, 18_000.5, NaN, Infinity]) {
    expect(parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: seconds },
        secondary_window: { used_percent: 100, limit_window_seconds: seconds },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: seconds },
        secondary_window: { used_percent: 100, limit_window_seconds: seconds },
      },
      additional_rate_limits: [{
        limit_name: "spark",
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: seconds },
          secondary_window: { used_percent: 100, limit_window_seconds: seconds },
        },
      }],
    }, now)).toEqual([
      { id: "five-hour", scope: "all", percentLeft: 100, resetsAt: null },
      { id: "weekly", scope: "all", percentLeft: 0, resetsAt: null },
      { id: "review-five-hour", scope: "code-review", percentLeft: 100, resetsAt: null },
      { id: "review-weekly", scope: "code-review", percentLeft: 0, resetsAt: null },
      { id: "model-spark-5h", scope: "spark", percentLeft: 100, resetsAt: null },
      { id: "model-spark-7d", scope: "spark", percentLeft: 0, resetsAt: null },
    ]);
  }
});

test("Codex resets distinguish seconds, milliseconds and ISO offsets instead of shifting the date", () => {
  const resets: [number | string, string][] = [
    [1_893_542_400, reset],
    [1_893_542_400_000, reset],
    [1_000_000_000_000, "2001-09-09T01:46:40.000Z"],
    ["2030-01-02T02:00:00+02:00", reset],
  ];
  for (const [reset_at, resetsAt] of resets) {
    expect(parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 40, reset_at } },
    }, now)).toEqual([{ id: "five-hour", scope: "all", percentLeft: 60, resetsAt }]);
  }
  for (const reset_after_seconds of ["60", NaN, Infinity, {}]) {
    expect(parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 40, reset_after_seconds } },
    }, now)).toBeUndefined();
  }
});

test("a malformed Codex sibling invalidates the reply instead of disappearing behind a usable window", () => {
  const valid = { used_percent: 25 };
  for (const bad of [false, [], "bad", {}, { used_percent: -1 }, { used_percent: 101 }, { used_percent: "25" }]) {
    for (const field of ["rate_limit", "code_review_rate_limit", "named"]) {
      for (const position of ["primary_window", "secondary_window"]) {
        const pair = { primary_window: valid, secondary_window: valid, [position]: bad };
        const raw = field === "named"
          ? { rate_limit: { primary_window: valid }, additional_rate_limits: [{ limit_name: "spark", rate_limit: pair }] }
          : { [field]: pair };
        expect(parseCodexUsagePayload(raw, now)).toBeUndefined();
      }
    }
  }
  for (const field of ["rate_limit", "code_review_rate_limit", "additional_rate_limits"]) {
    for (const bad of [false, "bad", 1]) {
      expect(parseCodexUsagePayload({ rate_limit: { primary_window: valid }, [field]: bad }, now)).toBeUndefined();
    }
  }
});

test("absent Codex containers and windows do not fabricate readings or hide a present secondary window", () => {
  for (const raw of [null, [], {}, { rate_limit: {} }, { additional_rate_limits: [] }]) {
    expect(parseCodexUsagePayload(raw, now)).toBeUndefined();
  }
  for (const absent of [undefined, null]) {
    expect(parseCodexUsagePayload({
      rate_limit: { primary_window: absent, secondary_window: { used_percent: 75 } },
      code_review_rate_limit: absent, additional_rate_limits: absent,
    }, now)).toEqual([{ id: "weekly", scope: "all", percentLeft: 25, resetsAt: null }]);
  }
});

test("named Codex limits normalize labels instead of losing the scope", () => {
  for (const [name, slug] of [
    ["  __Code--Review!!  ", "code_review"],
    ["A".repeat(49), "a".repeat(48)],
    ["9--Spark", "9_spark"],
  ]) {
    expect(parseCodexUsagePayload({
      additional_rate_limits: [{
        metered_feature: name,
        rate_limit: { secondary_window: { used_percent: 100 } },
      }],
    }, now)).toEqual([{ id: `model-${slug}-7d`, scope: slug, percentLeft: 0, resetsAt: null }]);
  }
  expect(parseCodexUsagePayload({
    additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 25 } } }],
  }, now)).toEqual([{ id: "model-spark-5h", scope: "spark", percentLeft: 75, resetsAt: null }]);
});

test("unlabelled Codex additions do not invent scopes and malformed labelled additions are not ignored", () => {
  const shared = { rate_limit: { primary_window: { used_percent: 25 } } };
  for (const item of [null, {}, { metered_feature: "!!!" }, { metered_feature: 7 }, { metered_feature: "spark" }, { metered_feature: "spark", rate_limit: null }]) {
    expect(parseCodexUsagePayload({ ...shared, additional_rate_limits: [item] }, now)).toEqual([
      { id: "five-hour", scope: "all", percentLeft: 75, resetsAt: null },
    ]);
  }
  for (const item of [false, [], { metered_feature: "spark", rate_limit: false }]) {
    expect(parseCodexUsagePayload({ ...shared, additional_rate_limits: [item] }, now)).toBeUndefined();
  }
});

test("every OpenCode duration alias identifies five hours without treating invalid durations as five hours", () => {
  for (const field of ["windowSeconds", "window_seconds", "cycleSeconds", "cycle_seconds", "durationSeconds", "duration_seconds", "periodSeconds", "period_seconds"]) {
    const durations: [number | string | null, string][] = [
      [18_000, "five-hour"], [0, "rolling"], [604_800, "rolling"], [-1, "rolling"],
      [18_000.5, "rolling"], ["18000", "rolling"], [NaN, "rolling"], [Infinity, "rolling"], [null, "rolling"],
    ];
    for (const [duration, id] of durations) {
      expect(parseOpenCodeUsagePayload({ rollingUsage: { percentRemaining: 25, [field]: duration } }, now)).toEqual([
        { id, scope: "all", percentLeft: 25, resetsAt: null },
      ]);
    }
  }
});

test("OpenCode absolute reset aliases preserve UTC dates", () => {
  for (const field of ["resetsAt", "resetAt", "reset_at", "nextResetTime"]) {
    for (const absolute of [reset, "2030-01-02T02:00:00+02:00", 1_893_542_400, 1_893_542_400_000]) {
      expect(parseOpenCodeUsagePayload({
        rollingUsage: { percentRemaining: 25, [field]: absolute },
      }, now)).toEqual([{ id: "rolling", scope: "all", percentLeft: 25, resetsAt: reset }]);
    }
  }
});

test("OpenCode relative reset aliases count from now, keep zero and reject negative or nonnumeric delays", () => {
  for (const field of ["resetInSec", "reset_in_sec"]) {
    for (const [delay, resetsAt] of [[0, "2030-01-01T00:00:00.000Z"], [90, "2030-01-01T00:01:30.000Z"]] as const) {
      expect(parseOpenCodeUsagePayload({
        rollingUsage: { percentRemaining: 25, [field]: delay },
      }, now)).toEqual([{ id: "rolling", scope: "all", percentLeft: 25, resetsAt }]);
    }
    for (const delay of [-1, "60", false, NaN, Infinity]) {
      expect(parseOpenCodeUsagePayload({ rollingUsage: { percentRemaining: 25, [field]: delay } }, now)).toBeUndefined();
    }
  }
});

test("OpenCode bucket aliases and nesting keep monthly and weekly separate from rolling", () => {
  for (const [name, id] of [
    ["rollingUsage", "rolling"], ["rolling", "rolling"],
    ["weeklyUsage", "weekly"], ["weekly", "weekly"],
    ["monthlyUsage", "monthly"], ["monthly", "monthly"],
  ]) {
    for (const nested of [true, false]) {
      const bucket = { [name]: { percentRemaining: 25 } };
      expect(parseOpenCodeUsagePayload(nested ? { usage: bucket } : bucket, now)).toEqual([
        { id, scope: "all", percentLeft: 25, resetsAt: null },
      ]);
    }
  }
  expect(parseOpenCodeUsagePayload({
    rollingUsage: { percentRemaining: 20 }, weeklyUsage: { percentUsed: 25 },
    monthlyUsage: { percentRemaining: 10 },
  }, now)).toEqual([
    { id: "rolling", scope: "all", percentLeft: 20, resetsAt: null },
    { id: "weekly", scope: "all", percentLeft: 75, resetsAt: null },
    { id: "monthly", scope: "all", percentLeft: 10, resetsAt: null },
  ]);
});

const bucketNames = ["rollingUsage", "rolling", "weeklyUsage", "weekly", "monthlyUsage", "monthly"];

const bothShapes = (buckets: object): object[] => [{ usage: buckets }, buckets];

test("OpenCode malformed sibling buckets invalidate the reply instead of returning partial quota", () => {
  for (const name of bucketNames) {
    for (const bad of [false, [], "bad", {}, { percentRemaining: 101 }]) {
      for (const raw of bothShapes({ [name]: bad })) {
        expect(parseOpenCodeUsagePayload(raw, now)).toBeUndefined();
      }
    }
    const sibling = name.startsWith("rolling") ? "weeklyUsage" : "rollingUsage";
    for (const raw of bothShapes({ [sibling]: { percentRemaining: 25 }, [name]: false })) {
      expect(parseOpenCodeUsagePayload(raw, now)).toBeUndefined();
    }
  }
  for (const raw of [null, [], {}, { usage: [] }, { usage: false }, { usage: {} }]) {
    expect(parseOpenCodeUsagePayload(raw, now)).toBeUndefined();
  }
  expect(parseOpenCodeUsagePayload({ usage: null, rollingUsage: null, weeklyUsage: { percentRemaining: 25 } }, now)).toEqual([
    { id: "weekly", scope: "all", percentLeft: 25, resetsAt: null },
  ]);
});

test("OpenCode remaining percentages are not inverted and used percentages are not mistaken for remaining", () => {
  for (const field of ["percentRemaining", "remainingPercent", "percent", "percentUsed", "usedPercent", "usagePercent"]) {
    for (const [value, remaining, used] of [[0, 0, 100], [25, 25, 75], [100, 100, 0]]) {
      expect(parseOpenCodeUsagePayload({ rollingUsage: { [field]: value } }, now)).toEqual([
        { id: "rolling", scope: "all", percentLeft: field === "percentRemaining" || field === "remainingPercent" ? remaining : used, resetsAt: null },
      ]);
    }
    for (const value of [-1, 101, "25", NaN, Infinity]) {
      expect(parseOpenCodeUsagePayload({ rollingUsage: { [field]: value } }, now)).toBeUndefined();
    }
  }
  expect(parseOpenCodeUsagePayload({ rollingUsage: { status: "RATE-LIMITED" } }, now)).toEqual([
    { id: "rolling", scope: "all", percentLeft: 0, resetsAt: null },
  ]);
  expect(parseOpenCodeUsagePayload({ rollingUsage: { status: "ok" } }, now)).toBeUndefined();
});

test("OpenCode key aliases preserve the Go key rather than reading an unrelated provider", () => {
  for (const field of ["key", "apiKey", "api_key"]) {
    expect(parseOpenCodeKey(JSON.stringify({
      "opencode-go": { [field]: "synthetic-go" }, opencode: { key: "synthetic-other" },
    }))).toBe("synthetic-go");
  }
});

test("OpenCode keys reject malformed records and whitespace instead of sending a broken authorization value", () => {
  for (const raw of [null, [], {}, { "opencode-go": [] }, { "opencode-go": "synthetic-go" }, { opencode: { key: "synthetic-other" } }]) {
    expect(parseOpenCodeKey(JSON.stringify(raw))).toBeUndefined();
  }
  for (const field of ["key", "apiKey", "api_key"]) {
    for (const key of ["", 7, false, " synthetic-go", "synthetic-go ", "synthetic\tgo", "synthetic\ngo", "synthetic\u00a0go"]) {
      expect(parseOpenCodeKey(JSON.stringify({ "opencode-go": { [field]: key } }))).toBeUndefined();
    }
  }
  expect(parseOpenCodeKey("{")).toBeUndefined();
});
