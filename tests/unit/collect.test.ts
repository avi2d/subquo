import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { collectSnapshot, type Reading } from "../../src/collect";
import { pickEvidenceAt } from "../../src/index";
import { measuredAt, parseClaudeUsagePayload, parseCodexUsagePayload } from "../../src/usage";

const observedAt = "2030-01-01T00:00:00.000Z";
const measured = {
  observedAt,
  windows: [{ id: "weekly", scope: "all", percentLeft: 12, resetsAt: "2030-01-02T00:00:00.000Z" }],
} satisfies Reading;

test("weekly quota does not imply five-hour capacity or a five-hour reset", async () => {
  const providers = ["claude", "codex", "opencode-go"] as const;
  const snapshot = await Effect.runPromise(TestClock.setTime(Date.parse(observedAt)).pipe(
    Effect.andThen(collectSnapshot(providers.map((provider) => ({
      id: `example-${provider}`, provider, read: Effect.succeed(measured),
    })))),
    Effect.provide(TestClock.layer()),
  ));
  const missing = { status: "not_returned", id: "five-hour", scope: "all", percentLeft: null, resetsAt: null } as const;
  expect(snapshot.accounts.map(({ observation }) => observation.status === "fresh" && observation.windows)).toEqual([
    [...measured.windows, missing], [...measured.windows, missing], measured.windows,
  ]);
});

const weeklyReset = "2030-01-02T00:00:00.000Z";
const weeklyUsed30 = { id: "weekly", scope: "all", percentLeft: 70, resetsAt: weeklyReset } as const;
const notReturned = { status: "not_returned", id: "five-hour", scope: "all", percentLeft: null, resetsAt: null } as const;

async function pickFromReply(provider: "claude" | "codex", windows: ReturnType<typeof parseClaudeUsagePayload>) {
  if (windows === undefined) throw new Error("Reply did not parse");
  const snapshot = await Effect.runPromise(TestClock.setTime(Date.parse(observedAt)).pipe(
    Effect.andThen(collectSnapshot([{ id: `example-${provider}`, provider, read: Effect.succeed(measuredAt(observedAt, windows)) }])),
    Effect.provide(TestClock.layer()),
  ));
  const [account] = snapshot.accounts;
  if (account === undefined) throw new Error("Account missing");
  return pickEvidenceAt(account.observation, Date.parse(observedAt))?.windows;
}

test("a five-hour window the vendor left out does not make a weekly-only account unpickable", async () => {
  const claude = parseClaudeUsagePayload({ five_hour: null, seven_day: { utilization: 30, resets_at: weeklyReset } });
  expect(await pickFromReply("claude", claude)).toEqual([weeklyUsed30, notReturned]);
  const weekly = { used_percent: 30, limit_window_seconds: 604_800, reset_at: weeklyReset };
  const codex = parseCodexUsagePayload({ rate_limit: { primary_window: null, secondary_window: weekly } }, Date.parse(observedAt));
  expect(await pickFromReply("codex", codex)).toEqual([weeklyUsed30, notReturned]);
  const unfamiliar = { used_percent: 10, limit_window_seconds: 18_060, reset_at: "2030-01-01T05:01:00.000Z" };
  const odd = parseCodexUsagePayload({ rate_limit: { primary_window: unfamiliar, secondary_window: weekly } }, Date.parse(observedAt));
  expect(await pickFromReply("codex", odd)).toEqual([
    { id: "window-18060s", scope: "all", percentLeft: 90, resetsAt: "2030-01-01T05:01:00.000Z" }, weeklyUsed30, notReturned,
  ]);
});

test("a window the vendor returned without a reset still blocks the pick beside a not-returned five-hour window", async () => {
  const claude = parseClaudeUsagePayload({ seven_day: { utilization: 30, resets_at: null } });
  expect(await pickFromReply("claude", claude)).toBeUndefined();
});

test("a hanging collector does not delay its peer or outlive its five-second budget", async () => {
  const program = Effect.gen(function*() {
    yield* TestClock.setTime(Date.parse(observedAt));
    const peerFinished = yield* Deferred.make<void>();
    const cycle = yield* collectSnapshot([
      { id: "hung", provider: "claude", read: Effect.never },
      { id: "fast", provider: "codex", read: Effect.as(Deferred.succeed(peerFinished, undefined), measured) },
    ]).pipe(Effect.forkChild);

    yield* Deferred.await(peerFinished);
    yield* TestClock.adjust(4_999);
    expect(cycle.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(1);
    const snapshot = yield* Fiber.join(cycle);
    expect(snapshot.writtenAt).toBe("2030-01-01T00:00:05.000Z");
    expect(snapshot.accounts.map(({ id, observation }) => [id, observation.status])).toEqual([
      ["hung", "unavailable"], ["fast", "fresh"],
    ]);
    expect(snapshot.accounts[0].observation).toEqual({ status: "unavailable", code: "timeout" });
  });
  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
});

test("the login warning does not start early, and an ended sign-in counts as zero days instead of reading as healthy", async () => {
  const day = 86_400_000;
  const now = Date.parse(observedAt);
  const expiries = [8 * day, 7 * day + 1, 7 * day, day + 1, 1, 0, -1];
  const program = Effect.gen(function*() {
    yield* TestClock.setTime(now);
    const snapshot = yield* collectSnapshot(expiries.map((left, index) => ({
      id: `example-${index}`,
      provider: "claude",
      read: Effect.succeed({ code: "auth_unverified", loginExpiresAt: now + left } satisfies Reading),
    })));
    return snapshot.accounts.map(({ loginEndsInDays }) => loginEndsInDays);
  });
  expect(await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))).toEqual([
    undefined, undefined, 7, 2, 1, 0, 0,
  ]);
});
