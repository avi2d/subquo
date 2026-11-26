import { expect, test } from "bun:test";

test("no-mistakes lint does not omit the repository lint or typecheck gates", async () => {
  const config = Bun.YAML.parse(await Bun.file(".no-mistakes.yaml").text());
  expect(config).toMatchObject({
    commands: { lint: "bun run lint && bun run typecheck" },
  });
});
