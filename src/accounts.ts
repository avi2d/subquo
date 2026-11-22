import { Effect, FileSystem, Schema } from "effect";
import { Label } from "./index";

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\/[^\0]*[^/\0]$/u));
const ClaudeFile = Schema.Struct({
  store: Schema.Literal("file"),
  path: AbsolutePath.check(Schema.isPattern(/\/\.credentials\.json$/u)),
});
const CodexFile = Schema.Struct({
  store: Schema.Literal("file"),
  path: AbsolutePath.check(Schema.isPattern(/\/auth\.json$/u)),
});
const OpenCodeFile = Schema.Struct({
  store: Schema.Literal("file"),
  path: AbsolutePath.check(Schema.isPattern(/\/opencode\/auth\.json$/u)),
});
const Keychain = Schema.Struct({
  store: Schema.Literal("macos-keychain"),
  config_dir: AbsolutePath,
  service: Schema.NonEmptyString,
  clauth_profile: Schema.NonEmptyString,
});

const AccountEntry = Schema.Union([
  Schema.Struct({ id: Label, provider: Schema.Literal("claude"), login: Schema.Union([ClaudeFile, Keychain]) }),
  Schema.Struct({ id: Label, provider: Schema.Literal("codex"), login: CodexFile }),
  Schema.Struct({ id: Label, provider: Schema.Literal("opencode-go"), login: OpenCodeFile }),
]);
const AccountList = Schema.Struct({ accounts: Schema.Array(AccountEntry) }).check(
  Schema.makeFilter(({ accounts }) => new Set(accounts.map(({ id }) => id)).size === accounts.length),
);
export type EnrolledAccount = typeof AccountEntry.Type;

class InvalidAccountList extends Schema.TaggedError<InvalidAccountList>()("InvalidAccountList", {}) {}

const invalidAccountList = () => new InvalidAccountList();
const decodeAccountList = Schema.decodeUnknownEffect(AccountList, { onExcessProperty: "error" });

export const loadAccounts = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.mapError(invalidAccountList));
  if (info.type !== "File" || (info.mode & 0o777) !== 0o600) {
    return yield* invalidAccountList();
  }
  const toml = yield* fs.readFileString(path).pipe(Effect.mapError(invalidAccountList));
  const parsed = yield* Effect.try({ try: (): unknown => Bun.TOML.parse(toml), catch: invalidAccountList });
  return yield* decodeAccountList(parsed).pipe(Effect.mapError(invalidAccountList));
});
