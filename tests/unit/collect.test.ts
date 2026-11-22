import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { collectSnapshot, type Reading } from "../../src/collect";

const observedAt = "2030-01-01T00:00:00.000Z";
const measured = {
  observedAt,
  windows: [{ id: "weekly", scope: "all", percentLeft: 12, resetsAt: "2030-01-02T00:00:00.000Z" }],
} satisfies Reading;

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
