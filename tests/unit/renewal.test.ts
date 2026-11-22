import { expect, test } from "bun:test";
import { renewalExpiry } from "../../src/renewal";

test("Claude access expiry is not guessed from a non-renewable login", () => {
  expect(renewalExpiry("claude", JSON.stringify({ claudeAiOauth: { expiresAt: 1_700_000_000_000 } }))).toBeUndefined();
});

test("Codex access expiry is not taken from the identity token or mistaken for milliseconds", () => {
  const accessClaims = btoa(JSON.stringify({ exp: 1_700_000_000 })).replace(/=+$/u, "");
  const identityClaims = btoa(JSON.stringify({ exp: 1_900_000_000 })).replace(/=+$/u, "");
  const json = JSON.stringify({ tokens: {
    access_token: `${crypto.randomUUID()}.${accessClaims}.${crypto.randomUUID()}`,
    id_token: `${crypto.randomUUID()}.${identityClaims}.${crypto.randomUUID()}`,
    refresh_token: crypto.randomUUID(),
  } });
  expect(renewalExpiry("codex", json)).toBe(1_700_000_000_000);
});
