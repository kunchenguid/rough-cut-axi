import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { getConfig } from "../src/config.js";

test("getConfig reads deterministic rough-cut-axi test overrides from the environment", () => {
  const config = getConfig({
    env: {
      HOME: "/home/agent",
      ROUGH_CUT_AXI_HOME: "/tmp/rough-cut-axi-home",
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
      ROUGH_CUT_AXI_TEST_PROJECT_ID: "20260514-120000-test-footage",
      ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR: "/tmp/rough-cut-axi-fixtures/transcripts",
      ROUGH_CUT_AXI_FFMPEG_BIN: "/tmp/rough-cut-axi-tools/ffmpeg",
      ROUGH_CUT_AXI_FFPROBE_BIN: "/tmp/rough-cut-axi-tools/ffprobe",
    },
  });

  assert.equal(config.homeDir, path.resolve("/tmp/rough-cut-axi-home"));
  assert.equal(config.projectsDir, path.resolve("/tmp/rough-cut-axi-home/projects"));
  assert.equal(config.noBrowserOpen, true);
  assert.equal(config.testProjectId, "20260514-120000-test-footage");
  assert.equal(config.elevenLabsFixtureDir, path.resolve("/tmp/rough-cut-axi-fixtures/transcripts"));
  assert.equal(config.ffmpegBin, path.resolve("/tmp/rough-cut-axi-tools/ffmpeg"));
  assert.equal(config.ffprobeBin, path.resolve("/tmp/rough-cut-axi-tools/ffprobe"));
});

test("getConfig falls back to ~/.rough-cut-axi and disables optional test overrides", () => {
  const config = getConfig({ env: { HOME: "/home/agent" } });

  assert.equal(config.homeDir, path.resolve("/home/agent/.rough-cut-axi"));
  assert.equal(config.projectsDir, path.resolve("/home/agent/.rough-cut-axi/projects"));
  assert.equal(config.noBrowserOpen, false);
  assert.equal(config.testProjectId, "");
  assert.equal(config.elevenLabsFixtureDir, "");
  assert.equal(config.ffmpegBin, "ffmpeg");
  assert.equal(config.ffprobeBin, "ffprobe");
});
