import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../package.json";

const root = new URL("../..", import.meta.url).pathname;

test("launcher forwards arguments and exit status to the installed platform binary instead of source", async () => {
  if (!((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64"))) return;
  const directory = await mkdtemp(join(tmpdir(), "subquo-launch-"));
  try {
    const source = join(directory, "src");
    const platform = join(directory, "node_modules", `${manifest.name}-${process.platform}-${process.arch}`);
    await mkdir(source, { recursive: true });
    await mkdir(platform, { recursive: true });
    await symlink(join(root, "node_modules/effect"), join(directory, "node_modules/effect"));
    await copyFile(join(root, "src/launch.ts"), join(source, "launch.ts"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    await writeFile(join(platform, "package.json"), JSON.stringify({ name: `${manifest.name}-${process.platform}-${process.arch}`, version: manifest.version }));
    const binary = join(platform, `subquo-${manifest.version}`);
    await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$1"\nexit 17\n');
    await chmod(binary, 0o755);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(source, "launch.ts"), "probe"], { stdout: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("probe\n");
    expect(await child.exited).toBe(17);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
