import { Clock, Effect } from "effect";
import { type Account, type FailureCode, type Snapshot, type Windows, measuredObservation } from "./index";

export type Reading =
  | { readonly observedAt: string; readonly windows: typeof Windows.Type; readonly staleCode?: FailureCode | null }
  | { readonly code: FailureCode };

type Collector<R> = Pick<Account, "id" | "provider"> & { readonly read: Effect.Effect<Reading, never, R> };

const accountLimitMs = 5_000;
const cycleLimitMs = 10_000;
const maxConcurrentAccounts = 8;
const timedOut = Effect.succeed({ code: "timeout" } satisfies Reading);

export const collectSnapshot = Effect.fnUntraced(function*<R>(collectors: readonly Collector<R>[]) {
  const deadline = (yield* Clock.currentTimeMillis) + cycleLimitMs;
  const readings = yield* Effect.forEach(collectors, ({ id, provider, read }) =>
    Effect.gen(function*() {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      const reading = remaining <= 0 ? yield* timedOut : yield* read.pipe(
        Effect.catchDefect(() => Effect.succeed({ code: "auth_unverified" } satisfies Reading)),
        Effect.timeoutOrElse({ duration: Math.min(remaining, accountLimitMs), orElse: () => timedOut }),
      );
      return { id, provider, reading };
    }), { concurrency: maxConcurrentAccounts },
  );
  const now = yield* Clock.currentTimeMillis;
  return {
    version: "subquo.v1",
    writtenAt: new Date(now).toISOString(),
    accounts: readings.map(({ id, provider, reading }) => ({
      id,
      provider,
      observation: "code" in reading
        ? { status: "unavailable", code: reading.code }
        : measuredObservation(reading.observedAt, reading.windows, now, reading.staleCode),
    })),
  } satisfies Snapshot;
});
