import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { getConfig } from "../../src/config.js";
import { startServer } from "../../src/server.js";

const execFileAsync = promisify(execFile);

function getTestConfig(env) {
  return getConfig({ env: { ...process.env, ...env } });
}

test("browser editor shell renders manuscript, preview, footages, and agent", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-e2e-"));
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(server.url);

    await expect(page.getByRole("main", { name: "Rough Cut editor" })).toBeVisible();
    await expect(page.locator('[data-region="manuscript"]')).toBeVisible();
    await expect(page.locator('[data-region="preview"]')).toBeVisible();
    await expect(page.locator('[data-region="footages-strip"]')).toBeVisible();
    await expect(page.locator('[data-region="agent-dock"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Render final" })).toBeDisabled();
    await expect(
      page.getByText("No transcript yet. Run `rough-cut-axi transcribe` and the prose will fill in."),
    ).toBeVisible();
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser passage selection jumps without toggling and explicit skip updates the cut", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-passage-"));
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");
  const projectId = "e2e-editor-passage";

  try {
    await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "open", mediaPath], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "test-key",
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_TEST_PROJECT_ID: projectId,
      },
    });

    const projectDir = path.join(homeDir, "projects", projectId);
    await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "transcribe", projectDir], {
      env: {
        ...process.env,
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR: path.resolve("test/fixtures/transcripts"),
      },
    });

    const server = await startServer({
      config: getTestConfig({
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
      }),
      port: 0,
    });

    try {
      await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

      await expect(page.locator('[data-region="manuscript"]')).toContainText("Hello world, this is Video AXI.");
      await expect(page.locator('[data-region="footages-strip"]')).toContainText("One Sentence");
      await expect(page.locator('[data-region="live-preview-player"]')).toHaveAttribute(
        "data-preview-segment-count",
        "1",
      );

      await page.getByRole("button", { name: "Play live preview" }).click();
      await expect(page.getByRole("button", { name: "Pause live preview" })).toBeVisible();

      await page.getByRole("button", { name: "Select Hello world, this is Video AXI." }).click({ noWaitAfter: true });
      await expect(page.locator('[data-region="live-preview-player"]')).toHaveAttribute(
        "data-playback-intent",
        "paused",
      );
      await expect(page.locator('[data-region="live-preview-player"]')).toHaveJSProperty("paused", true);
      await expect(page.locator('[data-region="prose-passage"][data-selected="true"]')).toHaveAttribute(
        "data-passage-id",
        "passage_ftg_1_0001",
      );
      await expect(page.locator('[data-region="passage-control-bar"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Play selected passage" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Skip selected passage" })).toBeVisible();
      await expect(page.locator('[data-region="footage-card"][data-active="true"]')).toContainText("One Sentence");

      let project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
      expect(project.footages[0].passages[0]).toMatchObject({
        id: "passage_ftg_1_0001",
        status: "keep",
        reason: "Default keep after transcription.",
      });

      await page.getByRole("button", { name: "Skip selected passage" }).click({ noWaitAfter: true });
      await expect(page.getByRole("button", { name: "Keep selected passage" })).toBeVisible();
      await expect(page.locator('[data-region="live-preview-player"]')).toHaveAttribute(
        "data-preview-segment-count",
        "0",
      );

      project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
      expect(project.footages[0].passages[0]).toMatchObject({
        id: "passage_ftg_1_0001",
        status: "skip",
        reason: "Skipped by user.",
      });
      expect(JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8")).segments).toEqual([]);
    } finally {
      await server.close();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser render final button calls the final renderer", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-render-final-"));
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");
  const projectId = "e2e-editor-render-final";
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const renderCalls = [];
  let finishRender = null;

  try {
    await writeMockFfmpeg(ffmpegBin, {
      encoders: " V..... libx264              H.264\n V..... prores_ks            Apple ProRes\n",
    });
    await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "open", mediaPath], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "test-key",
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_TEST_PROJECT_ID: projectId,
      },
    });

    const projectDir = path.join(homeDir, "projects", projectId);
    await page.addInitScript(() => {
      const writes = [];
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText(value) {
            writes.push(value);
            globalThis.__roughCutClipboardWrites = writes;
            return Promise.resolve();
          },
        },
      });
    });
    const server = await startServer({
      config: getTestConfig({
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_FFMPEG_BIN: ffmpegBin,
      }),
      finalRenderer: async ({ projectDir: renderedProjectDir, settings, onProgress }) => {
        renderCalls.push({ projectDir: renderedProjectDir, settings });
        if (typeof onProgress === "function") {
          onProgress({ percent: 0.5, outTime: 1.18, expectedDuration: 2.36 });
          await new Promise((resolve) => {
            finishRender = resolve;
          });
        }
        return { outputPath: path.join(renderedProjectDir, "renders", "final.mov"), sizeBytes: 12345678 };
      },
      port: 0,
    });

    try {
      await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);
      await page.getByRole("button", { name: "Render final" }).click();
      await expect(page.getByRole("dialog", { name: "Final render" })).toBeVisible();
      await page.getByRole("button", { name: "60" }).click();
      await page.getByRole("button", { name: "H.264" }).click();
      await page.getByRole("button", { name: "Start render" }).click();
      await expect(page.locator('[data-region="render-progress-label"]')).toContainText("50%");
      finishRender?.();
      await expect(page.getByRole("dialog", { name: "Rendered." })).toBeVisible();
      await expect(page.locator('[data-region="render-output-path"]')).toContainText("renders/final.mov");
      await expect(page.locator('[data-region="render-output-size"]')).toContainText("11.8 MB");
      await page.getByRole("button", { name: "Copy path" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => globalThis.__roughCutClipboardWrites)).toEqual([
        path.join(projectDir, "renders", "final.mov"),
      ]);
      expect(renderCalls).toEqual([{ projectDir, settings: { frameRate: 60, codec: "h264" } }]);
    } finally {
      await server.close();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser render final button shows render errors", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-render-final-error-"));
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");
  const projectId = "e2e-editor-render-final-error";
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");

  try {
    await writeMockFfmpeg(ffmpegBin, { encoders: " V..... prores_ks            Apple ProRes\n" });
    await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", "open", mediaPath], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "test-key",
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_TEST_PROJECT_ID: projectId,
      },
    });

    const projectDir = path.join(homeDir, "projects", projectId);
    const server = await startServer({
      config: getTestConfig({
        ROUGH_CUT_AXI_HOME: homeDir,
        ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
        ROUGH_CUT_AXI_FFMPEG_BIN: ffmpegBin,
      }),
      finalRenderer: async () => {
        throw new Error("render duration mismatch: expected 779.56s, got 792.48s");
      },
      port: 0,
    });

    try {
      await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);
      await page.getByRole("button", { name: "Render final" }).click();
      await page.getByRole("button", { name: "Start render" }).click();

      await expect(page.getByRole("dialog", { name: "Render failed." })).toBeVisible();
      await expect(page.locator('[data-region="render-dialog-error"]')).toContainText(
        "render duration mismatch: expected 779.56s, got 792.48s",
      );
      await expect(page.getByRole("button", { name: "Render final" })).toBeEnabled();
    } finally {
      await server.close();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser live preview toggle pauses playback", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-live-preview-pause-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-live-preview-pause");
  await writeProject(projectDir, createPreviewProject());
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Play live preview" }).click();
    await expect(page.getByRole("button", { name: "Pause live preview" })).toBeVisible();

    await page.getByRole("button", { name: "Pause live preview" }).click();
    await expect(page.getByRole("button", { name: "Play live preview" })).toBeVisible();
    await expect(page.locator('[data-region="live-preview-player"]')).toHaveJSProperty("paused", true);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser live preview stays paused during segment loads", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-live-preview-load-pause-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-live-preview-load-pause");
  await writeProject(projectDir, createTwoFootagePreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Play live preview" }).click();
    await expect(page.getByRole("button", { name: "Pause live preview" })).toBeVisible();
    const pendingLoad = await page.locator('[data-region="live-preview-player"]').evaluate((player) => {
      globalThis.setLivePreviewSegment(1, true);
      return {
        index: player.dataset.currentSegmentIndex,
        playCount: player.__roughCutPlayCount,
      };
    });
    expect(pendingLoad).toEqual({ index: "1", playCount: 1 });

    await page.getByRole("button", { name: "Pause live preview" }).click();
    await expect(page.getByRole("button", { name: "Play live preview" })).toBeVisible();
    await expect(page.locator('[data-region="live-preview-player"]')).toHaveAttribute("data-playback-intent", "paused");
    const pausedAfterLoad = await page.locator('[data-region="live-preview-player"]').evaluate((player) => {
      player.dispatchEvent(new Event("loadedmetadata"));
      return {
        paused: player.paused,
        playCount: player.__roughCutPlayCount,
      };
    });

    expect(pausedAfterLoad).toEqual({ paused: true, playCount: 1 });
    await expect(page.getByRole("button", { name: "Play live preview" })).toBeVisible();
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser live preview advances at the stored segment end", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-live-preview-stored-end-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-live-preview-stored-end");
  await writeProject(projectDir, createThreePassagePreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Play live preview" }).click();
    const beforeStoredEnd = await page.locator('[data-region="live-preview-player"]').evaluate((player) => {
      globalThis.setLivePreviewSegment(1, true);
      player.currentTime = 2.96;
      player.dispatchEvent(new Event("timeupdate"));
      return {
        currentSegmentIndex: player.dataset.currentSegmentIndex,
        currentTime: player.currentTime,
        paused: player.paused,
      };
    });
    expect(beforeStoredEnd).toEqual({ currentSegmentIndex: "1", currentTime: 2.96, paused: false });

    const atStoredEnd = await page.locator('[data-region="live-preview-player"]').evaluate((player) => {
      player.currentTime = 3;
      player.dispatchEvent(new Event("timeupdate"));
      return {
        currentSegmentIndex: player.dataset.currentSegmentIndex,
        currentTime: player.currentTime,
        paused: player.paused,
      };
    });
    expect(atStoredEnd).toEqual({ currentSegmentIndex: "2", currentTime: 4, paused: false });
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser live preview pause works with a deliberate mouse click", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-live-preview-slow-pause-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-live-preview-slow-pause");
  await writeProject(projectDir, createPreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Play live preview" }).click();
    const pauseButton = page.getByRole("button", { name: "Pause live preview" });
    await expect(pauseButton).toBeVisible();
    const buttonBox = await pauseButton.boundingBox();
    expect(buttonBox).not.toBeNull();

    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();

    await expect(page.getByRole("button", { name: "Play live preview" })).toBeVisible();
    await expect(page.locator('[data-region="live-preview-player"]')).toHaveJSProperty("paused", true);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser timeline scrub does not activate passages without selection", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-active-timeline-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-active-timeline");
  await writeProject(projectDir, createLongTranscriptProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await expect(page.locator('[data-region="prose-passage"][data-active="true"]')).toHaveCount(0);
    await page.locator('[data-region="manuscript"]').evaluate((element) => element.scrollTo(0, 0));
    const scrubResult = await page.locator('[data-region="live-preview-scrubber"]').evaluate((scrubber) => {
      scrubber.value = "60.05";
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      const player = globalThis.document.querySelector('[data-region="live-preview-player"]');
      return {
        activePassageCount: globalThis.document.querySelectorAll('[data-region="prose-passage"][data-active="true"]')
          .length,
        currentSegmentIndex: player?.dataset.currentSegmentIndex || "",
        currentTime: player?.currentTime || 0,
        max: scrubber.max,
        scrubberValue: scrubber.value,
      };
    });

    expect(scrubResult).toMatchObject({
      activePassageCount: 0,
      currentSegmentIndex: "40",
      currentTime: 80.05,
      max: "120.00",
      scrubberValue: "60.05",
    });
    await expect(page.locator('[data-region="prose-passage"][data-active="true"]')).toHaveCount(0);
    await expect
      .poll(() => page.locator('[data-region="manuscript"]').evaluate((element) => element.scrollTop))
      .toBe(0);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser passage clicks select and seek the live preview without changing status", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-passage-seek-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-passage-seek");
  await writeProject(projectDir, createThreePassagePreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Select Second passage." }).click();
    await expect(page.locator('[data-region="prose-passage"][data-selected="true"]')).toHaveAttribute(
      "data-passage-id",
      "passage_ftg_1_0002",
    );
    await expect(page.locator('[data-region="live-preview-player"]')).toHaveAttribute(
      "data-preview-segment-count",
      "3",
    );
    await expect(page.locator('[data-region="prose-passage"][data-active="true"]')).toHaveAttribute(
      "data-passage-id",
      "passage_ftg_1_0002",
    );
    await expect
      .poll(() => page.locator('[data-region="live-preview-player"]').evaluate((player) => player.currentTime))
      .toBe(2);

    const beforeDeselect = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    expect(beforeDeselect.footages[0].passages[1].status).toBe("keep");

    await page.getByRole("button", { name: "Select Second passage." }).click();
    await expect(page.locator('[data-region="prose-passage"][data-selected="true"]')).toHaveCount(0);
    await expect(page.locator('[data-region="passage-control-bar"]')).toBeHidden();
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser selected passage control bar sits in prose flow after the passage", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-control-gap-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-control-gap");
  const project = createThreePassagePreviewProject();
  await writeProject(projectDir, project);
  await installMockPreviewMedia(page);
  await page.route("**/api/passage-waveform?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, peaks: [] }) });
  });
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);
    await page.getByRole("button", { name: "Select First passage." }).click();

    const layout = await page.evaluate(() => {
      const toolbar = globalThis.document.querySelector('[data-region="passage-control-bar"]');
      const selected = globalThis.document.querySelector('[data-region="prose-passage"][data-selected="true"]');
      const nextPassage = globalThis.document.querySelector('[data-passage-id="passage_ftg_1_0002"]');
      return {
        gap: nextPassage.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom,
        nextPassageFollowsToolbar: toolbar.nextElementSibling === nextPassage,
        selectedPassagePrecedesToolbar: toolbar.previousElementSibling === selected,
      };
    });

    expect(layout).toMatchObject({
      nextPassageFollowsToolbar: true,
      selectedPassagePrecedesToolbar: true,
    });
    expect(layout.gap).toBeGreaterThanOrEqual(14);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser passage play uses passage audio and updates the selected waveform", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-passage-audio-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-passage-audio");
  const project = createThreePassagePreviewProject();
  project.footages[0].passages[1].status = "skip";
  await writeProject(projectDir, project);
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Select Second passage." }).click();
    const selectedPassagePlayButton = page.getByRole("button", { name: "Play selected passage" });
    const playButtonWidth = await selectedPassagePlayButton.evaluate((button) => button.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Play selected passage" }).click();

    const playback = await page.evaluate(() => {
      const preview = globalThis.document.querySelector('[data-region="live-preview-player"]');
      const passageAudio = globalThis.document.querySelector('[data-region="passage-audio-player"]');
      return {
        passageAudioPaused: passageAudio.paused,
        passageAudioCurrentTime: passageAudio.currentTime,
        passageAudioPlayCount: passageAudio.__roughCutPlayCount,
        previewPaused: preview.paused,
        previewPlayCount: preview.__roughCutPlayCount || 0,
      };
    });

    expect(playback).toMatchObject({
      passageAudioPaused: false,
      passageAudioCurrentTime: 2,
      passageAudioPlayCount: 1,
      previewPaused: true,
      previewPlayCount: 0,
    });
    await expect(page.getByRole("button", { name: "Pause selected passage" })).toBeVisible();

    const playedBars = await page.evaluate(() => {
      const passageAudio = globalThis.document.querySelector('[data-region="passage-audio-player"]');
      passageAudio.currentTime = 2.6;
      passageAudio.dispatchEvent(new Event("timeupdate"));
      return globalThis.document.querySelectorAll('[data-region="passage-waveform-bar"][data-played="true"]').length;
    });

    expect(playedBars).toBeGreaterThan(0);
    const pauseButtonWidth = await page
      .getByRole("button", { name: "Pause selected passage" })
      .evaluate((button) => button.getBoundingClientRect().width);
    expect(pauseButtonWidth).toBe(playButtonWidth);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser passage play stops at the selected passage end", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-passage-audio-stored-end-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-passage-audio-stored-end");
  await writeProject(projectDir, createThreePassagePreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Select Second passage." }).click();
    await page.getByRole("button", { name: "Play selected passage" }).click();

    const beforeStoredEnd = await page.evaluate(() => {
      const passageAudio = globalThis.document.querySelector('[data-region="passage-audio-player"]');
      passageAudio.currentTime = 2.96;
      passageAudio.dispatchEvent(new Event("timeupdate"));
      return {
        currentTime: passageAudio.currentTime,
        paused: passageAudio.paused,
      };
    });
    expect(beforeStoredEnd).toEqual({ currentTime: 2.96, paused: false });

    const atStoredEnd = await page.evaluate(() => {
      const passageAudio = globalThis.document.querySelector('[data-region="passage-audio-player"]');
      passageAudio.currentTime = 3;
      passageAudio.dispatchEvent(new Event("timeupdate"));
      return {
        currentTime: passageAudio.currentTime,
        paused: passageAudio.paused,
      };
    });
    expect(atStoredEnd).toEqual({ currentTime: 3, paused: true });
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser selected passage renders real waveform heights", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-real-waveform-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-real-waveform");
  await writeProject(projectDir, createThreePassagePreviewProject());
  await installMockPreviewMedia(page);
  await page.route("**/api/passage-waveform?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        passageId: "passage_ftg_1_0002",
        peaks: [0, 0.25, 0.5, 1],
      }),
    });
  });
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);
    await page.getByRole("button", { name: "Select Second passage." }).click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(globalThis.document.querySelectorAll('[data-region="passage-waveform-bar"]'))
            .slice(0, 4)
            .map((bar) => ({
              value: bar.dataset.waveformValue,
              height: bar.style.getPropertyValue("--bar-height"),
            })),
        ),
      )
      .toEqual([
        { value: "0", height: "3px" },
        { value: "0.25", height: "9px" },
        { value: "0.5", height: "16px" },
        { value: "1", height: "28px" },
      ]);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser waveform click immediately splits the selected passage", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-waveform-split-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-waveform-split");
  await writeProject(projectDir, createThreePassagePreviewProject());
  await installMockPreviewMedia(page);
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.getByRole("button", { name: "Select Second passage." }).click();
    const waveform = page.locator('[data-region="passage-waveform"]');
    const box = await waveform.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
      .poll(async () => JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8")).footages[0].passages)
      .toEqual([
        expect.objectContaining({ id: "passage_ftg_1_0001", start: 0, end: 1 }),
        expect.objectContaining({ id: "passage_ftg_1_0002", start: 2, end: 2.42 }),
        expect.objectContaining({ id: "passage_0004", start: 2.42, end: 3 }),
        expect.objectContaining({ id: "passage_ftg_1_0003", start: 4, end: 5 }),
      ]);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser waveform split preserves manuscript scroll", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-split-scroll-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-split-scroll");
  await writeProject(projectDir, createLongTranscriptProject());
  await installMockPreviewMedia(page);
  await page.route("**/api/passage-waveform?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, peaks: [] }) });
  });
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    await page.locator('[data-passage-id="passage_ftg_1_0041"]').scrollIntoViewIfNeeded();
    await page.locator('[data-passage-id="passage_ftg_1_0041"]').click();
    const beforeSplitScrollTop = await page
      .locator('[data-region="manuscript"]')
      .evaluate((element) => element.scrollTop);
    expect(beforeSplitScrollTop).toBeGreaterThan(0);

    const waveform = page.locator('[data-region="passage-waveform"]');
    const box = await waveform.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
      .poll(async () => JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8")).footages[0].passages)
      .toHaveLength(81);
    await expect
      .poll(() => page.locator('[data-region="manuscript"]').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeSplitScrollTop - 40);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser editor keeps the shell fixed while the manuscript scrolls", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-fixed-shell-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-fixed-shell");
  await writeProject(projectDir, createLongTranscriptProject());
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    const layout = await page.evaluate(() => {
      const documentScroller = globalThis.document.scrollingElement;
      const manuscript = globalThis.document.querySelector('[data-region="manuscript"]');
      const sendButton = globalThis.document.querySelector('[data-action="queue-prompt"]');
      return {
        documentClientHeight: documentScroller.clientHeight,
        manuscriptClientHeight: manuscript.clientHeight,
        manuscriptScrollHeight: manuscript.scrollHeight,
        sendButtonBottom: sendButton.getBoundingClientRect().bottom,
        viewportHeight: globalThis.innerHeight,
      };
    });

    expect(layout.documentClientHeight).toBe(layout.viewportHeight);
    expect(layout.manuscriptScrollHeight).toBeGreaterThan(layout.manuscriptClientHeight + 400);
    expect(layout.sendButtonBottom).toBeLessThanOrEqual(layout.viewportHeight);

    await page.evaluate(() => globalThis.scrollTo(0, 500));
    expect(await page.evaluate(() => globalThis.scrollY)).toBe(0);

    const manuscript = page.locator('[data-region="manuscript"]');
    const manuscriptScrollTop = await manuscript.evaluate((element) => {
      element.scrollTo(0, 1200);
      return element.scrollTop;
    });
    expect(manuscriptScrollTop).toBeGreaterThan(0);
    expect(await page.evaluate(() => globalThis.scrollY)).toBe(0);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("browser manuscript uses more width on wide screens", async ({ page }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-browser-wide-prose-"));
  const projectDir = path.join(homeDir, "projects", "e2e-editor-wide-prose");
  await writeProject(projectDir, createLongTranscriptProject());
  const server = await startServer({
    config: getTestConfig({
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
    }),
    port: 0,
  });

  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`${server.url}?project=${encodeURIComponent(projectDir)}`);

    const manuscriptWidth = await page.locator('[data-region="manuscript-page"]').evaluate((element) => {
      const passageText = element.querySelector(".passage-text");
      return {
        page: element.getBoundingClientRect().width,
        prose: passageText.getBoundingClientRect().width,
      };
    });

    expect(manuscriptWidth.page).toBeGreaterThanOrEqual(900);
    expect(manuscriptWidth.prose).toBeGreaterThanOrEqual(640);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

function createLongTranscriptProject() {
  const passages = Array.from({ length: 80 }, (_, index) => ({
    id: `passage_ftg_1_${String(index + 1).padStart(4, "0")}`,
    start: index * 2,
    end: index * 2 + 1.5,
    speaker: "speaker_1",
    text: `This is transcript passage ${index + 1}, long enough to force the manuscript into its own scrolling pane without moving the agent composer.`,
    status: "keep",
    reason: "Default keep after transcription.",
  }));

  return {
    version: 1,
    title: "Long transcript",
    footages: [
      {
        id: "ftg_1",
        name: "long.mp4",
        label: "Long transcript",
        path: path.resolve("test/fixtures/media/one_sentence.mp4"),
        duration: 160,
        transcriptPath: "transcripts/long.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages,
      },
    ],
    timeline: ["ftg_1"],
    chat: {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    },
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  };
}

async function installMockPreviewMedia(page) {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return this.__roughCutPaused ?? true;
      },
    });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        return this.__roughCutCurrentTime ?? 0;
      },
      set(value) {
        this.__roughCutCurrentTime = Number(value) || 0;
      },
    });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "src", {
      configurable: true,
      get() {
        return this.__roughCutSrc || "";
      },
      set(value) {
        this.__roughCutSrc = new URL(value, globalThis.location.href).href;
      },
    });
    globalThis.HTMLMediaElement.prototype.load = function load() {};
    globalThis.HTMLMediaElement.prototype.play = function play() {
      this.__roughCutPlayCount = (this.__roughCutPlayCount || 0) + 1;
      this.__roughCutPaused = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    globalThis.HTMLMediaElement.prototype.pause = function pause() {
      this.__roughCutPaused = true;
      this.dispatchEvent(new Event("pause"));
    };
  });
}

