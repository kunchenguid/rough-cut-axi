import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
