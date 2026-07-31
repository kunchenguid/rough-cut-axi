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
  const triggerTypes = workflow.match(/^\s+types: \[([^\]]+)\]$/m);
  assert.ok(triggerTypes, "pull_request trigger types must exist");
  assert.deepEqual(
    triggerTypes[1].split(",").map((type) => type.trim()),
    ["opened", "edited", "synchronize", "reopened"],
  );
  assert.match(workflow, /^    branches:\n      - main$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  const permissionDeclarations = [...workflow.matchAll(/^permissions:\n((?:  [^\n]+\n)+)/gm)];
  assert.equal(permissionDeclarations.length, 1);
  assert.equal(permissionDeclarations[0][1], "  contents: read\n");
  assert.equal([...workflow.matchAll(/^[ \t]+permissions:/gm)].length, 0);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.match(workflow, /^    name: PR must be raised via no-mistakes$/m);
  const exemptAuthors = [...workflow.matchAll(/github\.event\.pull_request\.user\.login != '([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(exemptAuthors, ["github-actions[bot]", "dependabot[bot]"]);
  assert.doesNotMatch(workflow, /release-please/);
  assert.ok(workflow.includes(marker));
  assert.match(workflow, /^  cancel-in-progress: true$/m);

  const group = (action, runId) =>
    `no-mistakes-required-42-${action === "opened" || action === "edited" ? runId : "head-change"}`;
  assert.match(
    workflow,
    /^  group: no-mistakes-required-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ \(github\.event\.action == 'opened' \|\| github\.event\.action == 'edited'\) && github\.run_id \|\| 'head-change' \}\}$/m,
  );

  const runBlock = workflow.match(/        run: \|\n((?:          .*\n?)*)/);
  assert.ok(runBlock, "signature run block must exist");
  const script = runBlock[1].replace(/^ {10}/gm, "");
  const execute = (event) =>
    spawnSync("sh", ["-c", script], {
      env: {
        ...process.env,
        PR_NUMBER: "42",
        PR_AUTHOR: "first-time-fork-contributor",
        PR_BODY: event.body,
      },
      encoding: "utf8",
    });

  const events = [
    {
      name: "signed opened",
      action: "opened",
      runId: 1001,
      runNumber: 80,
      body: `Synthetic body\n${marker}`,
      expectedStatus: 0,
      expectedGroup: "no-mistakes-required-42-1001",
    },
    {
      name: "unsigned edited",
      action: "edited",
      runId: 1002,
      runNumber: 81,
      body: "Synthetic unsigned body",
      expectedStatus: 1,
      expectedGroup: "no-mistakes-required-42-1002",
    },
    {
      name: "signed edited replay",
      action: "edited",
      runId: 1003,
      runNumber: 82,
      body: `Synthetic edited body\n${marker}`,
      expectedStatus: 0,
      expectedGroup: "no-mistakes-required-42-1003",
    },
  ];

  for (const event of events) {
    assert.equal(execute(event).status, event.expectedStatus, event.name);
    assert.equal(group(event.action, event.runId), event.expectedGroup, event.name);
  }

  const bodyGroups = events.map((event) => group(event.action, event.runId));
  assert.equal(new Set(bodyGroups).size, events.length);
  assert.equal(group("synchronize", 1004), group("reopened", 1005));
  assert.ok(bodyGroups.every((value) => value !== group("synchronize", 1004)));
});

test("repository has no release-please automation", async () => {
  await assert.rejects(() => readFile(".github/workflows/release-please.yml", "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(".github/workflows/guard-generated-files.yml", "utf8"), /ENOENT/);
  await assert.rejects(() => readFile("release-please-config.json", "utf8"), /ENOENT/);
});
