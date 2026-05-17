import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../src/server.js";

test("startServer serves a health endpoint with the configured project home", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  const server = await startServer({
    config: {
      homeDir: "/tmp/rough-cut-axi-home",
      projectsDir: "/tmp/rough-cut-axi-home/projects",
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      app: "rough-cut-axi",
      version: packageJson.version,
      homeDir: "/tmp/rough-cut-axi-home",
      projectsDir: "/tmp/rough-cut-axi-home/projects",
    });
  } finally {
    await server.close();
  }
});

test("startServer serves the official transcript-first editor shell", async () => {
  const server = await startServer({
    config: {
      homeDir: "/tmp/rough-cut-axi-home",
      projectsDir: "/tmp/rough-cut-axi-home/projects",
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(server.url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(html, /data-region="manuscript"/);
    assert.match(html, /data-region="preview"/);
    assert.match(html, /data-region="footages-strip"/);
    assert.match(html, /data-region="agent-dock"/);
    assert.match(html, /data-action="render-final"/);
    assert.match(html, /No transcript yet\. Run `rough-cut-axi transcribe` and the prose will fill in\./);
    assert.doesNotMatch(html, /data-region="media-bin"/);
    assert.doesNotMatch(html, /role="tablist"/);
    assert.doesNotMatch(html, new RegExp("_rough" + "CutSegments"));
    assert.doesNotMatch(extractTopbar(html), /preview:|agent:|kept|skipped|cut:/);
  } finally {
    await server.close();
  }
});

test("startServer renders passage speaker runs like the editor mock", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-speaker-runs-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-speaker-runs");
  const project = createProject({ title: "Speaker run manuscript" });
  project.footages[0].passages.push(
    {
      id: "passage_ftg_1_0002",
      start: 2.8,
      end: 4.1,
      speaker: "speaker_1",
      text: "Second sentence from the same speaker.",
      status: "keep",
      reason: "Same speaker run.",
    },
    {
      id: "passage_ftg_1_0003",
      start: 4.3,
      end: 5.5,
      speaker: "speaker_2",
      text: "A different speaker answers.",
      status: "keep",
      reason: "New speaker run.",
    },
  );
  await writeProject(projectDir, project);

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/?project=${encodeURIComponent(projectDir)}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(countMatches(html, /data-region="passage-line"/g), 2);
    assert.match(html, /Hello world, this is Video AXI\.[\s\S]*Second sentence from the same speaker\./);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer renders interactive footage cards in cut order", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-footage-strip-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-footage-strip");
  const project = createProject({ title: "Footage strip" });
  project.timeline = ["ftg_1", "ftg_2"];
  project.footages.push({
    ...project.footages[0],
    id: "ftg_2",
    name: "two_sentence.mp4",
    label: "Two sentence",
    passages: [
      {
        id: "passage_ftg_2_0001",
        start: 0.1,
        end: 1.4,
        speaker: "speaker_1",
        text: "Another piece of footage.",
        status: "keep",
        reason: "Second footage.",
      },
    ],
  });
  await writeProject(projectDir, project);

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/?project=${encodeURIComponent(projectDir)}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<button class="footage-card"[\s\S]*data-active="true"/);
    assert.match(html, /data-region="footage-arrow"/);
    assert.doesNotMatch(html, /<article class="footage-card"/);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer renders final exports from the browser", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-render-final-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-render-final");
  await writeProject(projectDir, createProject({}));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  await writeMockFfmpeg(ffmpegBin, {
    encoders: " V..... libx264              H.264\n V..... prores_ks            Apple ProRes\n",
  });
  const renderCalls = [];

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
      ffmpegBin,
    },
    finalRenderer: async ({ projectDir: renderedProjectDir, settings }) => {
      renderCalls.push({ projectDir: renderedProjectDir, settings });
      return { outputPath: path.join(renderedProjectDir, "renders", "final.mov"), sizeBytes: 12345678 };
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/render-final`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, settings: { frameRate: 60, codec: "h264" } }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(renderCalls, [
      { projectDir: path.resolve(projectDir), settings: { frameRate: 60, codec: "h264" } },
    ]);
    assert.deepEqual(JSON.parse(await readFile(path.join(homeDir, "render-settings.json"), "utf8")), {
      version: 1,
      final: { frameRate: 60, codec: "h264" },
    });
    assert.deepEqual(body, {
      ok: true,
      outputPath: path.join(path.resolve(projectDir), "renders", "final.mov"),
      sizeBytes: 12345678,
    });
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer streams render final progress events", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-render-progress-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-render-progress");
  await writeProject(projectDir, createProject({}));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  await writeMockFfmpeg(ffmpegBin, {
    encoders: " V..... libx264              H.264\n V..... prores_ks            Apple ProRes\n",
  });
  const jobId = "render_progress_test";

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
      ffmpegBin,
    },
    finalRenderer: async ({ projectDir: renderedProjectDir, onProgress }) => {
      onProgress({ percent: 0.25, outTime: 0.59, expectedDuration: 2.36 });
      onProgress({ percent: 0.75, outTime: 1.77, expectedDuration: 2.36 });
      return { outputPath: path.join(renderedProjectDir, "renders", "final.mov"), sizeBytes: 12345678 };
    },
    port: 0,
  });

  try {
    const progressResponse = await fetch(`${server.url}/api/render-final-progress?jobId=${jobId}`);
    assert.equal(progressResponse.status, 200);
    const progressTextPromise = readResponseStreamUntil(progressResponse, '"percent":0.75');
    const response = await fetch(`${server.url}/api/render-final`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, settings: { frameRate: 60, codec: "h264" }, jobId }),
    });

    assert.equal(response.status, 200);
    const progressText = await progressTextPromise;
    assert.match(progressText, /event: render-progress/);
    assert.match(progressText, /"percent":0\.25/);
    assert.match(progressText, /"percent":0\.75/);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer reveals rendered files inside the project", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-reveal-render-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-reveal-render");
  const outputPath = path.join(projectDir, "renders", "final.mov");
  await writeProject(projectDir, createProject({}));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "movie");
  const revealCalls = [];

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    fileRevealer: async (filePath) => {
      revealCalls.push(filePath);
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/reveal-render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, file: "renders/final.mov" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(revealCalls, [outputPath]);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer serves render settings from current ffmpeg and user defaults", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-render-settings-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-render-settings");
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  await writeProject(projectDir, createProject({}));
  await writeFile(
    path.join(homeDir, "render-settings.json"),
    `${JSON.stringify({ version: 1, final: { frameRate: 60, codec: "h264" } }, null, 2)}\n`,
  );
  await writeMockFfmpeg(ffmpegBin, {
    encoders: " V..... libx264              H.264\n V..... prores_ks            Apple ProRes\n",
  });

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
      ffmpegBin,
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/render-settings?project=${encodeURIComponent(projectDir)}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.settings, { frameRate: 60, codec: "h264" });
    assert.deepEqual(body.summary, { duration: 2.36, footages: 1 });
    assert.deepEqual(
      body.options.codecs.map(({ value, available }) => ({ value, available })),
      [
        { value: "h264", available: true },
        { value: "h265", available: false },
        { value: "prores", available: true },
      ],
    );
    assert.deepEqual(
      body.options.frameRates.map(({ value, available }) => ({ value, available })),
      [
        { value: 24, available: true },
        { value: 30, available: true },
        { value: 60, available: true },
      ],
    );
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer renders project footages and passages in the manuscript", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-footages-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-footages");
  await writeProject(projectDir, createProject({ title: "Footage manuscript" }));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/?project=${encodeURIComponent(projectDir)}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Footage manuscript/);
    assert.match(html, /Hello world, this is Video AXI\./);
    assert.match(html, /data-region="prose-passage"/);
    assert.match(html, /data-passage-id="passage_ftg_1_0001"/);
    assert.match(html, /data-region="footage-card" data-footage-id="ftg_1"/);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer serves footage media by footage id", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-footage-media-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-footage-media");
  const footagePath = path.join(homeDir, "fixtures", "one_sentence.mp4");
  await mkdir(path.dirname(footagePath), { recursive: true });
  await writeFile(footagePath, "footage bytes");
  await writeProject(projectDir, createProject({ footagePath }));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(
      `${server.url}/api/footage-media?project=${encodeURIComponent(projectDir)}&footage=ftg_1`,
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "footage bytes");
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer serves passage waveform peaks", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-passage-waveform-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-passage-waveform");
  await writeProject(projectDir, createProject({ footagePath: "/absolute/one_sentence.mp4" }));
  const waveformCalls = [];

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    waveformRenderer: async ({ footage, passage, bars }) => {
      waveformCalls.push({ footageId: footage.id, passageId: passage.id, bars });
      return [0, 0.5, 1];
    },
    port: 0,
  });

  try {
    const response = await fetch(
      `${server.url}/api/passage-waveform?project=${encodeURIComponent(projectDir)}&passage=passage_ftg_1_0001&bars=3`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      passageId: "passage_ftg_1_0001",
      peaks: [0, 0.5, 1],
    });
    assert.deepEqual(waveformCalls, [{ footageId: "ftg_1", passageId: "passage_ftg_1_0001", bars: 3 }]);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer applies passage edit operations and updates the render contract", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-passage-edit-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-passage-edit");
  await writeProject(projectDir, createProject({ footagePath: "/absolute/one_sentence.mp4" }));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/edit-operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectDir,
        operation: {
          type: "setPassageStatus",
          passageId: "passage_ftg_1_0001",
          status: "skip",
          reason: "Skipped by user.",
        },
      }),
    });

    assert.equal(response.status, 200);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.footages[0].passages[0].status, "skip");
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8")).segments, []);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer queues a freeform prompt into project chat state", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-prompts-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-prompts");
  await writeProject(projectDir, createProject({}));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, prompt: "Skip repeated passages." }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.pendingPromptCount, 1);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.deepEqual(project.chat.pendingPrompts, [
      {
        uid: "prompt_1",
        tag: "freeform",
        prompt: "Skip repeated passages.",
        target: { type: "project" },
      },
    ]);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer streams an initial project state event over SSE", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-sse-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-sse");
  await writeProject(projectDir, createProject({}));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/project-events?project=${encodeURIComponent(projectDir)}`);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);

    assert.equal(response.status, 200);
    assert.match(text, /event: project-state/);
    assert.match(text, /"timelineFootageCount":1/);
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("startServer applies edits without scheduling a rendered preview", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-server-no-preview-render-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-no-preview-render");
  await writeProject(projectDir, createProject({ footagePath: "/absolute/one_sentence.mp4" }));

  const server = await startServer({
    config: {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    },
    port: 0,
  });

  try {
    const response = await fetch(`${server.url}/api/edit-operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectDir,
        operation: {
          type: "setPassageStatus",
          passageId: "passage_ftg_1_0001",
          status: "skip",
          reason: "Skipped by user.",
        },
      }),
    });
    assert.equal(response.status, 200);

    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.deepEqual(project.render, { finalPath: "renders/final.mov" });
  } finally {
    await server.close();
    await rm(homeDir, { force: true, recursive: true });
  }
});

function createProject({ title = "Server project", footagePath = "/tmp/one_sentence.mp4" } = {}) {
  return {
    version: 1,
    title,
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence.mp4",
        label: "One sentence",
        path: footagePath,
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

async function writeProject(projectDir, project) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
}

function extractTopbar(html) {
  return html.match(/<header class="topbar"[\s\S]*?<\/header>/)?.[0] || "";
}

function countMatches(value, pattern) {
  return Array.from(value.matchAll(pattern)).length;
}

async function readResponseStreamUntil(response, marker) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 1000;
  try {
    while (Date.now() < deadline) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()))),
      ]);
      if (readResult.timeout) {
        break;
      }
      const { done, value } = readResult;
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.includes(marker)) {
        return text;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  assert.fail(`stream did not include ${marker}: ${text}`);
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
