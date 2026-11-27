#!/usr/bin/env -S bun --no-env-file
import { Effect } from "effect";
import manifest from "../package.json";

// The mutation runner imports every mutated module before the tests, so an unguarded entry replaces the test process.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const supported = (process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64");
  const name = `${manifest.name}-${process.platform}-${process.arch}`;

  if (supported && process.execve !== undefined) {
    await Effect.runPromise(Effect.option(Effect.try(() => {
      const binary = Bun.fileURLToPath(import.meta.resolve(`${name}/subquo-${manifest.version}`));
      process.execve?.(binary, [binary, ...args]);
    })));
  }

  const source = Bun.fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (process.platform !== "win32" && process.execve !== undefined) {
    process.execve(process.execPath, [process.execPath, "--no-env-file", source, ...args]);
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", source, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
