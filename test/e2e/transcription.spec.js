import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("transcribe writes passages and timeline segments for footages", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-transcribe-e2e-"));
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");

  try {
    await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "open", mediaPath], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "test-key",
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_TEST_PROJECT_ID: "e2e-transcribe-footage",
      },
    });

    const projectDir = path.join(homeDir, "projects", "e2e-transcribe-footage");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/rough-cut-axi.js", "transcribe", projectDir],
      {
        env: {
          ...process.env,
          ROUGH_CUT_AXI_HOME: homeDir,
          ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR: path.resolve("test/fixtures/transcripts"),
        },
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("transcription: completed");

    const projectJson = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    expect(projectJson.footages[0].passages[0]).toMatchObject({
      id: "passage_ftg_1_0001",
      status: "keep",
      text: "Hello world, this is Video AXI.",
    });
    expect(projectJson.transcription.completedFootages).toBe(1);

    const timelineJson = JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8"));
    expect(timelineJson.segments[0]).toMatchObject({
      passageId: "passage_ftg_1_0001",
      footageId: "ftg_1",
      footagePath: mediaPath,
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
