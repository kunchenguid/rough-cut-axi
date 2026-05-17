import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEditOperation } from "../src/edit-operations.js";
import { createInitialProject } from "../src/project-schema.js";

function createProject() {
  return createInitialProject({
    title: "Editing test",
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
            end: 1.2,
            speaker: "speaker_1",
            text: "First take.",
            status: "keep",
            reason: "Default keep.",
          },
          {
            id: "passage_ftg_1_0002",
            start: 1.4,
            end: 2.64,
            speaker: "speaker_1",
            text: "Second take.",
            status: "keep",
            reason: "Default keep.",
          },
        ],
      },
      {
        id: "ftg_2",
        name: "two_takes.mp4",
        label: "Two takes",
        path: "/tmp/two_takes.mp4",
        duration: 6,
        transcriptPath: "transcripts/two_takes.json",
        footageFingerprint: "size:2:mtimeMs:2",
        passages: [
          {
            id: "passage_ftg_2_0001",
            start: 0.1,
            end: 0.6,
            speaker: "speaker_1",
            text: "Another take.",
            status: "keep",
            reason: "Default keep.",
          },
        ],
      },
    ],
  });
}

test("setPassageStatus updates passages without changing footage order", () => {
  const project = createProject();

  const result = applyEditOperation(project, {
    type: "setPassageStatus",
    passageId: "passage_ftg_1_0001",
    status: "skip",
    reason: "Repeated setup.",
  });

  assert.deepEqual(
    result.footages[0].passages.map(({ id, status, reason }) => ({ id, status, reason })),
    [
      { id: "passage_ftg_1_0001", status: "skip", reason: "Repeated setup." },
      { id: "passage_ftg_1_0002", status: "keep", reason: "Default keep." },
    ],
  );
  assert.deepEqual(result.timeline, ["ftg_1", "ftg_2"]);
  assert.deepEqual(result.render, { finalPath: "renders/final.mov" });
  assert.deepEqual(result.operationLog.at(-1), {
    type: "setPassageStatus",
    passageId: "passage_ftg_1_0001",
    status: "skip",
    reason: "Repeated setup.",
  });
  assert.equal(project.footages[0].passages[0].status, "keep");
});

test("trimPassage snaps to word boundaries and preserves passage identity", () => {
  const project = createProject();

  const result = applyEditOperation(project, {
    type: "trimPassage",
    passageId: "passage_ftg_1_0001",
    start: 0.31,
    end: 1.09,
    wordBoundaryTimes: [0.28, 0.4, 1.1, 1.2],
  });

  assert.deepEqual(result.footages[0].passages[0], {
    id: "passage_ftg_1_0001",
    start: 0.28,
    end: 1.1,
    speaker: "speaker_1",
    text: "First take.",
    status: "keep",
    reason: "Default keep.",
  });
  assert.deepEqual(result.operationLog.at(-1), {
    type: "trimPassage",
    passageId: "passage_ftg_1_0001",
    start: 0.28,
    end: 1.1,
  });
});

test("splitPassage inserts a new passage with lead-in before the split", () => {
  const result = applyEditOperation(createProject(), {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 2,
  });

  assert.deepEqual(
    result.footages[0].passages.map(({ id, start, end, status }) => ({ id, start, end, status })),
    [
      { id: "passage_ftg_1_0001", start: 0.28, end: 1.2, status: "keep" },
      { id: "passage_ftg_1_0002", start: 1.4, end: 1.92, status: "keep" },
      { id: "passage_0003", start: 1.92, end: 2.64, status: "keep" },
    ],
  );
});

test("splitPassage reduces split lead-in near the original passage start", () => {
  const result = applyEditOperation(createProject(), {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 1.5,
  });

  assert.deepEqual(
    result.footages[0].passages.slice(1).map(({ start, end }) => ({ start, end })),
    [
      { start: 1.4, end: 1.45 },
      { start: 1.45, end: 2.64 },
    ],
  );
});

