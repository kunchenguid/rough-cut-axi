import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderTimeline } from "../src/rendering.js";

test("renderTimeline reports estimated progress from ffmpeg progress output", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-render-progress-"));
  const projectDir = path.join(homeDir, "projects", "20260517-120000-render-progress");
  const ffmpegLog = path.join(homeDir, "ffmpeg.log");
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");
  const progressEvents = [];

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "timeline.json"),
      `${JSON.stringify(
        {
          version: 1,
          duration: 4,
          segments: [
            {
              passageId: "passage_ftg_1_0001",
              footageId: "ftg_1",
              footagePath: "/tmp/one_sentence.mp4",
              start: 0,
              end: 4,
              duration: 4,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeProgressRenderBins({ ffmpegBin, ffprobeBin, ffmpegLog, duration: 4 });

    await renderTimeline({
      config: { homeDir, ffmpegBin, ffprobeBin },
      projectDir,
      onProgress: (progress) => progressEvents.push(progress),
    });

    assert.deepEqual(
      progressEvents.map((event) => ({
        outTime: event.outTime,
        expectedDuration: event.expectedDuration,
        percent: Number(event.percent.toFixed(2)),
      })),
      [
        { outTime: 1, expectedDuration: 4, percent: 0.25 },
        { outTime: 2, expectedDuration: 4, percent: 0.5 },
        { outTime: 4, expectedDuration: 4, percent: 1 },
      ],
    );
    const [finalInvocation] = (await readFile(ffmpegLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(finalInvocation[finalInvocation.indexOf("-progress") + 1], "pipe:1");
    assert.equal(finalInvocation.includes("-nostats"), true);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

async function writeProgressRenderBins({ ffmpegBin, ffprobeBin, ffmpegLog, duration }) {
  await writeFile(
    ffmpegBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  process.stdout.write(${JSON.stringify(" V..... prores_ks            Apple ProRes\n")});
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(ffmpegLog)}, JSON.stringify(args) + ${JSON.stringify("\n")});
process.stdout.write(${JSON.stringify("out_time_ms=1000000\nprogress=continue\nout_time_ms=2000000\nprogress=continue\nout_time_ms=4000000\nprogress=end\n")});
fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true });
fs.writeFileSync(args.at(-1), "mov");
`,
  );
  await writeFile(
    ffprobeBin,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(String(duration))});
`,
  );
  await chmod(ffmpegBin, 0o755);
  await chmod(ffprobeBin, 0o755);
}
