import { Clock, Effect, FileSystem, Predicate, Result } from "effect";
import type { EnrolledAccount } from "./accounts";
import { readKeychainPassword } from "./keychain";
import type { Reading } from "./collect";
import {
  measuredAt,
  parseClaudeCredentials,
  parseClaudeUsagePayload,
  parseCodexCredentials,
  parseCodexUsagePayload,
  parseJson,
  parseOpenCodeKey,
  parseOpenCodeUsagePayload,
  type ClaudeCredentials,
  type CodexCredentials,
} from "./usage";

const ClaudeUsageUrl = "https://api.anthropic.com/api/oauth/usage";
const CodexUsageUrls = ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/codex/usage"];
const OpenCodeUsageUrl = "https://opencode.ai/zen/go/v1/usage";

type FetchInit = { readonly headers: Record<string, string>; readonly signal: AbortSignal };
export type FetchImpl = (url: string, init: FetchInit) => Promise<Response>;

type FetchOutcome =
  | { readonly kind: "limited" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "unverified" }
  | { readonly kind: "response"; readonly response: Response };

function expiredAtRejection(expiresAt: number | undefined, rejectedAt: number): boolean {
  return expiresAt !== undefined && expiresAt <= rejectedAt;
}

const required: Reading = { code: "auth_required" };
const limited: Reading = { code: "rate_limited" };
const timedOut: Reading = { code: "timeout" };
const unverified: Reading = { code: "auth_unverified" };

function aborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function attemptFetch(url: string, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<FetchOutcome> {
  return fetchImpl(url, { headers, signal: AbortSignal.timeout(4500) }).then(
    (response) => (response.status === 429 ? { kind: "limited" } : { kind: "response", response }),
    (error: unknown) => (aborted(error) ? { kind: "timedOut" } : { kind: "unverified" }),
  );
}

const fetchOutcome = (url: string, headers: Record<string, string>, fetchImpl: FetchImpl) =>
  Effect.promise(() => attemptFetch(url, headers, fetchImpl));

const readBody = Effect.fnUntraced(function*(response: Response) {
  const text = yield* Effect.promise(() => response.text().then((value) => value, () => undefined));
  return text;
});

export const requestClaudeReading = Effect.fnUntraced(function*(
  credentials: ClaudeCredentials,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
) {
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now) return unverified;
  const outcome = yield* fetchOutcome(ClaudeUsageUrl, {
    authorization: "Bearer " + credentials.accessToken,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.202",
    accept: "application/json",
  }, fetchImpl);
  if (outcome.kind !== "response") return outcome.kind === "limited" ? limited : outcome.kind === "timedOut" ? timedOut : unverified;
  if (outcome.response.status === 401) {
    const rejectedAt = yield* Clock.currentTimeMillis;
    return expiredAtRejection(credentials.expiresAt, rejectedAt) ? unverified : required;
  }
  if (!outcome.response.ok) return unverified;
  const text = yield* readBody(outcome.response);
  if (text === undefined) return unverified;
  const windows = parseClaudeUsagePayload(parseJson(text));
  if (!windows) return unverified;
  return measuredAt(new Date(now).toISOString(), windows);
});

const attemptCodexEndpoint = Effect.fnUntraced(function*(
  url: string,
  credentials: CodexCredentials,
  fetchImpl: FetchImpl,
  now: number,
) {
  const headers: Record<string, string> = { authorization: "Bearer " + credentials.accessToken, accept: "application/json" };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  const outcome = yield* fetchOutcome(url, headers, fetchImpl);
  if (outcome.kind !== "response") {
    if (outcome.kind === "limited") return { kind: "done", reading: limited } as const;
    if (outcome.kind === "timedOut") return { kind: "done", reading: timedOut } as const;
    return { kind: "next" } as const;
  }
  if (outcome.response.status === 401 || outcome.response.status === 403) {
    const rejectedAt = yield* Clock.currentTimeMillis;
    return { kind: "rejected", expired: expiredAtRejection(credentials.expiresAt, rejectedAt) } as const;
  }
  if (!outcome.response.ok) return { kind: "next" } as const;
  const text = yield* readBody(outcome.response);
  if (text === undefined) return { kind: "next" } as const;
  const windows = parseCodexUsagePayload(parseJson(text), now);
  if (!windows) return { kind: "next" } as const;
  return { kind: "done", reading: measuredAt(new Date(now).toISOString(), windows) } as const;
});
export const requestCodexReading = Effect.fnUntraced(function*(
  credentials: CodexCredentials,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
) {
  let rejection: boolean | undefined;
  for (const url of CodexUsageUrls) {
    const attempt = yield* attemptCodexEndpoint(url, credentials, fetchImpl, now);
    if (attempt.kind === "done") return attempt.reading;
    if (attempt.kind === "rejected" && rejection === undefined) rejection = attempt.expired;
  }
  if (rejection === undefined) return unverified;
  return rejection ? unverified : required;
});

