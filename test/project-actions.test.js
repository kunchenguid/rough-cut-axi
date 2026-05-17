import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyPersistedEditOperation, queuePrompt, renderFinalProject } from "../src/project-actions.js";

test("queuePrompt appends trimmed prompts to project chat state", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-actions-prompt-"));
  const projectDir = path.join(homeDir, "projects", "prompt-project");
  await writeProject(projectDir, createProject());

  try {
    const result = await queuePrompt({ projectDir, prompt: "  Tighten the opener.  " });
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));

    assert.equal(result.pendingPromptCount, 1);
    assert.deepEqual(project.chat.pendingPrompts, [
      {
        uid: "prompt_1",
        tag: "freeform",
        prompt: "Tighten the opener.",
        target: { type: "project" },
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("applyPersistedEditOperation updates project state and timeline export", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-actions-apply-"));
  const projectDir = path.join(homeDir, "projects", "apply-project");
  await writeProject(projectDir, createProject());

  try {
    const result = await applyPersistedEditOperation({
      projectDir,
      operation: {
        type: "setPassageStatus",
        passageId: "passage_ftg_1_0001",
        status: "skip",
        reason: "Skipped by user.",
      },
    });
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    const timeline = JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8"));

    assert.equal(result.ok, true);
    assert.equal(project.footages[0].passages[0].status, "skip");
    assert.deepEqual(timeline.segments, []);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("applyPersistedEditOperation splits passage text from transcript words", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-actions-split-text-"));
  const projectDir = path.join(homeDir, "projects", "split-text-project");
  await writeProject(projectDir, createProject());
  await mkdir(path.join(projectDir, "transcripts"), { recursive: true });
  await writeFile(
    path.join(projectDir, "transcripts", "one_sentence.json"),
    `${JSON.stringify({
      words: [
        { text: "Hello", start: 0.28, end: 0.6 },
        { text: "world,", start: 0.6, end: 1.1 },
        { text: "this", start: 1.1, end: 1.5 },
        { text: "is", start: 1.5, end: 1.8 },
        { text: "Rough", start: 1.8, end: 2.2 },
        { text: "Cut", start: 2.2, end: 2.4 },
        { text: "AXI.", start: 2.4, end: 2.64 },
      ],
    })}\n`,
  );

  try {
    await applyPersistedEditOperation({
      projectDir,
      operation: {
        type: "splitPassage",
        passageId: "passage_ftg_1_0001",
        at: 1.5,
      },
    });
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));

    assert.deepEqual(
      project.footages[0].passages.map(({ text, start, end }) => ({ text, start, end })),
      [
        { text: "Hello world, this", start: 0.28, end: 1.42 },
        { text: "is Rough Cut AXI.", start: 1.42, end: 2.64 },
      ],
    );
    assert.deepEqual(project.operationLog.at(-1), {
      type: "splitPassage",
      passageId: "passage_ftg_1_0001",
      at: 1.5,
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("renderFinalProject rewrites timeline before calling the final renderer", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-actions-render-final-"));
  const projectDir = path.join(homeDir, "projects", "render-project");
  await writeProject(projectDir, createProject());
  const renderCalls = [];

  try {
    const result = await renderFinalProject({
      projectDir,
      config: { ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" },
      renderer: async ({ projectDir: renderedProjectDir }) => {
        renderCalls.push(renderedProjectDir);
        return { outputPath: path.join(renderedProjectDir, "renders", "final.mov") };
      },
    });
    const timeline = JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8"));

    assert.deepEqual(renderCalls, [path.resolve(projectDir)]);
    assert.equal(result.outputPath, path.join(path.resolve(projectDir), "renders", "final.mov"));
    assert.equal(timeline.segments.length, 1);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

async function writeProject(projectDir, project) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
}

function createProject() {
  return {
    version: 1,
    title: "Project actions",
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence.mp4",
        label: "One sentence",
        path: "/tmp/one_sentence.mp4",
        duration: 3,
        transcriptPath: "transcripts/one_sentence.json",
        footageFingerprint: "size:1:mtimeMs:1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.28,
            end: 2.64,
            speaker: "speaker_1",
            text: "Hello world, this is Rough Cut AXI.",
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
