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

test("GitHub Actions require no-mistakes PRs", async () => {
  const workflow = await readFile(".github/workflows/no-mistakes-required.yml", "utf8");

  assert.match(workflow, /name: Require no-mistakes/);
  assert.match(workflow, /git push no-mistakes/);
});

test("GitHub Actions guard release-please generated files", async () => {
  const workflow = await readFile(".github/workflows/guard-generated-files.yml", "utf8");

  assert.match(workflow, /name: Guard generated files/);
  assert.match(workflow, /CHANGELOG\.md/);
  assert.match(workflow, /\.release-please-manifest\.json/);
});

test("GitHub Actions include release-please automation", async () => {
  const workflow = await readFile(".github/workflows/release-please.yml", "utf8");
  const config = JSON.parse(await readFile("release-please-config.json", "utf8"));

  assert.match(workflow, /name: release-please/);
  assert.match(workflow, /googleapis\/release-please-action@v4/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm run check/);
  assert.match(workflow, /pnpm test/);
  assert.equal(config.packages["."]["package-name"], "rough-cut-axi");
});
