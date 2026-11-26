import { defineConfig } from "@avi2dg/checks/config";

export default defineConfig({
  releaseAssets: true,
  smoke: ["tests/e2e/release-assets.test.ts"],
});