test("splitPassage preserves skipped status when splitting a skipped passage", () => {
  const project = createProject();
  project.footages[0].passages[1].status = "skip";

  const result = applyEditOperation(project, {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 2,
  });

  assert.deepEqual(
    result.footages[0].passages.map(({ id, start, end, status }) => ({ id, start, end, status })),
    [
      { id: "passage_ftg_1_0001", start: 0.28, end: 1.2, status: "keep" },
      { id: "passage_ftg_1_0002", start: 1.4, end: 1.92, status: "skip" },
      { id: "passage_0003", start: 1.92, end: 2.64, status: "skip" },
    ],
  );
});

test("splitPassage partitions passage text from transcript words", () => {
  const project = createProject();
  project.footages[0].passages[1].text = "Second take continues here.";

  const result = applyEditOperation(project, {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 2,
    transcriptWords: [
      { text: "Second", start: 1.4, end: 1.7 },
      { text: "take", start: 1.7, end: 2 },
      { text: "continues", start: 2, end: 2.3 },
      { text: "here.", start: 2.3, end: 2.64 },
    ],
  });

  assert.deepEqual(
    result.footages[0].passages.slice(1).map(({ text, start, end }) => ({ text, start, end })),
    [
      { text: "Second take", start: 1.4, end: 1.92 },
      { text: "continues here.", start: 1.92, end: 2.64 },
    ],
  );
  assert.deepEqual(result.operationLog.at(-1), {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 2,
  });
});

test("splitPassage assigns words crossing the split by midpoint", () => {
  const project = createProject();
  project.footages[0].passages[1].text = "Second take continues here.";

  const result = applyEditOperation(project, {
    type: "splitPassage",
    passageId: "passage_ftg_1_0002",
    at: 2,
    transcriptWords: [
      { text: "Second", start: 1.4, end: 1.7 },
      { text: "take", start: 1.7, end: 2.3 },
      { text: "continues", start: 2.3, end: 2.5 },
      { text: "here.", start: 2.5, end: 2.64 },
    ],
  });

  assert.deepEqual(
    result.footages[0].passages.slice(1).map(({ text }) => text),
    ["Second take", "continues here."],
  );
});

test("reorderFootages changes only the footage timeline", () => {
  const result = applyEditOperation(createProject(), {
    type: "reorderFootages",
    footageIds: ["ftg_2", "ftg_1"],
  });

  assert.deepEqual(result.timeline, ["ftg_2", "ftg_1"]);
  assert.equal(result.footages[0].id, "ftg_1");
});

test("passage operations reject malformed input without mutating project state", () => {
  const project = createProject();

  assert.throws(
    () => applyEditOperation(project, { type: "setPassageStatus", passageId: "missing", status: "skip" }),
    /Unknown passage: missing/,
  );
  assert.throws(
    () => applyEditOperation(project, { type: "setPassageStatus", passageId: "passage_ftg_1_0001", status: "cut" }),
    /passage status must be keep, skip, or active/,
  );
  assert.throws(
    () => applyEditOperation(project, { type: "trimPassage", passageId: "passage_ftg_1_0001", start: 2, end: 1 }),
    /passage start must be before end/,
  );
  assert.throws(
    () => applyEditOperation(project, { type: "splitPassage", passageId: "passage_ftg_1_0001", at: 0.28 }),
    /split point must be inside the passage range/,
  );
  assert.deepEqual(project.operationLog, []);
});

test("edit operations reject malformed operation objects", () => {
  const project = createProject();

  assert.throws(() => applyEditOperation(project, null), /Edit operation must be an object with a type/);
  assert.throws(() => applyEditOperation(project, { type: " trimPassage" }), /Edit operation type must be trimmed/);
  assert.throws(() => applyEditOperation(project, { type: "deleteRange" }), /Unsupported edit operation: deleteRange/);
});
