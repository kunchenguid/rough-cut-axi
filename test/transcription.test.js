import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  buildPackedTranscript,
  buildTranscriptPassages,
  normalizeElevenLabsTranscript,
  repairGluedSentenceWordTimings,
} from "../src/transcription.js";

const execFileAsync = promisify(execFile);

test("normalizeElevenLabsTranscript groups word timestamps into edit phrases", () => {
  const transcript = normalizeElevenLabsTranscript({
    footage: { path: "/video/part1.mp4" },
    response: {
      language_code: "eng",
      language_probability: 0.98,
      text: "First sentence ends here. Second thought is long enough to split at a comfortable boundary before it becomes a wall of text. Speaker two answers.",
      words: [
        word("First", 0, 0.2),
        word("sentence", 0.3, 0.6),
        word("ends", 0.7, 0.9),
        word("here.", 1, 1.2),
        word("Second", 2.1, 2.4),
        word("thought", 2.5, 2.8),
        word("is", 2.9, 3),
        word("long", 3.1, 3.4),
        word("enough", 3.5, 3.8),
        word("to", 3.9, 4),
        word("split", 4.1, 4.4),
        word("at", 4.5, 4.6),
        word("a", 4.7, 4.8),
        word("comfortable", 4.9, 5.5),
        word("boundary", 5.6, 6),
        word("before", 6.1, 6.4),
        word("it", 6.5, 6.6),
        word("becomes", 6.7, 7.1),
        word("a", 7.2, 7.3),
        word("wall", 7.4, 7.7),
        word("of", 7.8, 7.9),
        word("text.", 8, 8.4),
        word("Speaker", 8.8, 9.1, "speaker_2"),
        word("two", 9.2, 9.4, "speaker_2"),
        word("answers.", 9.5, 9.8, "speaker_2"),
      ],
    },
  });

  assert.deepEqual(
    transcript.segments.map((segment) => segment.text),
    [
      "First sentence ends here.",
      "Second thought is long enough to split at a comfortable boundary before it becomes a wall of text.",
      "Speaker two answers.",
    ],
  );
  assert.deepEqual(
    transcript.segments.map((segment) => [segment.start, segment.end, segment.speaker]),
    [
      [0, 1.2, "speaker_1"],
      [2.1, 8.4, "speaker_1"],
      [8.8, 9.8, "speaker_2"],
    ],
  );
});

test("buildPackedTranscript renders a passage reading artifact", () => {
  const packed = buildPackedTranscript([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [
          { text: "First", start: 0, end: 0.2, speaker: "speaker_0", type: "word" },
          { text: "take.", start: 0.24, end: 0.6, speaker: "speaker_0", type: "word" },
          { text: "Second", start: 1.2, end: 1.5, speaker: "speaker_0", type: "word" },
          { text: "speaker.", start: 1.54, end: 1.9, speaker: "speaker_1", type: "word" },
        ],
      },
    },
  ]);

  assert.equal(
    packed,
    [
      "# Packed transcripts",
      "",
      "Passage-level, grouped on silences >= 0.5s or speaker change.",
      "Use [start-end] ranges to address passages; snap final edits to word boundaries.",
      "",
      "## ftg_1: part1.mp4 (4 passages)",
      "",
      "- [0.00-0.68] S0: First take.",
      "- [0.68-1.12] pause: [pause 0.4s]",
      "- [1.12-1.54] S0: Second",
      "- [1.54-1.98] S1: speaker.",
      "",
    ].join("\n"),
  );
});

test("buildPackedTranscript uses passage sentence boundaries", () => {
  const packed = buildPackedTranscript([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: timedWords("First sentence. Second sentence."),
      },
    },
  ]);

  assert.match(packed, /## ftg_1: part1\.mp4 \(2 passages\)/);
  assert.match(packed, /- \[0\.00-0\.62\] S1: First sentence\./);
  assert.match(packed, /- \[0\.62-1\.26\] S1: Second sentence\./);
});

test("repairGluedSentenceWordTimings uses waveform silence to split long glued tokens", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-glued-word-"));
  const audioPath = path.join(tempDir, "glued-word.wav");

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.4",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=48000:duration=1.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=0.3",
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      "-ac",
      "1",
      "-ar",
      "48000",
      audioPath,
    ]);

    const result = await repairGluedSentenceWordTimings({
      audioPath,
      ffmpegBin: "ffmpeg",
      words: [{ ...word("products.So", 0, 2.5), end: 2.5 }],
    });

    assert.equal(result.repaired, true);
    assert.deepEqual(
      result.words.map((repairedWord) => repairedWord.text),
      ["products.", "So"],
    );
    assert.ok(Math.abs(result.words[0].end - 0.4) < 0.08, `expected first word to end near 0.4s`);
    assert.ok(Math.abs(result.words[1].start - 2.2) < 0.08, `expected second word to start near 2.2s`);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("repairGluedSentenceWordTimings repairs lowercase glued sentence tokens", async () => {
  const result = await repairGluedSentenceWordTimings({
    audioSilences: [{ start: 0.6, end: 1.6 }],
    words: [{ ...word("others.and", 0, 2.4), end: 2.4 }],
  });

  assert.equal(result.repaired, true);
  assert.deepEqual(
    result.words.map((repairedWord) => [repairedWord.text, repairedWord.start, repairedWord.end]),
    [
      ["others.", 0, 0.6],
      ["and", 1.6, 2.4],
    ],
  );
});

