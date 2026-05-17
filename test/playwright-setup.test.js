import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package exposes a Playwright E2E test command", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
  assert.equal(packageJson.scripts["test:e2e"], "playwright test");
  assert.match(packageJson.devDependencies["@playwright/test"], /^\^1\.\d+\.\d+$/);
});

test("Playwright config uses the browser E2E test directory", async () => {
  const config = await import("../playwright.config.js");

  assert.equal(config.default.testDir, "./test/e2e");
});
