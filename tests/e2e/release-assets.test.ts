import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;

test("compiled release rejects wrong usage, ignores cwd dotenv and preloads, and includes a matching SHA-256 file", async () => {
  const output = await mkdtemp(join(tmpdir(), "subquo-release-"));
  try {
    const build = Bun.spawn([process.execPath, "--no-env-file", join(root, "scripts/release-assets.ts"), output], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [buildExit, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(buildError).toBe("");
    expect(buildExit).toBe(0);

    const name = `subquo-${process.platform}-${process.arch}`;
    const executable = join(output, name);
    const digest = createHash("sha256").update(await readFile(executable)).digest("hex");
    expect(await readFile(`${executable}.sha256`, "utf8")).toBe(`${digest}  ${name}\n`);

    const env = { HOME: output, PATH: process.env.PATH ?? "" };
    const usage = Bun.spawn([executable], { cwd: output, env, stdout: "pipe", stderr: "pipe" });
    const [usageExit, usageOutput, usageError] = await Promise.all([
      usage.exited, new Response(usage.stdout).text(), new Response(usage.stderr).text(),
    ]);
    expect(usageExit).toBe(1);
    expect(usageOutput).toBe("");
    expect(usageError).toContain("subquo read");

    const state = join(output, ".local", "state", "subquo");
    const snapshot = { version: "subquo.v1", writtenAt: "2030-01-01T00:00:00.000Z", accounts: [] };
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "snapshot.json"), JSON.stringify(snapshot));
    await writeFile(join(output, ".env"), `XDG_STATE_HOME=${JSON.stringify(join(output, "redirected-state"))}\n`);
    await writeFile(join(output, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    const marker = join(output, "preload-ran");
    await writeFile(join(output, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);

    const read = Bun.spawn([executable, "read", "--json"], { cwd: output, env, stdout: "pipe", stderr: "pipe" });
    const [readExit, readOutput, readError] = await Promise.all([
      read.exited, new Response(read.stdout).text(), new Response(read.stderr).text(),
    ]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(readError).toBe("");
    expect(readExit).toBe(0);
    expect(JSON.parse(readOutput)).toEqual(snapshot);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);
