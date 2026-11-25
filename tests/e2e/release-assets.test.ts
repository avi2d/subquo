import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const usage = "subquo read";
const verifier = `
  import { strict as assert } from "node:assert";
  const child = Bun.spawn([process.env.EXECUTABLE], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(exit, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes(process.env.EXPECTED), "expected " + process.env.EXPECTED + " in " + stderr);
`;

test("compiled release rejects wrong usage and includes a matching SHA-256 file", async () => {
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

    async function verify(expected: string) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", verifier], {
        env: { HOME: output, PATH: process.env.PATH ?? "", EXECUTABLE: executable, EXPECTED: expected }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { exit, stderr };
    }

    const twin = await verify("incorrect usage");
    console.log(`fail-first usage check exit: ${twin.exit}`);
    expect(twin.exit).not.toBe(0);
    expect(twin.stderr).toContain("incorrect usage");
    expect(twin.stderr).toContain(usage);
    const correct = await verify(usage);
    console.log(`correct usage check exit: ${correct.exit}`);
    expect(correct.stderr).toBe("");
    expect(correct.exit).toBe(0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);