test("repairGluedSentenceWordTimings uses conservative silence detection sensitivity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-silence-args-"));
  const ffmpegBin = path.join(tempDir, "ffmpeg.js");
  const argsPath = path.join(tempDir, "args.json");

  try {
    await writeFile(
      ffmpegBin,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n"),
    );
    await chmod(ffmpegBin, 0o755);

    await repairGluedSentenceWordTimings({
      audioPath: path.join(tempDir, "source.wav"),
      ffmpegBin,
      words: [{ ...word("products.So", 0, 2.5), end: 2.5 }],
    });

    const ffmpegArgs = JSON.parse(await readFile(argsPath, "utf8"));
    assert.ok(ffmpegArgs.includes("silencedetect=noise=-45dB:d=0.1"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("buildTranscriptPassages splits fluent repeated sentences into passages", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: timedWords(
          "I got to know a lot of great people over there as well. I got to know a lot of great people over there as well.",
        ),
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => passage.text),
    [
      "I got to know a lot of great people over there as well.",
      "I got to know a lot of great people over there as well.",
    ],
  );
});

test("buildTranscriptPassages splits lowercase glued sentence tokens at periods", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [
          word("share", 0, 0.2),
          word("with", 0.24, 0.44),
          word("others.and", 0.48, 1.08),
          word("share", 1.12, 1.32),
          word("again.", 1.36, 1.6),
        ],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => passage.text),
    ["share with others.", "and share again."],
  );
});

test("buildTranscriptPassages adds a small lead-in before passage starts", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [word("First", 0.3, 0.5), word("word.", 0.54, 0.8)],
      },
    },
  ]).get("ftg_1");

  assert.equal(passages[0].start, 0.22);
});

test("buildTranscriptPassages adds a small tail after passage ends", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [word("First", 0.3, 0.5), word("word.", 0.54, 0.8)],
      },
    },
  ]).get("ftg_1");

  assert.equal(passages[0].end, 0.88);
});

test("buildTranscriptPassages keeps a leading 0.5s pause before the first word", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [word("First", 1, 1.2), word("word.", 1.24, 1.5)],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.start, passage.end, passage.speaker, passage.text, passage.status]),
    [
      [0.5, 1, "pause", "[pause 0.5s]", "keep"],
      [1, 1.58, "speaker_1", "First word.", "keep"],
    ],
  );
});

test("buildTranscriptPassages keeps a new leading pause when the first existing passage is kept", () => {
  const passages = buildTranscriptPassages(
    [
      {
        footage: { id: "ftg_1", name: "part1.mp4" },
        transcript: {
          words: [word("First", 1, 1.2), word("word.", 1.24, 1.5)],
        },
      },
    ],
    [
      {
        id: "ftg_1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.92,
            end: 1.5,
            text: "First word.",
            status: "keep",
            reason: "Already selected opener.",
          },
        ],
      },
    ],
  ).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.text, passage.status, passage.reason]),
    [
      ["[pause 0.5s]", "keep", "Kept as first-word lead-in."],
      ["First word.", "keep", "Already selected opener."],
    ],
  );
});

test("buildTranscriptPassages splits audio events into standalone passages", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [
          word("Before", 0, 0.2),
          { text: "[clears throat]", start: 0.22, end: 0.7, speaker: "speaker_1", type: "audio_event" },
          word("after.", 0.72, 1),
        ],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => passage.text),
    ["Before", "[clears throat]", "after."],
  );
});

test("buildTranscriptPassages keeps long fluent speech together without a word cap", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: timedWords(
          "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen",
        ),
      },
    },
  ]).get("ftg_1");

  assert.equal(passages.length, 1);
});

test("buildTranscriptPassages creates explicit pause passages for silence gaps", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [word("Before.", 0.3, 0.5), word("After.", 1.3, 1.5)],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.start, passage.end, passage.speaker, passage.text]),
    [
      [0.22, 0.58, "speaker_1", "Before."],
      [0.58, 1.22, "pause", "[pause 0.6s]"],
      [1.22, 1.58, "speaker_1", "After."],
    ],
  );
});

