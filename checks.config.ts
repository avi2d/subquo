import { defineConfig } from "@avi2dg/checks/config";

export default defineConfig({
  releaseAssets: true,
  platformPackages: { binary: "subquo", platforms: ["darwin-arm64", "linux-x64"] },
  smoke: ["tests/e2e/release-assets.test.ts"],
});
