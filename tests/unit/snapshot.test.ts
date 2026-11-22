import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { observationAt, parseSnapshot, pickEvidenceAt, serializeSnapshot } from "../../src/index.js";

const freshSample = Bun.file(new URL("../fixtures/snapshots/fresh.json", import.meta.url));
const incompleteSample = Bun.file(new URL("../fixtures/snapshots/incomplete.json", import.meta.url));
const observedAt = "2030-01-01T00:00:00.000Z";
const afterOneMinute = Date.parse("2030-01-01T00:01:00.000Z");

async function readSample(file: Bun.BunFile) {
  return Effect.runSync(parseSnapshot(await file.text()));
}

async function readObservation(file: Bun.BunFile, id: string) {
  const account = (await readSample(file)).accounts.find((entry) => entry.id === id);
  if (account === undefined) throw new Error("Sample account missing");
  return account.observation;
}

test("does not combine quota windows or drop their individual resets", async () => {
  const observation = await readObservation(freshSample, "sample-claude");
  expect(observation).toMatchObject({
    status: "fresh",
    windows: [
      { id: "five-hour", scope: "account", percentLeft: 40, resetsAt: "2030-01-01T05:00:00.000Z" },
      { id: "weekly", scope: "account", percentLeft: 12, resetsAt: "2030-01-08T00:00:00.000Z" },
    ],
  });
});

test("does not offer evidence at the two-minute cutoff or discard the stale date", async () => {
  const observation = await readObservation(freshSample, "sample-claude");
  const cutoff = Date.parse("2030-01-01T00:02:00.000Z");
  expect(pickEvidenceAt(observation, cutoff - 1)?.status).toBe("fresh");
  expect(pickEvidenceAt(observation, cutoff)).toBeUndefined();
  expect(observationAt(observation, cutoff)).toMatchObject({ status: "stale", observedAt, code: null });
});

test("does not pick from a reset window even if it is not the first window", async () => {
  const observation = await readObservation(freshSample, "sample-codex");
  expect(pickEvidenceAt(observation, afterOneMinute - 1)?.status).toBe("fresh");
  expect(pickEvidenceAt(observation, afterOneMinute)).toBeUndefined();
  expect(observationAt(observation, afterOneMinute)).toMatchObject({
    status: "stale",
    observedAt: "2030-01-01T00:00:10.000Z",
  });
});

test("does not treat a failed refresh as fresh even within two minutes", async () => {
  const observation = await readObservation(incompleteSample, "sample-claude");
  expect(pickEvidenceAt(observation, afterOneMinute)).toBeUndefined();
  expect(observationAt(observation, afterOneMinute)).toMatchObject({
    status: "stale",
    observedAt,
    code: "timeout",
  });
});

test("does not substitute full quota or a known reset for unknown window data", async () => {
  const observation = await readObservation(incompleteSample, "sample-partial");
  expect(pickEvidenceAt(observation, afterOneMinute)).toBeUndefined();
  expect(observationAt(observation, afterOneMinute)).toMatchObject({
    windows: [{ percentLeft: null, resetsAt: null }],
  });
});

function singleAccount(observation: unknown) {
  return {
    version: "subquo.v1",
    writtenAt: observedAt,
    accounts: [{ id: "sample-claude", provider: "claude", observation }],
  };
}

const windowReading = {
  id: "five-hour",
  scope: "account",
  percentLeft: 40,
  resetsAt: "2030-01-01T05:00:00.000Z",
};
const freshReading = {
  status: "fresh",
  source: "provider",
  observedAt,
  validUntil: "2030-01-01T00:02:00.000Z",
  windows: [windowReading],
};

test.each([-1, 101, Infinity, NaN])("does not serialize an impossible percent left: %p", (percentLeft) => {
  const input = singleAccount({ ...freshReading, windows: [{ ...windowReading, percentLeft }] });
  expect(Result.isFailure(Effect.runSync(Effect.result(serializeSnapshot(input))))).toBe(true);
});

test("does not accept a fresh deadline more than two minutes after the observation", () => {
  const input = singleAccount({ ...freshReading, validUntil: "2030-01-01T00:02:00.001Z" });
  expect(Result.isFailure(Effect.runSync(Effect.result(serializeSnapshot(input))))).toBe(true);
});

test("does not mark a reading fresh in a snapshot written at its deadline", () => {
  const input = { ...singleAccount(freshReading), writtenAt: "2030-01-01T00:02:00.000Z" };
  expect(Result.isFailure(Effect.runSync(Effect.result(parseSnapshot(JSON.stringify(input)))))).toBe(true);
});

test("does not accept a fresh deadline that claims time past a window reset", () => {
  const input = singleAccount({
    ...freshReading,
    windows: [{ ...windowReading, resetsAt: "2030-01-01T00:01:00.000Z" }],
  });
  expect(Result.isFailure(Effect.runSync(Effect.result(parseSnapshot(JSON.stringify(input)))))).toBe(true);
});

test.each(["timeout", "rate_limited", "auth_required", "auth_unverified"])(
  "does not offer pick evidence for unavailable quota with code %s",
  (code) => {
    const input = singleAccount({ status: "unavailable", code });
    const snapshot = Effect.runSync(parseSnapshot(JSON.stringify(input)));
    const account = snapshot.accounts.at(0);
    if (account === undefined) throw new Error("Sample account missing");
    expect(account.observation).toEqual({ status: "unavailable", code });
    expect(pickEvidenceAt(account.observation, afterOneMinute)).toBeUndefined();
  },
);

function fakeToken() {
  return [crypto.randomUUID(), crypto.randomUUID()].join(".");
}

test("does not copy runtime credential data into decoded output or serialized snapshots", () => {
  const secret = fakeToken();
  const input = {
    ...singleAccount({
      ...freshReading,
      rawResponse: { accessToken: secret },
      windows: [{ ...windowReading, token: secret }],
    }),
    login: { token: secret },
    [secret]: true,
  };
  const decoded = Effect.runSync(parseSnapshot(JSON.stringify(input)));
  const serialized = Effect.runSync(serializeSnapshot(input));
  for (const output of [JSON.stringify(decoded), serialized]) {
    expect(output.includes(secret)).toBe(false);
  }
  expect(JSON.parse(JSON.stringify(decoded))).toEqual(singleAccount(freshReading));
  expect(JSON.parse(serialized)).toEqual(singleAccount(freshReading));
});

test("does not carry extra fields or enrolled account IDs in the committed samples", async () => {
  for (const sample of [freshSample, incompleteSample]) {
    const raw = await sample.text();
    const snapshot = Effect.runSync(parseSnapshot(raw));
    expect(JSON.parse(raw)).toEqual(snapshot);
    expect(snapshot.accounts.every(({ id }) => id.startsWith("sample-"))).toBe(true);
  }
});

test("does not echo rejected tokens in JSON errors or turn a raw vendor error into a safe code", () => {
  const secret = fakeToken();
  const input = singleAccount({ status: "unavailable", code: secret });
  for (const boundary of [
    Effect.asVoid(parseSnapshot(JSON.stringify(input))),
    Effect.asVoid(parseSnapshot(`{"${secret}"`)),
    Effect.asVoid(serializeSnapshot(input)),
  ]) {
    const result = Effect.runSync(Effect.result(boundary));
    expect(Bun.inspect(result).includes(secret)).toBe(false);
    expect(Result.isFailure(result) && String(result.failure)).toBe("InvalidSnapshot");
  }
});
