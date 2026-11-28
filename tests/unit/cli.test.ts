import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Runtime, Sink, Stdio } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { runCommand } from "../../src/cli";
import type { AccountReadOptions } from "../../src/collectors";
import fresh from "../fixtures/snapshots/fresh.json";
import incomplete from "../fixtures/snapshots/incomplete.json";

const usage = "Usage: subquo refresh [--renew-idle <account>] | subquo read [--json]\n";
const writtenAt = "2030-01-01T00:00:30.000Z";
const quietSuccess = { exit: 0, stdout: "", stderr: "" };

async function invoke(args: readonly string[], options: {
  readonly home: string;
  readonly stateHome?: string;
  readonly now?: string;
  readonly reads?: AccountReadOptions;
}) {
  let stdout = "";
  let stderr = "";
  let exit = -1;
  const stdio = Stdio.layerTest({
    args: Effect.succeed(args),
    stdout: () => Sink.forEach((chunk) => Effect.sync(() => { stdout += chunk; })),
    stderr: () => Sink.forEach((chunk) => Effect.sync(() => { stderr += chunk; })),
  });
  const reads = {
    fetchImpl: () => { throw new Error("Unexpected network request"); },
    readKeychain: () => Effect.die("Unexpected Keychain read"),
    ...options.reads,
  } satisfies AccountReadOptions;
  const result = await Effect.runPromiseExit(TestClock.setTime(Date.parse(options.now ?? writtenAt)).pipe(
    Effect.andThen(runCommand(options.home, options.stateHome, undefined, reads)),
    Effect.provide([BunFileSystem.layer, BunPath.layer, stdio, TestClock.layer()]),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("Unexpected child process"))),
  ));
  Runtime.defaultTeardown(result, (code) => { exit = code; });
  return { exit, stdout, stderr };
}

async function withHome(use: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "subquo-command-"));
  try {
    await use(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seedSnapshot(stateHome: string, snapshot: unknown) {
  const directory = join(stateHome, "subquo");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "snapshot.json"), JSON.stringify(snapshot));
}

async function enroll(home: string, accounts: string) {
  const config = join(home, ".config", "subquo");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "accounts.toml"), accounts, { mode: 0o600 });
}

test("bare help succeeds on stdout even without an absolute HOME", async () => {
  expect(await invoke(["--help"], { home: "" })).toEqual({ ...quietSuccess, stdout: usage });
});

test("read rejects a relative HOME instead of opening a snapshot", async () => {
  expect(await invoke(["read"], { home: "relative" })).toEqual({
    exit: 1, stdout: "", stderr: "An absolute HOME is required.\n",
  });
});

test.each([
  { args: [] },
  { args: ["--help", "extra"] },
  { args: ["read", "--wrong"] },
  { args: ["read", "--json", "extra"] },
  { args: ["refresh", "--renew-idle"] },
  { args: ["refresh", "--renew-idle", "example", "extra"] },
  { args: ["refresh", "--json"] },
])("invalid arguments %j fail with usage on stderr, not command output", ({ args }) => withHome(async (home) => {
  expect(await invoke(args, { home })).toEqual({ exit: 1, stdout: "", stderr: usage });
}));

test("JSON read uses absolute XDG state and does not recheck or replace the saved observations", () => withHome(async (home) => {
  const stateHome = join(home, "state");
  await seedSnapshot(stateHome, fresh);
  const result = await invoke(["read", "--json"], { home, stateHome, now: "2030-01-01T00:03:00.000Z" });
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(fresh);
}));

test("text read ignores a relative XDG state and does not report quota as fresh at the reset", () => withHome(async (home) => {
  await seedSnapshot(join(home, ".local", "state"), fresh);
  expect(await invoke(["read"], { home, stateHome: "relative-state", now: "2030-01-01T00:01:00.000Z" })).toEqual({
    ...quietSuccess,
    stdout: [
      "Snapshot written at 2030-01-01T00:00:30.000Z",
      "sample-claude: fresh",
      "  five-hour: 40% left, resets at 2030-01-01T05:00:00.000Z",
      "  weekly: 12% left, resets at 2030-01-08T00:00:00.000Z",
      "sample-codex: stale",
      "  weekly: 100% left, resets at 2030-01-08T00:00:00.000Z",
      "  five-hour: 0% left, resets at 2030-01-01T00:01:00.000Z",
      "",
    ].join("\n"),
  });
}));

test("text read prints failure codes and unknown values instead of claiming measured quota", () => withHome(async (home) => {
  await seedSnapshot(join(home, ".local", "state"), incomplete);
  expect(await invoke(["read"], { home, now: incomplete.writtenAt })).toEqual({
    ...quietSuccess,
    stdout: [
      "Snapshot written at 2030-01-01T00:01:00.000Z",
      "sample-claude: stale (timeout)",
      "  five-hour: 40% left, resets at 2030-01-01T05:00:00.000Z",
      "sample-codex: unavailable (rate_limited)",
      "sample-opencode: unavailable (auth_unverified)",
      "sample-backup: unavailable (auth_required)",
      "sample-partial: fresh",
      "  weekly: unknown, resets at an unknown time",
      "",
    ].join("\n"),
  });
}));

test("read fails rather than printing a missing or unreadable snapshot", () => withHome(async (home) => {
  const stateHome = join(home, ".local", "state");
  const failure = { exit: 1, stdout: "", stderr: "No readable subquo snapshot.\n" };
  expect(await invoke(["read", "--json"], { home })).toEqual(failure);
  await seedSnapshot(stateHome, { version: "unsupported" });
  expect(await invoke(["read", "--json"], { home })).toEqual(failure);
}));

