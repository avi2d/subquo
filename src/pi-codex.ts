import { Option, Schema } from "effect";

export type CodexCredentials = { readonly accessToken: string; readonly accountId?: string; readonly expiresAt?: number };

const PiCodexLogin = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  expires: Schema.Finite,
});
const decodePiCodexLogin = Schema.decodeUnknownOption(PiCodexLogin);

export function parsePiCodexLogin(value: unknown): Required<CodexCredentials> | undefined {
  const login = decodePiCodexLogin(value);
  if (Option.isNone(login)) return undefined;
  return { accessToken: login.value.access, accountId: login.value.accountId, expiresAt: login.value.expires };
}
