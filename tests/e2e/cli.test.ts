import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../../src/cli.ts", import.meta.url).pathname;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "subquo-test-"));
  const config = join(root, ".config", "subquo");
  const profile = join(root, "profile");
  await mkdir(config, { recursive: true });
  await mkdir(profile, { recursive: true });
  const env = { HOME: root, PATH: process.env.PATH ?? "", XDG_STATE_HOME: join(root, "state") };
  return { root, config, profile, env };
}

test("read prints the saved quota even when the account list and collector are gone", async () => {
  const { root, config, profile, env } = await setup();
  try {
    const login = join(profile, "auth.json");
    const accounts = join(config, "accounts.toml");
    const canary = crypto.randomUUID();
    await writeFile(login, JSON.stringify({ tokens: { account_id: canary } }));
    await writeFile(accounts, [
      "[[accounts]]",
      "id = \"example\"",
      "provider = \"codex\"",
      "login = { store = \"file\", path = " + JSON.stringify(login) + " }",
    ].join("\n"), { mode: 0o600 });
    const missing = join(profile, "gone.json");
    const refresh = Bun.spawn([process.execPath, "--no-env-file", cli, "refresh"], { env, stderr: "pipe" });
    expect(await refresh.exited).toBe(0);
    expect(await new Response(refresh.stderr).text()).toBe("");
    await writeFile(accounts, [
      "[[accounts]]",
      "id = \"example\"",
      "provider = \"codex\"",
      "login = { store = \"file\", path = " + JSON.stringify(missing) + " }",
    ].join("\n"), { mode: 0o600 });
    const read = Bun.spawn([process.execPath, "--no-env-file", cli, "read", "--json"], { env, stderr: "pipe", stdout: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([read.exited, new Response(read.stdout).text(), new Response(read.stderr).text()]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(canary);
    expect(JSON.parse(stdout)).toMatchObject({ accounts: [{ id: "example", observation: { status: "unavailable" } }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named account whose login is missing reads as login needed", async () => {
  const { root, config, env } = await setup();
  try {
    const accounts = join(config, "accounts.toml");
    await writeFile(accounts, [
      "[[accounts]]",
      "id = \"gone\"",
      "provider = \"codex\"",
      "login = { store = \"file\", path = \"/nonexistent/auth.json\" }",
    ].join("\n"), { mode: 0o600 });
    const refresh = Bun.spawn([process.execPath, "--no-env-file", cli, "refresh"], { env, stderr: "pipe" });
    expect(await refresh.exited).toBe(0);
    const read = Bun.spawn([process.execPath, "--no-env-file", cli, "read", "--json"], { env, stderr: "pipe", stdout: "pipe" });
    const [exit, stdout] = await Promise.all([read.exited, new Response(read.stdout).text()]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ accounts: [{ id: "gone", observation: { status: "unavailable", code: "auth_required" } }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired saved pass reads as unchecked without proving a sign-out", async () => {
  const { root, config, profile, env } = await setup();
  try {
    const login = join(profile, ".credentials.json");
    const accounts = join(config, "accounts.toml");
    const canary = crypto.randomUUID();
    await writeFile(login, JSON.stringify({ claudeAiOauth: { accessToken: canary, expiresAt: 1000, refreshToken: canary } }));
    await writeFile(accounts, [
      "[[accounts]]",
      "id = \"old\"",
      "provider = \"claude\"",
      "login = { store = \"file\", path = " + JSON.stringify(login) + " }",
    ].join("\n"), { mode: 0o600 });
    const refresh = Bun.spawn([process.execPath, "--no-env-file", cli, "refresh"], { env, stderr: "pipe" });
    expect(await refresh.exited).toBe(0);
    const read = Bun.spawn([process.execPath, "--no-env-file", cli, "read", "--json"], { env, stderr: "pipe", stdout: "pipe" });
    const [exit, stdout] = await Promise.all([read.exited, new Response(read.stdout).text()]);
    expect(exit).toBe(0);
    expect(stdout).not.toContain(canary);
    expect(JSON.parse(stdout)).toMatchObject({ accounts: [{ id: "old", observation: { status: "unavailable", code: "auth_unverified" } }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
