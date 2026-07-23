import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

test("GitHub Actions execute every no-mistakes PR body event", async () => {
  const workflow = await readFile(".github/workflows/no-mistakes-required.yml", "utf8");
  const marker = "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";

  assert.match(workflow, /^name: Require no-mistakes$/m);
  assert.match(
    workflow,
    /^run-name: "PR #\$\{\{ github\.event\.pull_request\.number \}\} body compliance - \$\{\{ github\.event\.action \}\} - event \$\{\{ github\.run_number \}\} \(run \$\{\{ github\.run_id \}\}\)"$/m,
  );
  assert.match(workflow, /^on:\n  pull_request:/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^\s+\w+: write$/m);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.match(workflow, /^    name: PR must be raised via no-mistakes$/m);
  assert.ok(workflow.includes(marker));
  assert.match(workflow, /^  cancel-in-progress: true$/m);

  const group = (action, runId) =>
    `no-mistakes-required-42-${action === "opened" || action === "edited" ? runId : "head-change"}`;
  const bodyGroups = [group("opened", 1001), group("edited", 1002), group("edited", 1003)];
  assert.equal(new Set(bodyGroups).size, 3);
  assert.equal(group("synchronize", 1004), group("reopened", 1005));
  assert.ok(bodyGroups.every((value) => value !== group("synchronize", 1004)));
  assert.match(
    workflow,
    /^  group: no-mistakes-required-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ \(github\.event\.action == 'opened' \|\| github\.event\.action == 'edited'\) && github\.run_id \|\| 'head-change' \}\}$/m,
  );

  const runName = (runNumber, runId) => `PR #42 body compliance - edited - event ${runNumber} (run ${runId})`;
  assert.equal(runName(81, 1002), "PR #42 body compliance - edited - event 81 (run 1002)");
  assert.equal(runName(82, 1003), "PR #42 body compliance - edited - event 82 (run 1003)");
  assert.notEqual(runName(81, 1002), runName(82, 1003));
  assert.ok(81 < 82);

  const runBlock = workflow.match(/        run: \|\n((?:          .*\n?)*)/);
  assert.ok(runBlock, "signature run block must exist");
  const script = runBlock[1].replace(/^ {10}/gm, "");
  const execute = (body) =>
    spawnSync("sh", ["-c", script], {
      env: {
        ...process.env,
        PR_NUMBER: "42",
        PR_AUTHOR: "first-time-fork-contributor",
        PR_BODY: body,
      },
      encoding: "utf8",
    });

  assert.equal(execute(`Synthetic body\n${marker}`).status, 0);
  assert.equal(execute("Synthetic unsigned body").status, 1);
  assert.equal(execute(`Synthetic edited body\n${marker}`).status, 0);
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
