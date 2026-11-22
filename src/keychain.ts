import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { validClaudeKeychainService, type EnrolledAccount } from "./accounts";

export type MacosKeychainLogin = Extract<EnrolledAccount["login"], { readonly store: "macos-keychain" }>;

export const readKeychainPassword = Effect.fnUntraced(function*(
  login: MacosKeychainLogin,
  env: Record<string, string | undefined>,
) {
  if (!validClaudeKeychainService(login)) return yield* Effect.succeed(undefined as string | undefined);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make("/usr/bin/security", ["find-generic-password", "-s", login.service, "-w"], {
    env,
    stdin: "ignore",
    stderr: "ignore",
    killSignal: "SIGKILL",
  });
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* spawner.spawn(command);
    const content = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
    if ((yield* child.exitCode) !== 0) return undefined;
    return content;
  }));
});
