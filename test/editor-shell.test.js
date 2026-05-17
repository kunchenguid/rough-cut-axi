import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderEditorShell } from "../src/editor-shell.js";

test("renderEditorShell renders the transcript-first editor shell", () => {
  const html = renderEditorShell({
    projectDir: "/tmp/project",
    title: "Extracted Shell",
    footages: [
      {
        id: "ftg_1",
        name: "one_sentence.mp4",
        label: "One sentence",
        order: 1,
        duration: 3,
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
    pendingPrompts: [],
    chatMessages: [],
    agentPresence: "waiting",
  });

  assert.match(html, /<title>Rough Cut editor<\/title>/);
  assert.match(html, /data-region="manuscript"/);
  assert.match(html, /data-region="preview"/);
  assert.match(html, /data-region="agent-dock"/);
  assert.match(html, /data-passage-id="passage_ftg_1_0001"/);
  assert.match(html, /data-action="select-passage"/);
  assert.match(html, /data-region="passage-control-bar"/);
  assert.match(html, /data-region="passage-waveform"/);
  assert.match(html, /data-region="passage-audio-player"/);
  assert.match(html, /Hello world, this is Rough Cut AXI\./);
  assert.doesNotMatch(html, /aria-label="Skip Hello world, this is Rough Cut AXI\."/);
});

test("renderEditorShell keeps pause passages inline within speaker runs", () => {
  const html = renderEditorShell({
    projectDir: "/tmp/project",
    title: "Pause Inline",
    footages: [
      {
        id: "ftg_1",
        name: "pause_inline.mp4",
        label: "Pause inline",
        order: 1,
        duration: 3,
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0,
            end: 0.5,
            speaker: "speaker_1",
            text: "Before.",
            status: "keep",
          },
          {
            id: "passage_ftg_1_0002",
            start: 0.5,
            end: 1.2,
            speaker: "pause",
            text: "[pause 0.7s]",
            status: "skip",
          },
          {
            id: "passage_ftg_1_0003",
            start: 1.2,
            end: 1.7,
            speaker: "speaker_1",
            text: "After.",
            status: "keep",
          },
        ],
      },
    ],
  });

  assert.equal(countMatches(html, /data-region="passage-line"/g), 1);
  assert.doesNotMatch(html, /<div class="passage-meta">pause</);
  assert.match(html, /Before\.[\s\S]*\[pause 0\.7s\][\s\S]*After\./);
});

test("renderEditorShell keeps a leading pause inline with the first speaker run", () => {
  const html = renderEditorShell({
    projectDir: "/tmp/project",
    title: "Leading Pause Inline",
    footages: [
      {
        id: "ftg_1",
        name: "leading_pause.mp4",
        label: "Leading pause",
        order: 1,
        duration: 3,
        passages: [
          {
            id: "passage_ftg_1_0001",
            start: 0.5,
            end: 1,
            speaker: "pause",
            text: "[pause 0.5s]",
            status: "keep",
          },
          {
            id: "passage_ftg_1_0002",
            start: 1,
            end: 1.5,
            speaker: "speaker_1",
            text: "First word.",
            status: "keep",
          },
        ],
      },
    ],
  });

  assert.equal(countMatches(html, /data-region="passage-line"/g), 1);
  assert.doesNotMatch(html, /<div class="passage-meta">pause/);
  assert.match(html, /<div class="passage-meta">speaker_1/);
  assert.match(html, /\[pause 0\.5s\][\s\S]*First word\./);
});

test("renderEditorShell inlines editor CSS and browser script assets", async () => {
  const [styles, script, estimatorScript] = await Promise.all([
    readFile(path.resolve("src/editor-shell.css"), "utf8"),
    readFile(path.resolve("src/editor-shell-client.js"), "utf8"),
    readFile(path.resolve("src/render-progress-estimator.js"), "utf8"),
  ]);
  const html = renderEditorShell();

  assert.match(styles, /\.editor-shell/);
  assert.match(styles, /\.render-copy-button/);
  assert.match(script, /initializePassageEditing/);
  assert.match(estimatorScript, /createRenderEtaEstimator/);
  assert.match(html, new RegExp(escapeRegex(styles.trim().slice(0, 80))));
  assert.match(html, /createRenderEtaEstimator/);
  assert.match(html, /initializePassageEditing/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(value, regex) {
  return (value.match(regex) || []).length;
}
