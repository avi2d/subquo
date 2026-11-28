import { Clock, Effect } from "effect";
import { type Account, type FailureCode, type Snapshot, type Windows, loginWarningAt, measuredObservation } from "./index";

export type Reading = { readonly loginExpiresAt?: number | null } & (
  | { readonly observedAt: string; readonly windows: typeof Windows.Type }
  | { readonly code: FailureCode }
);

type Collector<R> = Pick<Account, "id" | "provider"> & { readonly read: Effect.Effect<Reading, never, R> };

function accountWindows(provider: Account["provider"], windows: typeof Windows.Type): typeof Windows.Type {
  if (provider === "opencode-go" || windows.some(({ id }) => id === "five-hour")) return windows;
  return [...windows, { id: "five-hour", scope: "all", status: "not_returned", percentLeft: null, resetsAt: null }];
}

const accountLimitMs = 5_000;
const cycleLimitMs = 10_000;
const maxConcurrentAccounts = 8;
const timedOut = Effect.succeed<Reading>({ code: "timeout" });

export const collectSnapshot = Effect.fnUntraced(function*<R>(collectors: readonly Collector<R>[]) {
  const deadline = (yield* Clock.currentTimeMillis) + cycleLimitMs;
  const readings = yield* Effect.forEach(collectors, ({ id, provider, read }) =>
    Effect.gen(function*() {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      const reading = remaining <= 0 ? yield* timedOut : yield* read.pipe(
        Effect.catchDefect(() => Effect.succeed<Reading>({ code: "auth_unverified" })),
        Effect.timeoutOrElse({ duration: Math.min(remaining, accountLimitMs), orElse: () => timedOut }),
      );
      return { id, provider, reading };
    }), { concurrency: maxConcurrentAccounts },
  );
  const now = yield* Clock.currentTimeMillis;
  return {
    version: "subquo.v1",
    writtenAt: new Date(now).toISOString(),
    accounts: readings.map(({ id, provider, reading }): Account => {
      const expiry = reading.loginExpiresAt;
      const days = typeof expiry === "number" ? loginWarningAt(expiry, now) : expiry;
      return {
        id,
        provider,
        observation: "code" in reading
          ? { status: "unavailable", code: reading.code }
          : measuredObservation(reading.observedAt, accountWindows(provider, reading.windows), now),
        ...(days === undefined ? {} : { loginEndsInDays: days }),
      };
    }),
  } satisfies Snapshot;
});
