import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("GitHub Actions CI uses pnpm on Node 24", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /name: CI/);
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /cache: pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm run check/);
  assert.match(workflow, /pnpm test/);
  assert.match(workflow, /pnpm run test:e2e/);
});

test("repository has no release-please automation", async () => {
  await assert.rejects(() => readFile(".github/workflows/release-please.yml", "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(".github/workflows/guard-generated-files.yml", "utf8"), /ENOENT/);
  await assert.rejects(() => readFile("release-please-config.json", "utf8"), /ENOENT/);
});
