import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyEditOperation } from "../src/edit-operations.js";
import { createInitialProject } from "../src/project-schema.js";
import { writeTimelineExport } from "../src/project-store.js";
import { startServer } from "../src/server.js";

function createPassageProject() {
  return createInitialProject({
    title: "Passage model",
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
            text: "Hello world, this is Video AXI.",
            status: "keep",
            reason: "Default keep after transcription.",
          },
        ],
      },
    ],
  });
}

test("createInitialProject stores footages with nested passages as the canonical model", () => {
  const project = createPassageProject();

  assert.deepEqual(Object.keys(project), [
    "version",
    "title",
    "footages",
    "timeline",
    "chat",
    "render",
    "operationLog",
  ]);
  assert.deepEqual(project.timeline, ["ftg_1"]);
  assert.equal(project.footages[0].passages[0].id, "passage_ftg_1_0001");
});

test("setPassageStatus updates a passage and leaves the footage timeline intact", () => {
  const project = createPassageProject();

  const result = applyEditOperation(project, {
    type: "setPassageStatus",
    passageId: "passage_ftg_1_0001",
    status: "skip",
    reason: "Repeated setup.",
  });

  assert.equal(result.footages[0].passages[0].status, "skip");
  assert.equal(result.footages[0].passages[0].reason, "Repeated setup.");
  assert.deepEqual(result.timeline, ["ftg_1"]);
  assert.deepEqual(result.operationLog.at(-1), {
    type: "setPassageStatus",
    passageId: "passage_ftg_1_0001",
    status: "skip",
    reason: "Repeated setup.",
  });
});

test("writeTimelineExport renders kept passages from footages in timeline order", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-footage-timeline-"));

  try {
    const project = createPassageProject();
    project.footages[0].path = "/absolute/one_sentence.mp4";

    const timeline = await writeTimelineExport(projectDir, project);

    assert.deepEqual(timeline, {
      version: 1,
      duration: 2.36,
      segments: [
        {
          passageId: "passage_ftg_1_0001",
          footageId: "ftg_1",
          footagePath: "/absolute/one_sentence.mp4",
          start: 0.28,
          end: 2.64,
          duration: 2.36,
        },
      ],
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8")), timeline);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
});

test("startServer serves the official manuscript and footages editor shell", async () => {
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
    assert.match(html, /data-region="manuscript"/);
    assert.match(html, /data-region="footages-strip"/);
    assert.match(html, /data-region="agent-dock"/);
    assert.match(html, /No transcript yet\. Run `rough-cut-axi transcribe` and the prose will fill in\./);
    assert.doesNotMatch(html, /data-region="media-bin"/);
    assert.doesNotMatch(html, /role="tablist"/);
    assert.doesNotMatch(html, /\bclip\b/i);
    assert.doesNotMatch(html, /\bchunk\b/i);
    assert.doesNotMatch(html, /\bsource\b/i);
  } finally {
    await server.close();
  }
});
