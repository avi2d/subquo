import { expect, test } from "bun:test";
import { Effect } from "effect";
import { compareClaude, parseClAuthStatus } from "../../src/compare";
import { measuredObservation, type Account, type QuotaWindow } from "../../src/index";

const observedAt = "2030-01-01T00:00:00.000Z";
const now = Date.parse(observedAt);
const resetsAt = "2030-01-01T01:00:00.000Z";
const fiveHour = { id: "five-hour", scope: "all", percentLeft: 75, resetsAt } satisfies QuotaWindow;
const enrolled = { id: "example", clauth_profile: "fake-profile" };
const window = { label: "5h", utilization_pct: 25, resets_at: resetsAt };

function reading(quota: QuotaWindow = fiveHour): Account {
  return { id: enrolled.id, provider: "claude", observation: measuredObservation(observedAt, [quota], now) };
}

function decodeReference(
  windows: readonly (typeof window)[] = [window],
  options: { readonly observedAt?: string; readonly stale?: boolean } = {},
) {
  const timestamp = options.observedAt ?? observedAt;
  return Effect.runPromise(parseClAuthStatus(JSON.stringify({
    schema: 1,
    generated_at: timestamp,
    profiles: [{
      name: enrolled.clauth_profile, provider: "anthropic", harness: "claude", base_url: null,
      windows, stale: options.stale ?? false, fetched_at: timestamp,
    }],
  })));
}

test("an equal instant and exactly one percentage point of drift do not fail the comparison", async () => {
  const input = await decodeReference([{ ...window, utilization_pct: 24, resets_at: "2030-01-01T02:00:00+01:00" }]);
  const report = compareClaude([enrolled], { accounts: [reading()] }, input, now);
  expect(report.matched).toBe(true);
  expect(report.text).toContain("example\tfive-hour\t75%, reset 2030-01-01T01:00:00.000Z, fresh\t76%, reset 2030-01-01T01:00:00.000Z, fresh\tMATCH");
});

test("a higher percentage left beyond the tolerance does not look like a match", async () => {
  const input = await decodeReference([{ ...window, utilization_pct: 30 }]);
  const report = compareClaude([enrolled], { accounts: [reading()] }, input, now);
  expect(report.matched).toBe(false);
  expect(report.text).toContain("WORSE: difference exceeds 1 percentage point");
});

test("equal percentages with different reset times do not look like the same window", async () => {
  const input = await decodeReference([{ ...window, resets_at: "2030-01-01T02:00:00Z" }]);
  const report = compareClaude([enrolled], { accounts: [reading()] }, input, now);
  expect(report.matched).toBe(false);
  expect(report.text).toContain("WORSE: different window");
});

test("neither a missing subquo row nor an unknown reset can pass as a match", async () => {
  const input = await decodeReference();
  for (const accounts of [[], [reading({ ...fiveHour, resetsAt: null })]]) {
    const report = compareClaude([enrolled], { accounts }, input, now);
    expect(report.matched).toBe(false);
    expect(report.text).toContain("WORSE: missing value");
  }
});

test("a saved fresh flag does not conceal that its subquo deadline has passed", async () => {
  const current = Date.parse("2030-01-01T00:02:00.000Z");
  const input = await decodeReference([window], { observedAt: "2030-01-01T00:02:00.000Z" });
  const report = compareClaude([enrolled], { accounts: [reading()] }, input, current);
  expect(report.matched).toBe(false);
  expect(report.text).toContain("WORSE: stale value");
});

test("a stale clauth baseline cannot clear the comparison", async () => {
  const input = await decodeReference([window], { stale: true });
  const report = compareClaude([enrolled], { accounts: [reading()] }, input, now);
  expect(report.matched).toBe(false);
  expect(report.text).toContain("UNCHECKED: no current clauth value");
});

test("an unmatched clauth window cannot disappear or print its raw label", async () => {
  const other = { ...window, label: "fake-private-label" };
  const report = compareClaude([enrolled], { accounts: [reading()] }, await decodeReference([window, other]), now);
  expect(report.matched).toBe(false);
  expect(report.text).toContain("example\tunmapped-clauth-2\tmissing\t");
  expect(report.text).toContain("WORSE: missing value, different window");
  expect(report.text).not.toContain(other.label);
  expect(report.text).not.toContain(enrolled.clauth_profile);
});
