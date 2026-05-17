import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("open creates a footage project and editor session", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-open-e2e-"));
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "open", mediaPath], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "test-key",
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_TEST_PROJECT_ID: "e2e-open-footage",
      },
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("project: e2e-open-footage");
    expect(stdout).toContain("footages: 1 footage");
    expect(stdout).toContain("session:");

    const projectDir = path.join(homeDir, "projects", "e2e-open-footage");
    const projectJson = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    expect(projectJson.footages).toHaveLength(1);
    expect(projectJson.footages[0]).toMatchObject({
      id: "ftg_1",
      name: "one_sentence.mp4",
      label: "One Sentence",
      path: mediaPath,
      transcriptPath: "transcripts/one_sentence.json",
      passages: [],
    });
    expect(projectJson.footages[0].footageFingerprint).toMatch(/^size:\d+:mtimeMs:\d+(?:\.\d+)?$/);
    expect(projectJson.timeline).toEqual(["ftg_1"]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