test("refresh writes each named login's quota and retains a rate-limited account without retrying it", () => withHome(async (home) => {
  const stateHome = join(home, "new-state");
  const login = join(home, ".credentials.json");
  const keychainDir = join(home, "keychain-profile");
  const expiresTomorrow = Date.parse("2030-01-02T00:00:00.000Z");
  const credential = (accessToken: string) => JSON.stringify({
    claudeAiOauth: { accessToken, expiresAt: expiresTomorrow, refreshTokenExpiresAt: expiresTomorrow },
  });
  await writeFile(login, credential("synthetic-file"));
  await enroll(home, [
    "[[accounts]]", 'id = "example-file"', 'provider = "claude"',
    `login = { store = "file", path = ${JSON.stringify(login)} }`,
    "[[accounts]]", 'id = "example-keychain"', 'provider = "claude"',
    `login = { store = "macos-keychain", config_dir = ${JSON.stringify(keychainDir)}, service = "Claude Code-credentials" }`,
  ].join("\n"));
  const reset = "2030-01-01T00:01:00.000Z";
  let limitedRequests = 0;
  const reads = {
    readKeychain: (keychainLogin) => Effect.succeed(keychainLogin.config_dir === keychainDir ? credential("synthetic-keychain") : undefined),
    fetchImpl: (_url, { headers }) => {
      if (headers.authorization === "Bearer synthetic-file") {
        return Promise.resolve(Response.json({ five_hour: { utilization: 25, resets_at: reset } }));
      }
      if (headers.authorization === "Bearer synthetic-keychain") {
        limitedRequests++;
        return Promise.resolve(new Response(null, { status: 429 }));
      }
      throw new Error("Request did not use a named login");
    },
  } satisfies AccountReadOptions;
  expect(await invoke(["refresh"], { home, stateHome, reads })).toEqual(quietSuccess);
  const snapshot: unknown = JSON.parse(await readFile(join(stateHome, "subquo", "snapshot.json"), "utf8"));
  expect(snapshot).toEqual({
    version: "subquo.v1", writtenAt,
    accounts: [
      {
        id: "example-file", provider: "claude", loginEndsInDays: 1,
        observation: {
          status: "fresh", observedAt: writtenAt, validUntil: reset, source: "provider",
          windows: [{ id: "five-hour", scope: "all", percentLeft: 75, resetsAt: reset }],
        },
      },
      { id: "example-keychain", provider: "claude", loginEndsInDays: 1, observation: { status: "unavailable", code: "rate_limited" } },
    ],
  });
  expect(limitedRequests).toBe(1);
  const read = await invoke(["read"], { home, stateHome });
  expect(read.stdout).toContain("example-file: fresh, login ends in 1 day\n");
}));

test("refresh does not replace a snapshot when the account list cannot be read", () => withHome(async (home) => {
  const stateHome = join(home, "state");
  await seedSnapshot(stateHome, fresh);
  expect(await invoke(["refresh"], { home, stateHome })).toEqual({
    exit: 1, stdout: "", stderr: "Could not refresh subquo. Check the account list and state directory.\n",
  });
  expect(JSON.parse(await readFile(join(stateHome, "subquo", "snapshot.json"), "utf8"))).toEqual(fresh);
}));

test("refresh skips a held lock without replacing the snapshot, and a read still prints it", () => withHome(async (home) => {
  const stateHome = join(home, "state");
  await seedSnapshot(stateHome, fresh);
  await enroll(home, "accounts = []");
  const lock = new Database(join(stateHome, "subquo", "refresh.sqlite"));
  try {
    lock.run("BEGIN IMMEDIATE");
    expect(await invoke(["refresh"], { home, stateHome })).toEqual(quietSuccess);
    const read = await invoke(["read", "--json"], { home, stateHome });
    expect(read.exit).toBe(0);
    expect(read.stderr).toBe("");
    expect(JSON.parse(read.stdout)).toEqual(fresh);
  } finally {
    lock.close();
  }
}));

test("renewal gives an account-list error for a missing list and refuses an unenrolled account", () => withHome(async (home) => {
  const args = ["refresh", "--renew-idle", "example"];
  expect(await invoke(args, { home })).toEqual({
    exit: 1, stdout: "", stderr: "Could not read the subquo account list.\n",
  });
  await enroll(home, "accounts = []");
  expect(await invoke(args, { home })).toEqual({
    exit: 1, stdout: "", stderr: "Not an enrolled subquo account.\n",
  });
}));

test("renewal exits unsuccessfully for an unchecked login but not for a key that needs no renewal", () => withHome(async (home) => {
  await enroll(home, [
    "[[accounts]]", 'id = "example-codex"', 'provider = "codex"',
    `login = { store = "file", path = ${JSON.stringify(join(home, "auth.json"))} }`,
    "[[accounts]]", 'id = "example-go"', 'provider = "opencode-go"',
    `login = { store = "file", path = ${JSON.stringify(join(home, "opencode", "auth.json"))} }`,
  ].join("\n"));
  expect(await invoke(["refresh", "--renew-idle", "example-codex"], { home })).toEqual({
    exit: 1, stdout: "auth_unverified\n", stderr: "",
  });
  expect(await invoke(["refresh", "--renew-idle", "example-go"], { home })).toEqual({
    ...quietSuccess, stdout: "not_supported\n",
  });
}));
