import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectSnapshot,
  parseSnapshotRange,
  renderProjectSnapshot,
  summarizeTarget,
} from "../src/project-snapshot.js";

test("parseSnapshotRange accepts increasing numeric output ranges", () => {
  assert.deepEqual(parseSnapshotRange("1.5:3"), { start: 1.5, end: 3 });
  assert.equal(parseSnapshotRange("3:1.5"), null);
  assert.equal(parseSnapshotRange("wat:1.5"), null);
});

test("buildProjectSnapshot returns passage and nearby transcript context", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-snapshot-"));
  const projectDir = path.join(homeDir, "projects", "snapshot-project");
  const project = createProject();
  await writeTranscript(projectDir);

  try {
    const snapshot = await buildProjectSnapshot(projectDir, project, { outputRange: { start: 0, end: 2 } });

    assert.deepEqual(snapshot.passages, [
      {
        id: "passage_ftg_1_0001",
        start: 0.28,
        end: 2.64,
        speaker: "speaker_1",
        text: "Hello world, this is Rough Cut AXI.",
        status: "keep",
        reason: "Strong opening line.",
        footage: "one_sentence.mp4",
      },
    ]);
    assert.deepEqual(snapshot.nearbyTranscript, [
      {
        footage: "one_sentence.mp4",
        start: 0.1,
        end: 1.2,
        text: "Nearby transcript text.",
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("renderProjectSnapshot emits compact snapshot lines", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-snapshot-render-"));
  const projectDir = path.join(homeDir, "projects", "snapshot-project");
  const project = createProject();
  await writeTranscript(projectDir);

  try {
    const lines = await renderProjectSnapshot(projectDir, project);

    assert.match(lines.join("\n"), /^  passages\[1\]\{id,footage,start,end,status,reason,text\}:$/m);
    assert.match(
      lines.join("\n"),
      /^    passage_ftg_1_0001,one_sentence\.mp4,0\.28,2\.64,keep,Strong opening line\.,Hello world, this is Rough Cut AXI\.$/m,
    );
    assert.match(lines.join("\n"), /^  render: renders\/final\.mov$/m);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("summarizeTarget renders agent prompt target labels", () => {
  assert.equal(summarizeTarget(null), "none");
  assert.equal(summarizeTarget({ type: "time-range", start: 1, end: 2 }), "time-range 1-2");
  assert.equal(summarizeTarget({ type: "transcript-range", footageId: "ftg_1", start: 0.2, end: 1 }), "ftg_1 0.2-1");
});

async function writeTranscript(projectDir) {
  await mkdir(path.join(projectDir, "transcripts"), { recursive: true });
  await writeFile(
    path.join(projectDir, "transcripts", "one_sentence.json"),
    `${JSON.stringify(
      {
        segments: [{ start: 0.1, end: 1.2, text: "Nearby transcript text." }],
      },
      null,
      2,
    )}\n`,
  );
}

function createProject() {
  return {
    version: 1,
    title: "Project snapshot",
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence.mp4",
        transcriptPath: "transcripts/one_sentence.json",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.28,
            end: 2.64,
            speaker: "speaker_1",
            text: "Hello world, this is Rough Cut AXI.",
            status: "keep",
            reason: "Strong opening line.",
          },
        ],
      },
    ],
    timeline: ["ftg_1"],
    render: {
      finalPath: "renders/final.mov",
    },
  };
}
