import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("package depends on the AXI SDK", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(typeof packageJson.dependencies["axi-sdk-js"], "string");
});

test("package exposes the rough-cut-axi package and binary names", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.name, "rough-cut-axi");
  assert.deepEqual(packageJson.bin, { "rough-cut-axi": "./bin/rough-cut-axi.js" });
});

test("package uses pnpm like the reference AXI", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.packageManager, "pnpm@11.1.1");
  await assert.rejects(readFile("package-lock.json", "utf8"), { code: "ENOENT" });
  assert.match(await readFile("pnpm-lock.yaml", "utf8"), /lockfileVersion:/);
  assert.match(await readFile("pnpm-workspace.yaml", "utf8"), /packages:/);
});

test("package exposes a combined check command for formatting and linting", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.check, "pnpm run format:check && pnpm run lint");
});

test("CLI delegates command routing to the AXI SDK", async () => {
  const cliCode = await readFile("src/cli.js", "utf8");

  assert.match(cliCode, /from "axi-sdk-js"/);
  assert.match(cliCode, /runAxiCli\(/);
});
