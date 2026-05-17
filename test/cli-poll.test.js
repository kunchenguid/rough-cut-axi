import { test } from "node:test";
import assert from "node:assert/strict";

import { poll } from "../src/cli-poll.js";

test("poll reports missing project directory as a usage error", async () => {
  const originalExitCode = process.exitCode;
  let stdout = "";
  process.exitCode = undefined;

  try {
    await poll([], {
      stdout: {
        write(value) {
          stdout += value;
        },
      },
    });

    assert.equal(process.exitCode, 2);
    assert.match(stdout, /^error: rough-cut-axi poll requires a project directory$/m);
    assert.match(stdout, /^help: rough-cut-axi poll <project-dir>/m);
  } finally {
    process.exitCode = originalExitCode;
  }
});
