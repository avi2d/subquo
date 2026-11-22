import { Clock, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { claudeDefaultKeychainService, type EnrolledAccount } from "./accounts";
import { readKeychainPassword } from "./keychain";

const ClaudeLogin = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    expiresAt: Schema.Finite,
    refreshToken: Schema.NonEmptyString,
  }),
});
const CodexLogin = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
  }),
});
const Claims = Schema.Struct({ exp: Schema.Finite });
const RpcResponse = Schema.Struct({
  id: Schema.Int,
  result: Schema.optional(Schema.Struct({
    account: Schema.optional(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
  })),
});

const decodeClaude = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeLogin));
const decodeCodex = Schema.decodeUnknownOption(Schema.fromJsonString(CodexLogin));
const decodeClaims = Schema.decodeUnknownOption(Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(Claims))));
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(RpcResponse));

type OAuthProvider = Exclude<EnrolledAccount["provider"], "opencode-go">;
class RenewalUnchecked extends Schema.TaggedError<RenewalUnchecked>()("RenewalUnchecked", {}) {}

const unchecked = () => new RenewalUnchecked();

export function renewalExpiry(provider: OAuthProvider, json: string): number | undefined {
  if (provider === "claude") {
    const login = decodeClaude(json);
    return Option.isSome(login) ? login.value.claudeAiOauth.expiresAt : undefined;
  }
  const login = decodeCodex(json);
  if (Option.isNone(login)) return undefined;
  const parts = login.value.tokens.access_token.split(".");
  const [, encoded] = parts;
  if (parts.length !== 3 || !encoded) return undefined;
  const claims = decodeClaims(encoded);
  return Option.isSome(claims) ? claims.value.exp * 1_000 : undefined;
}

const readKeychain = Effect.fnUntraced(function*(
  login: Extract<EnrolledAccount["login"], { readonly store: "macos-keychain" }>,
  env: Record<string, string | undefined>,
) {
  const content = yield* readKeychainPassword(login, env).pipe(
    Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.fail(unchecked()) }),
  );
  if (content === undefined) return yield* unchecked();
  return content;
});

const runClaude = Effect.fnUntraced(function*(env: Record<string, string | undefined>, configDir: string | undefined) {
  const child = yield* Effect.try({
    try: () => Bun.spawn(["claude", "doctor"], {
      env: configDir === undefined ? env : { ...env, CLAUDE_CONFIG_DIR: configDir },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
    catch: unchecked,
  });
  return yield* Effect.promise(() => child.exited);
});

function rpc(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

const runCodex = Effect.fnUntraced(function*(env: Record<string, string | undefined>, configDir: string) {
  const child = yield* Effect.try({
    try: () => Bun.spawn(["codex", "-c", 'cli_auth_credentials_store="file"', "app-server"], {
      env: { ...env, CODEX_HOME: configDir }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    }),
    catch: unchecked,
  });
  const send = Effect.fnUntraced(function*(message: object) {
    yield* Effect.tryPromise({ try: () => Promise.resolve(child.stdin.write(rpc(message))), catch: unchecked });
    yield* Effect.tryPromise({ try: () => Promise.resolve(child.stdin.flush()), catch: unchecked });
  });
  const closeStdin = Effect.tryPromise({ try: () => Promise.resolve(child.stdin.end()), catch: unchecked })
    .pipe(Effect.orElseSucceed(() => undefined));
  const initialized = send({ method: "initialized" });
  const request = send({ id: 2, method: "account/read", params: { refreshToken: true } });
  let requested = false;
  let accepted = false;
  const response = Stream.fromReadableStream({ evaluate: () => child.stdout, onError: unchecked }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => Effect.gen(function*() {
      const decoded = decodeResponse(line);
      if (Option.isNone(decoded)) return;
      const { id, result } = decoded.value;
      if (id === 1 && !requested) {
        if (result === undefined) {
          yield* closeStdin;
          return;
        }
        requested = true;
        yield* initialized;
        yield* request;
      }
      if (id === 2 && requested) {
        accepted = result?.account?.type === "chatgpt";
        yield* closeStdin;
      }
    })),
  );
  yield* send({ id: 1, method: "initialize", params: { clientInfo: { name: "subquo", version: "1" } } }).pipe(
    Effect.andThen(response),
    Effect.ensuring(closeStdin),
  );
  return (yield* Effect.promise(() => child.exited)) === 0 && accepted;
});

function vendorDir(login: EnrolledAccount["login"], provider: EnrolledAccount["provider"], fileDir: string): string | undefined {
  if (login.store === "file") return fileDir;
  if (provider === "claude" && login.service === claudeDefaultKeychainService) return undefined;
  return login.config_dir;
}

type RenewalResult = "not_needed" | "not_supported" | "renewed" | "auth_required" | "auth_unverified";

export const renewIdleLogin = Effect.fnUntraced(function*(
  account: EnrolledAccount,
  env: Record<string, string | undefined>,
) {
  if (account.provider === "opencode-go") return "not_supported" satisfies RenewalResult;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const login = account.login;
  const read = login.store === "file"
    ? fs.readFileString(login.path)
    : readKeychain(login, env);
  if (account.provider === "claude" && (login.store === "macos-keychain") !== (process.platform === "darwin")) {
    return "auth_unverified" satisfies RenewalResult;
  }
  const expires = yield* read.pipe(Effect.map((json) => renewalExpiry(account.provider, json)));
  if (expires === undefined) return "auth_unverified" satisfies RenewalResult;
  if (expires > (yield* Clock.currentTimeMillis)) return "not_needed" satisfies RenewalResult;

  const fileDir = login.store === "file" ? path.dirname(login.path) : login.config_dir;
  const accepted = account.provider === "claude"
    ? (yield* runClaude(env, vendorDir(login, account.provider, fileDir))) === 0
    : yield* runCodex(env, vendorDir(login, account.provider, fileDir) ?? fileDir);
  const after = yield* read.pipe(Effect.map((json) => renewalExpiry(account.provider, json)), Effect.option);
  if (Option.isNone(after) || after.value === undefined) return "auth_required" satisfies RenewalResult;
  return accepted && after.value > (yield* Clock.currentTimeMillis)
    ? "renewed" satisfies RenewalResult
    : "auth_unverified" satisfies RenewalResult;
}, Effect.orElseSucceed(() => "auth_unverified" as const));