test("buildTranscriptPassages trims trailing silence into the following pause", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        audioSilences: [{ start: 0.72, end: 2 }],
        words: [word("Before.", 0.3, 1.2), word("After.", 2, 2.3)],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.start, passage.end, passage.speaker, passage.text]),
    [
      [0.22, 0.8, "speaker_1", "Before."],
      [0.8, 1.92, "pause", "[pause 1.1s]"],
      [1.92, 2.38, "speaker_1", "After."],
    ],
  );
});

test("buildTranscriptPassages trims leading silence while preserving front padding", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        audioSilences: [{ start: 1, end: 1.3 }],
        words: [word("Before.", 0.3, 0.5), word("After.", 1, 1.8)],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.start, passage.end, passage.speaker, passage.text]),
    [
      [0.22, 0.58, "speaker_1", "Before."],
      [0.58, 1.22, "pause", "[pause 0.6s]"],
      [1.22, 1.88, "speaker_1", "After."],
    ],
  );
});

test("buildTranscriptPassages keeps speech selected when silence repair no longer trims before an old pause", () => {
  const passages = buildTranscriptPassages(
    [
      {
        footage: { id: "ftg_1", name: "part1.mp4" },
        transcript: {
          words: [word("Before.", 0.3, 1.2), word("After.", 2, 2.3)],
        },
      },
    ],
    [
      {
        id: "ftg_1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.22,
            end: 0.8,
            speaker: "speaker_1",
            text: "Before.",
            status: "keep",
            reason: "Selected speech.",
          },
          {
            id: "passage_ftg_1_0002",
            start: 0.8,
            end: 1.92,
            speaker: "pause",
            text: "[pause 1.1s]",
            status: "skip",
            reason: "Skipped because it is outside the existing cut.",
          },
        ],
      },
    ],
  ).get("ftg_1");

  assert.equal(passages[0].status, "keep");
  assert.equal(passages[0].reason, "Selected speech.");
});

test("buildTranscriptPassages preserves skipped ranges when regenerating finer passages", () => {
  const passages = buildTranscriptPassages(
    [
      {
        footage: { id: "ftg_1", name: "part1.mp4" },
        transcript: {
          words: timedWords("Keep this sentence. Skip this repeated sentence. Skip this repeated sentence."),
        },
      },
    ],
    [
      {
        id: "ftg_1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0,
            end: 0.86,
            text: "Keep this sentence.",
            status: "keep",
            reason: "Already selected cut.",
          },
          {
            id: "passage_ftg_1_0002",
            start: 0.96,
            end: 3.42,
            text: "Skip this repeated sentence. Skip this repeated sentence.",
            status: "skip",
            reason: "User removed repeated sentence.",
          },
        ],
      },
    ],
  ).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => passage.status),
    ["keep", "skip", "skip"],
  );
  assert.deepEqual(
    passages.map((passage) => passage.reason),
    ["Already selected cut.", "User removed repeated sentence.", "User removed repeated sentence."],
  );
});

test("buildTranscriptPassages preserves selected ranges when merged passages span old chunks", () => {
  const passages = buildTranscriptPassages(
    [
      {
        footage: { id: "ftg_1", name: "part1.mp4" },
        transcript: {
          words: timedWords(
            "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen",
          ),
        },
      },
    ],
    [
      {
        id: "ftg_1",
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0,
            end: 4.38,
            text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
            status: "keep",
            reason: "Already selected cut.",
          },
          {
            id: "passage_ftg_1_0002",
            start: 4.48,
            end: 5.66,
            text: "fifteen sixteen seventeen eighteen",
            status: "keep",
            reason: "Already selected cut.",
          },
        ],
      },
    ],
  ).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.status, passage.reason]),
    [["keep", "Already selected cut."]],
  );
});

test("buildTranscriptPassages ignores zero-duration transcript tokens", () => {
  const passages = buildTranscriptPassages([
    {
      footage: { id: "ftg_1", name: "part1.mp4" },
      transcript: {
        words: [
          { text: "(noise)", start: 12.34, end: 12.34, speaker: "speaker_1", type: "audio_event" },
          { text: "Usable", start: 13, end: 13.3, speaker: "speaker_1", type: "word" },
          { text: "speech.", start: 13.34, end: 13.7, speaker: "speaker_1", type: "word" },
        ],
      },
    },
  ]).get("ftg_1");

  assert.deepEqual(
    passages.map((passage) => [passage.start, passage.end, passage.text]),
    [
      [12.5, 13, "[pause 0.5s]"],
      [13, 13.78, "Usable speech."],
    ],
  );
});

function word(text, start, end, speakerId = "speaker_1") {
  return { text, start, end, speaker_id: speakerId, type: "word", logprob: 0 };
}

function timedWords(text) {
  return text.split(" ").map((token, index) => word(token, index * 0.32, index * 0.32 + 0.22));
}
