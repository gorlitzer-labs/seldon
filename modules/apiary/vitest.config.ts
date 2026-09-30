import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A throwaway HOME for the whole run — see tests/global-setup.ts.
    globalSetup: ["tests/global-setup.ts"],
  },
});
