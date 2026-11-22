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

async function invoke(
  env: Record<string, string>,
  argv: readonly string[],
  options: { readonly input?: string; readonly preload?: string } = {},
) {
  const preload = options.preload === undefined ? [] : ["--preload", options.preload];
  const child = Bun.spawn([process.execPath, "--no-env-file", ...preload, cli, ...argv], {
    env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

test("refresh and compare do not reuse one Claude login for both enrolled accounts", async () => {
  const { root, config, profile, env } = await setup();
  try {
    const second = join(root, "second");
    await mkdir(second);
    const firstLogin = join(profile, ".credentials.json");
    const secondLogin = join(second, ".credentials.json");
    const day = 86_400_000;
    const expiresAt = Date.now() + day / 3;
    await writeFile(firstLogin, JSON.stringify({
      claudeAiOauth: { accessToken: "fake-access-first", expiresAt, refreshTokenExpiresAt: Date.now() + 6.5 * day },
    }));
    await writeFile(secondLogin, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access-second", expiresAt } }));
    await writeFile(join(config, "accounts.toml"), [
      "[[accounts]]", 'id = "example-first"', 'provider = "claude"', 'clauth_profile = "fake-other-label"',
      `login = { store = "file", path = ${JSON.stringify(firstLogin)} }`,
      "[[accounts]]", 'id = "example-second"', 'provider = "claude"',
      `login = { store = "file", path = ${JSON.stringify(secondLogin)} }`,
    ].join("\n"), { mode: 0o600 });

    const reset = new Date(Date.now() + day).toISOString();
    const preload = join(root, "fake-network.ts");
    await writeFile(preload, `
      globalThis.fetch = async (url, init) => {
        if (new URL(url).pathname !== "/api/oauth/usage" || init.redirect !== "error") throw new Error("wrong request");
        const used = { "Bearer fake-access-first": 25, "Bearer fake-access-second": 40 }[init.headers.authorization];
        if (used === undefined) throw new Error("wrong login");
        return Response.json({ limits: [{ kind: "session", percent: used, resets_at: ${JSON.stringify(reset)} }] });
      };
    `);

    expect(await invoke(env, ["refresh"], { preload })).toEqual({ exit: 0, stdout: "", stderr: "" });
    const json = await invoke(env, ["read", "--json"]);
    expect(json.exit).toBe(0);
    expect(json.stdout).not.toContain("fake-access-");
    const snapshot = JSON.parse(json.stdout);
    expect(snapshot).toMatchObject({
      version: "subquo.v1",
      accounts: [
        { id: "example-first", loginEndsInDays: 7, observation: { windows: [{ percentLeft: 75 }] } },
        { id: "example-second", observation: { windows: [{ percentLeft: 60 }] } },
      ],
    });
    expect(json.stdout.match(/"loginEndsInDays"/gu)).toHaveLength(1);
    const read = await invoke(env, ["read"]);
    expect(read.stdout).toContain("example-first: fresh, login ends in 7 days");

    const capturedAt = new Date().toISOString();
    const baseline = (name: string, utilization_pct: number) => ({
      name, provider: "anthropic", harness: "claude", base_url: null, fetched_at: capturedAt, stale: false,
      windows: [{ label: "5h", utilization_pct, resets_at: reset }],
    });
    const input = JSON.stringify({
      schema: 1, generated_at: capturedAt, profiles: [baseline("example-second", 40), baseline("fake-other-label", 5)],
    });
    const compared = await invoke(env, ["compare"], { input });
    expect(compared.exit).toBe(1);
    expect(compared.stderr).toBe("");
    expect(compared.stdout).toContain(`example-first\tfive-hour\t75%, reset ${reset}, fresh\t95%, reset ${reset}, fresh\tWORSE`);
    expect(compared.stdout).toContain(`example-second\tfive-hour\t60%, reset ${reset}, fresh\t60%, reset ${reset}, fresh\tMATCH`);
    expect(compared.stdout).not.toContain("fake-other-label");
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
