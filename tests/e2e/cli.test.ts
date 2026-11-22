import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../../src/cli.ts", import.meta.url).pathname;

test("read prints the saved quota even when the account list and collector are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "subquo-test-"));
  try {
    const config = join(root, ".config", "subquo");
    const profile = join(root, "profile");
    const bin = join(root, "bin");
    await Promise.all([config, profile, bin].map((path) => mkdir(path, { recursive: true })));
    const login = join(profile, "auth.json");
    const accounts = join(config, "accounts.toml");
    const canary = crypto.randomUUID();
    await writeFile(login, JSON.stringify({ tokens: { access_token: canary } }));
    await writeFile(accounts, [
      "[[accounts]]",
      'id = "example"',
      'provider = "codex"',
      `login = { store = "file", path = ${JSON.stringify(login)} }`,
    ].join("\n"), { mode: 0o600 });

    const collector = join(bin, "quota-axi");
    const observedAt = new Date().toISOString();
    const resetsAt = new Date(Date.parse(observedAt) + 3_600_000).toISOString();
    const reply = JSON.stringify({
      providers: [{
        provider: "codex",
        source: "oauth",
        state: { status: "fresh", stale: false, refreshedAt: observedAt },
        windows: [{ id: "five_hour", kind: "session", percentRemaining: 40, resetsAt }],
        ignored: canary,
      }],
    });
    await writeFile(collector, [
      "#!/bin/sh",
      '[ "$CODEX_HOME" = "$HOME/profile" ] || exit 1',
      '[ "$*" = "quota --provider codex --json --full --no-credential-refresh --profile-only" ] || exit 1',
      `printf '%s\\n' '${reply}'`,
    ].join("\n"), { mode: 0o700 });

    const env = { HOME: root, PATH: bin, XDG_STATE_HOME: join(root, "state") };
    const refresh = Bun.spawn([process.execPath, "--no-env-file", cli, "refresh"], { env, stderr: "pipe" });
    expect(await refresh.exited).toBe(0);
    expect(await new Response(refresh.stderr).text()).toBe("");
    await Promise.all([accounts, login, collector].map((path) => rm(path)));
    const read = Bun.spawn([process.execPath, "--no-env-file", cli, "read", "--json"], { env, stderr: "pipe", stdout: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([read.exited, new Response(read.stdout).text(), new Response(read.stderr).text()]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(canary);
    expect(JSON.parse(stdout)).toMatchObject({
      version: "subquo.v1",
      accounts: [{
        id: "example",
        provider: "codex",
        observation: {
          status: "fresh",
          observedAt,
          windows: [{ id: "five-hour", scope: "all", percentLeft: 40, resetsAt }],
        },
      }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
