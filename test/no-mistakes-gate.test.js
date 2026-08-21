import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractGateScript, WORKFLOW_PATH } from "./helpers/no-mistakes-gate.js";

/**
 * The gate lives as an inline `run:` block so the whole file can be mirrored
 * into sibling repositories as one unit. Extract that exact block and execute
 * it, so these tests exercise what CI runs rather than a copy of it.
 */
const scriptPath = join(mkdtempSync(join(tmpdir(), "nm-gate-")), "gate.sh");
writeFileSync(scriptPath, extractGateScript(readFileSync(WORKFLOW_PATH, "utf8")));

function hasCommand(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

// The gate is a bash script that parses JSON with jq, exactly as the
// ubuntu-latest runner does. Never skip on CI: a silently skipped gate test is
// worse than no test. Locally, skip when jq is absent rather than failing a
// contributor's `pnpm test` over an unrelated missing tool.
const runnable = hasCommand("bash") && hasCommand("jq");
if (process.env.CI && !runnable) {
  throw new Error("CI must provide bash and jq to exercise the no-mistakes gate");
}

const SIGNATURE = "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
const ATTESTATION_PREFIX = "<!-- no-mistakes-pipeline-attestation:v1 ";
const ATTESTATION_SUFFIX = " -->";
const HEAD_SHA = "12df13109c6ad8d64646b85ac7170b23afe6e9bf";

function runGate(body, headSha = HEAD_SHA) {
  const result = spawnSync("bash", [scriptPath], {
    env: { ...process.env, PR_BODY: body, PR_AUTHOR: "somedev", PR_NUMBER: "42", PR_HEAD_SHA: headSha },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A PR body shaped like the one no-mistakes writes. */
function prBody(attestationPayload) {
  const attestation =
    attestationPayload === undefined ? "" : `${ATTESTATION_PREFIX}${attestationPayload}${ATTESTATION_SUFFIX}\n\n`;
  return [
    "## What Changed\n\n- something\n",
    `## Pipeline\n\n${SIGNATURE}\n\n${attestation}`,
    "<details>\n<summary>Review</summary>\n\nok\n\n</details>\n",
  ].join("\n");
}

function attestation(steps) {
  return JSON.stringify({
    head_sha: HEAD_SHA,
    steps: steps.map(([step, status]) => ({ step, status })),
  });
}

/** The step snapshot a healthy run produces when the PR body is written. */
const HEALTHY_STEPS = [
  ["intent", "completed"],
  ["rebase", "completed"],
  ["review", "completed"],
  ["test", "completed"],
  ["document", "completed"],
  ["lint", "completed"],
  ["push", "completed"],
  ["pr", "running"],
  ["ci", "pending"],
];

function withStatus(step, status) {
  return HEALTHY_STEPS.map(([name, current]) => (name === step ? [name, status] : [name, current]));
}

const gateTest = (name, fn) => test(name, { skip: runnable ? false : "bash and jq are required" }, fn);

gateTest("accepts a body whose attestation completes review, test, and document", () => {
  const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)));
  assert.equal(code, 0, output);
  assert.match(output, /review, test, and document all completed/);
});

gateTest("still rejects a body with no no-mistakes signature", () => {
  const { code, output } = runGate("## Intent\n\nhand-written body\n");
  assert.equal(code, 1, output);
  assert.match(output, /was not raised through no-mistakes/);
  assert.match(output, /git push no-mistakes/);
});

gateTest("rejects a signed body with no attestation and names the required version", () => {
  const { code, output } = runGate(prBody());
  assert.equal(code, 1, output);
  assert.match(output, /no pipeline attestation/);
  assert.ok(output.includes("no-mistakes >= 1.46.0 is required (PR 670)"), output);
});

// Every skip route no-mistakes has - `--skip`, a user skip at a gate, an
// automatic pipeline skip, or a run that ran out of agent quota - lands on the
// raw `skipped` status, and an unavailable agent surfaces as `failed`.
for (const status of ["skipped", "failed", "running", "pending"]) {
  gateTest(`rejects an attestation whose test step is ${status}`, () => {
    const { code, output } = runGate(prBody(attestation(withStatus("test", status))));
    assert.equal(code, 1, output);
    assert.ok(output.includes(`records 'test' as '${status}'`), output);
  });
}

gateTest("rejects an attestation that omits a required step entirely", () => {
  const steps = HEALTHY_STEPS.filter(([name]) => name !== "document");
  const { code, output } = runGate(prBody(attestation(steps)));
  assert.equal(code, 1, output);
  assert.ok(output.includes("no 'document' step record"), output);
});

gateTest("rejects a required step recorded twice unless every record completed", () => {
  const { code, output } = runGate(prBody(attestation([...HEALTHY_STEPS, ["review", "skipped"]])));
  assert.equal(code, 1, output);
  assert.ok(output.includes("records 'review' as 'completed,skipped'"), output);
});

// v1 carries no skip sibling field, so `status` is the only skip channel today.
// Fail closed if a later schema ever hangs a skip reason off an otherwise
// completed step instead of widening the gate silently.
for (const marker of [
  { skip_reason: "quota exhausted" },
  { skipped: true },
  { agent_unavailable: true },
  { quota_exhausted: true },
]) {
  const key = Object.keys(marker)[0];
  gateTest(`rejects a completed step carrying a ${key} marker`, () => {
    const payload = JSON.stringify({
      head_sha: HEAD_SHA,
      steps: HEALTHY_STEPS.map(([step, status]) =>
        step === "review" ? { step, status, ...marker } : { step, status },
      ),
    });
    const { code, output } = runGate(prBody(payload));
    assert.equal(code, 1, output);
    assert.ok(output.includes(`skip indicator(s) [${key}]`), output);
  });
}

gateTest("fails closed on an attestation payload that is not valid JSON", () => {
  const { code, output } = runGate(prBody('{"head_sha":"abc","steps":[{"step":"review",'));
  assert.equal(code, 1, output);
  assert.match(output, /could not be parsed as JSON/);
});

gateTest("fails closed when the payload has no steps array", () => {
  const { code, output } = runGate(prBody('{"head_sha":"abc"}'));
  assert.equal(code, 1, output);
  assert.match(output, /could not be parsed as JSON/);
});

gateTest("fails closed when the attestation comment is never closed", () => {
  const body = `## Pipeline\n\n${SIGNATURE}\n\n${ATTESTATION_PREFIX}{"head_sha":"abc","steps":[]}\n`;
  const { code, output } = runGate(body);
  assert.equal(code, 1, output);
  assert.match(output, /no JSON payload could be extracted/);
});

// The attestation is a claim about one commit. A body that was not rewritten by
// a fresh no-mistakes run - a synchronize that pushed a commit the pipeline never
// saw - must go red: that is the contract, not a false positive.
gateTest("rejects an attestation whose head_sha is not the PR's current head", () => {
  const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)), "0000000000000000000000000000000000000000");
  assert.equal(code, 1, output);
  assert.match(output, /attestation is stale for the current head/);
  assert.ok(output.includes(HEAD_SHA), output);
  assert.ok(output.includes("0000000000000000000000000000000000000000"), output);
  assert.match(output, /Re-run 'git push no-mistakes' to refresh the attestation/);
});

gateTest("accepts an attestation whose head_sha matches the PR's current head", () => {
  const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)), HEAD_SHA);
  assert.equal(code, 0, output);
  assert.match(output, /review, test, and document all completed/);
});

gateTest("rejects an attestation that records no head_sha at all", () => {
  const payload = JSON.stringify({ steps: HEALTHY_STEPS.map(([step, status]) => ({ step, status })) });
  const { code, output } = runGate(prBody(payload));
  assert.equal(code, 1, output);
  assert.match(output, /attestation is stale for the current head/);
  assert.match(output, /it attests \(absent\)/);
});

gateTest("fails closed when the runner supplies no head sha", () => {
  const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)), "");
  assert.equal(code, 1, output);
  assert.match(output, /attestation is stale for the current head/);
});

gateTest("accepts a CRLF body", () => {
  const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)).replace(/\n/g, "\r\n"));
  assert.equal(code, 0, output);
});