function createPreviewProject() {
  return {
    version: 1,
    title: "Preview pause",
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence.mp4",
        label: "One Sentence",
        path: path.resolve("test/fixtures/media/one_sentence.mp4"),
        duration: 3,
        transcriptPath: "transcripts/one_sentence.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.28,
            end: 2.64,
            speaker: "speaker_1",
            text: "Hello world, this is Video AXI.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
        ],
      },
    ],
    timeline: ["ftg_1"],
    chat: {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    },
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  };
}

function createTwoFootagePreviewProject() {
  const mediaPath = path.resolve("test/fixtures/media/one_sentence.mp4");
  return {
    version: 1,
    title: "Preview load pause",
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence_1.mp4",
        label: "One Sentence 1",
        path: mediaPath,
        duration: 3,
        transcriptPath: "transcripts/one_sentence_1.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.1,
            end: 1,
            speaker: "speaker_1",
            text: "First preview segment.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
        ],
      },
      {
        id: "ftg_2",
        name: "one_sentence_2.mp4",
        label: "One Sentence 2",
        path: mediaPath,
        duration: 3,
        transcriptPath: "transcripts/one_sentence_2.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages: [
          {
            id: "passage_ftg_2_0001",
            start: 0.1,
            end: 1,
            speaker: "speaker_1",
            text: "Second preview segment.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
        ],
      },
    ],
    timeline: ["ftg_1", "ftg_2"],
    chat: {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    },
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  };
}

function createThreePassagePreviewProject() {
  return {
    version: 1,
    title: "Passage seek",
    footages: [
      {
        id: "ftg_1",
        name: "passage_seek.mp4",
        label: "Passage seek",
        path: path.resolve("test/fixtures/media/one_sentence.mp4"),
        duration: 6,
        transcriptPath: "transcripts/passage_seek.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0,
            end: 1,
            speaker: "speaker_1",
            text: "First passage.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
          {
            id: "passage_ftg_1_0002",
            start: 2,
            end: 3,
            speaker: "speaker_1",
            text: "Second passage.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
          {
            id: "passage_ftg_1_0003",
            start: 4,
            end: 5,
            speaker: "speaker_1",
            text: "Third passage.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
        ],
      },
    ],
    timeline: ["ftg_1"],
    chat: {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    },
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  };
}

async function writeProject(projectDir, project) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
}

async function writeMockFfmpeg(toolPath, { encoders = "" } = {}) {
  await writeFile(
    toolPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  process.stdout.write(${JSON.stringify(encoders)});
  process.exit(0);
}
process.stdout.write("mock ffmpeg");
`,
  );
  await chmod(toolPath, 0o755);
}
