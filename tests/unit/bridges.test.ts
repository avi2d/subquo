import { expect, test } from "bun:test";
import { parseClauthReading, parseQuotaAxiReading } from "../../src/bridges";

const stamp = "2030-01-01T00:00:00Z";
const reset = "2030-01-02T00:00:00Z";

function profile(name: string, used: number, authStatus = "ok") {
  return {
    name, provider: "anthropic", stale: false, fetched_at: stamp, auth_status: authStatus,
    fetch_status: "Fresh", windows: [{ label: "5h", utilization_pct: used, resets_at: reset }],
  };
}

test("the clauth bridge does not use the active profile or date a cached reading now", () => {
  const json = JSON.stringify({
    active_profile: "other",
    profiles: [profile("other", 4), profile("selected", 60)],
  });
  expect(parseClauthReading(json, "selected")).toEqual({
    observedAt: "2030-01-01T00:00:00.000Z",
    windows: [{ id: "five-hour", scope: "all", percentLeft: 40, resetsAt: "2030-01-02T00:00:00.000Z" }],
  });
  expect(parseClauthReading(json, "missing")).toEqual({ code: "auth_required" });
});

test("an expired clauth login is not reported as signed out or available", () => {
  const json = JSON.stringify({ profiles: [profile("selected", 40, "expired")] });
  expect(parseClauthReading(json, "selected")).toEqual({ code: "auth_unverified" });
});

function providerRow() {
  return {
    provider: "codex",
    source: "oauth",
    account: { bearer: crypto.randomUUID() },
    state: { status: "fresh", stale: false, refreshedAt: stamp },
    windows: [
      { kind: "weekly", id: "weekly", percentRemaining: 12, resetsAt: reset },
      { kind: "weekly", id: "code_review_weekly", percentRemaining: 67, resetsAt: reset },
    ],
  };
}

test("the quota-axi bridge does not copy private fields or make code review a shared limit", () => {
  const row = providerRow();
  expect(parseQuotaAxiReading(JSON.stringify({ providers: [row] }), "codex")).toEqual({
    observedAt: "2030-01-01T00:00:00.000Z",
    windows: [
      { id: "weekly", scope: "all", percentLeft: 12, resetsAt: "2030-01-02T00:00:00.000Z" },
      { id: "review-weekly", scope: "code-review", percentLeft: 67, resetsAt: "2030-01-02T00:00:00.000Z" },
    ],
  });
});

test("the quota-axi bridge does not take the first row of an ambiguous account response", () => {
  const json = JSON.stringify({ providers: [providerRow(), providerRow()] });
  expect(parseQuotaAxiReading(json, "codex")).toEqual({ code: "auth_unverified" });
});