export const requestOpenCodeReading = Effect.fnUntraced(function*(
  key: string,
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now(),
) {
  const outcome = yield* fetchOutcome(OpenCodeUsageUrl, { authorization: "Bearer " + key, accept: "application/json" }, fetchImpl);
  if (outcome.kind !== "response") return outcome.kind === "limited" ? limited : outcome.kind === "timedOut" ? timedOut : unverified;
  if (outcome.response.status === 401 || outcome.response.status === 403) return required;
  if (!outcome.response.ok) return unverified;
  const text = yield* readBody(outcome.response);
  if (text === undefined) return unverified;
  const windows = parseOpenCodeUsagePayload(parseJson(text), now);
  if (!windows) return unverified;
  return measuredAt(new Date(now).toISOString(), windows);
});
const readKeychainContent = Effect.fnUntraced(function*(
  login: Extract<EnrolledAccount["login"], { readonly store: "macos-keychain" }>,
  env: Record<string, string | undefined>,
) {
  return yield* readKeychainPassword(login, env).pipe(Effect.orElseSucceed(() => undefined as string | undefined));
});

const readNamedFile = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.result);
  if (Result.isFailure(info)) return Predicate.isTagged(info.failure.reason, "NotFound") ? required : unverified;
  if (info.success.type !== "File") return unverified;
  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined as string | undefined));
  if (content === undefined) return unverified;
  return content;
});

const readClaudeAccount = Effect.fnUntraced(function*(
  account: Extract<EnrolledAccount, { readonly provider: "claude" }>,
  fetchImpl: FetchImpl,
  env: Record<string, string | undefined>,
  now: number,
) {
  if (account.login.store === "macos-keychain") {
    if (process.platform !== "darwin") return unverified;
    const content = yield* readKeychainContent(account.login, env).pipe(Effect.orElseSucceed(() => undefined as string | undefined));
    if (content === undefined) return unverified;
    const credentials = parseClaudeCredentials(content);
    if (!credentials) return unverified;
    return yield* requestClaudeReading(credentials, fetchImpl, now).pipe(Effect.orElseSucceed(() => unverified));
  }
  const content = yield* readNamedFile(account.login.path);
  if (typeof content !== "string") return content;
  const credentials = parseClaudeCredentials(content);
  if (!credentials) return unverified;
  return yield* requestClaudeReading(credentials, fetchImpl, now).pipe(Effect.orElseSucceed(() => unverified));
});

const readCodexAccount = Effect.fnUntraced(function*(
  file: string,
  fetchImpl: FetchImpl,
  now: number,
) {
  const content = yield* readNamedFile(file);
  if (typeof content !== "string") return content;
  const credentials = parseCodexCredentials(content);
  if (!credentials) return unverified;
  return yield* requestCodexReading(credentials, fetchImpl, now).pipe(Effect.orElseSucceed(() => unverified));
});

const readOpenCodeAccount = Effect.fnUntraced(function*(
  file: string,
  fetchImpl: FetchImpl,
  now: number,
) {
  const content = yield* readNamedFile(file);
  if (typeof content !== "string") return content;
  const key = parseOpenCodeKey(content);
  if (!key) return unverified;
  return yield* requestOpenCodeReading(key, fetchImpl, now).pipe(Effect.orElseSucceed(() => unverified));
});

export const readAccount = Effect.fnUntraced(function*(
  account: EnrolledAccount,
  options: { readonly fetchImpl?: FetchImpl; readonly env?: Record<string, string | undefined> } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = yield* Clock.currentTimeMillis;
  if (account.provider === "claude") return yield* readClaudeAccount(account, fetchImpl, options.env ?? {}, now);
  const file = account.login.path;
  if (account.provider === "codex") return yield* readCodexAccount(file, fetchImpl, now);
  return yield* readOpenCodeAccount(file, fetchImpl, now);
});
