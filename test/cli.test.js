import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { createProject } from "../src/project-store.js";

const execFileAsync = promisify(execFile);

test("rough-cut-axi with no arguments shows content-first project state", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-home-empty-"));

  try {
    const { stdout, stderr } = await runCli([], { HOME: homeDir, ROUGH_CUT_AXI_HOME: "" });

    assert.equal(stderr, "");
    assert.match(stdout, /^bin: .+rough-cut-axi/m);
    assert.match(stdout, /^description: Local-first transcript-based video editor for agent-assisted rough cuts$/m);
    assert.match(stdout, /^projects: 0 projects found$/m);
    assert.match(stdout, /Run `rough-cut-axi open <video-file\.\.\.>` to create a project/);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi reports usage errors on stdout", async () => {
  await assert.rejects(runCli(["wat"], { ROUGH_CUT_AXI_HOME: "" }), (error) => {
    assert.equal(error.stderr, "");
    assert.equal(error.code, 2);
    assert.match(error.stdout, /^error: unknown command: wat$/m);
    assert.match(error.stdout, /^help: Run `rough-cut-axi --help` to see available commands$/m);
    return true;
  });
});

test("rough-cut-axi auth elevenlabs stores an API key", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-auth-"));

  try {
    const { stdout, stderr } = await runCli(["auth", "elevenlabs", "--api-key", "cli-test-key"], {
      ROUGH_CUT_AXI_HOME: homeDir,
    });

    assert.equal(stderr, "");
    assert.match(stdout, /^auth: elevenlabs$/m);
    assert.match(stdout, /^status: stored$/m);
    assert.deepEqual(JSON.parse(await readFile(path.join(homeDir, "auth.json"), "utf8")), {
      elevenlabsApiKey: "cli-test-key",
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi open --json returns footage project metadata", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-open-json-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-footage-"));

  try {
    const footagePath = path.join(footageDir, "one_sentence.mp4");
    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);

    const { stdout, stderr } = await runCli(["open", footagePath, "--json"], {
      ELEVENLABS_API_KEY: "test-key",
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1",
      ROUGH_CUT_AXI_TEST_PROJECT_ID: "20260514-120000-one-sentence",
    });

    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      project: "20260514-120000-one-sentence",
      title: "One Sentence",
      path: path.join(homeDir, "projects", "20260514-120000-one-sentence"),
      footages: 1,
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi transcribe writes fixture transcripts and project passages", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-transcribe-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-footage-"));

  try {
    const footagePath = path.join(footageDir, "one_sentence.mp4");
    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "20260514-120000-one-sentence",
    };
    const project = await createProject({ config, footagePaths: [footagePath] });
    const projectPath = path.join(project.projectDir, "project.json");
    const projectBeforeTranscribe = JSON.parse(await readFile(projectPath, "utf8"));
    projectBeforeTranscribe.render.finalPath = "renders/final.mov";
    await writeFile(projectPath, `${JSON.stringify(projectBeforeTranscribe, null, 2)}\n`);

    const { stdout, stderr } = await runCli(["transcribe", project.projectDir], {
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR: path.resolve("test/fixtures/transcripts"),
    });

    assert.equal(stderr, "");
    assert.match(stdout, /^transcription: completed$/m);
    assert.match(stdout, /^transcripts: 1 written$/m);
    const projectJson = JSON.parse(await readFile(path.join(project.projectDir, "project.json"), "utf8"));
    assert.equal(projectJson.transcription.completedFootages, 1);
    assert.deepEqual(projectJson.render, { finalPath: "renders/final.mov" });
    assert.equal(projectJson.footages[0].passages[0].id, "passage_ftg_1_0001");
    assert.equal(projectJson.footages[0].passages[0].status, "keep");
    const transcriptJson = JSON.parse(
      await readFile(path.join(project.projectDir, projectJson.footages[0].transcriptPath), "utf8"),
    );
    assert.deepEqual(transcriptJson.audioSilenceSettings, { noiseDb: -45, minSeconds: 0.1 });
    const timelineJson = JSON.parse(await readFile(path.join(project.projectDir, "timeline.json"), "utf8"));
    assert.equal(timelineJson.segments[0].passageId, "passage_ftg_1_0001");
    assert.equal(timelineJson.segments[0].footageId, "ftg_1");
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi poll returns queued prompts and passage snapshots", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-poll-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-one-sentence");
  await writeProject(
    projectDir,
    createProjectJson({
      chat: {
        pendingPrompts: [
          {
            uid: "prompt_1",
            tag: "passage",
            prompt: "Tighten the opener.",
            target: { type: "passage", passageId: "passage_ftg_1_0001" },
          },
        ],
        messages: [],
        agentPresence: "waiting",
      },
    }),
  );

  try {
    const { stdout, stderr } = await runCli(["poll", projectDir, "--timeout-ms", "0"], {
      ROUGH_CUT_AXI_HOME: homeDir,
    });

    assert.equal(stderr, "");
    assert.match(stdout, /^presence: working$/m);
    assert.match(stdout, /^pending_prompts\[1\]\{uid,tag,prompt,target\}:$/m);
    assert.match(stdout, /^  passages\[1\]\{id,footage,start,end,status,reason,text\}:$/m);
    assert.match(
      stdout,
      /^    passage_ftg_1_0001,one_sentence\.mp4,0\.28,2\.64,keep,Strong opening line\.,Hello world, this is Rough Cut AXI\.$/m,
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi snapshot --json returns raw passage snapshot data", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-snapshot-json-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-one-sentence");
  await writeProject(projectDir, createProjectJson({}));

  try {
    const { stdout, stderr } = await runCli(["snapshot", projectDir, "--json"], {
      ROUGH_CUT_AXI_HOME: homeDir,
    });

    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      project: "20260514-120000-one-sentence",
      snapshot: {
        passages: [
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
        ],
        nearbyTranscript: [],
        render: {
          finalPath: "renders/final.mov",
        },
      },
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi apply applies passage edit operations through the reducer", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-apply-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-one-sentence");
  const opsPath = path.join(homeDir, "ops.json");
  await writeProject(projectDir, createProjectJson({}));
  await writeFile(
    opsPath,
    `${JSON.stringify([
      {
        type: "setPassageStatus",
        passageId: "passage_ftg_1_0001",
        status: "skip",
        reason: "Repeated setup.",
      },
    ])}\n`,
  );

  try {
    const { stdout, stderr } = await runCli(["apply", projectDir, "--ops", opsPath], {
      ROUGH_CUT_AXI_HOME: homeDir,
    });

    assert.equal(stderr, "");
    assert.match(stdout, /^applied_operations: 1$/m);
    assert.match(stdout, /^timeline_footages: 1$/m);
    assert.match(stdout, /^final: renders\/final\.mov$/m);
    const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
    assert.equal(project.footages[0].passages[0].status, "skip");
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, "timeline.json"), "utf8")).segments, []);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi render writes a single-pass editing-friendly final", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-render-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-render");
  const ffmpegLog = path.join(homeDir, "ffmpeg.log");
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, "timeline.json"),
    `${JSON.stringify(
      {
        version: 1,
        duration: 3,
        segments: [
          {
            passageId: "passage_ftg_1_0001",
            footageId: "ftg_1",
            footagePath: "/tmp/one_sentence.mp4",
            start: 0.28,
            end: 2.64,
            duration: 2.36,
          },
          {
            passageId: "passage_ftg_1_0002",
            footageId: "ftg_1",
            footagePath: "/tmp/one_sentence.mp4",
            start: 4,
            end: 4.64,
            duration: 0.64,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeMockRenderBins({ ffmpegBin, ffprobeBin, ffmpegLog, duration: 3 });

  try {
    const { stdout, stderr } = await runCli(["render", projectDir, "--json"], {
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_FFMPEG_BIN: ffmpegBin,
      ROUGH_CUT_AXI_FFPROBE_BIN: ffprobeBin,
    });

    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      project: "20260514-120000-render",
      render: "final",
      output: path.join(projectDir, "renders", "final.mov"),
      segments: 2,
      expectedDuration: 3,
      actualDuration: 3,
      durationDelta: 0,
      durationOk: true,
    });
    const [finalInvocation] = (await readFile(ffmpegLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(finalInvocation.filter((arg) => arg === "-i").length, 1);
    const filterGraph = finalInvocation[finalInvocation.indexOf("-filter_complex") + 1];
    assert.match(filterGraph, /\[0:v\]trim=start=0\.28:end=2\.64,setpts=PTS-STARTPTS\[v0\]/);
    assert.match(filterGraph, /\[0:a\]atrim=start=0\.28:end=2\.64,asetpts=PTS-STARTPTS\[a0\]/);
    assert.match(filterGraph, /\[0:v\]trim=start=4:end=4\.64,setpts=PTS-STARTPTS\[v1\]/);
    assert.match(filterGraph, /\[0:a\]atrim=start=4:end=4\.64,asetpts=PTS-STARTPTS\[a1\]/);
    assert.match(filterGraph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[concatv\]\[outa\]/);
    assert.match(filterGraph, /\[concatv\]fps=30,setpts=PTS-STARTPTS\[outv\]/);
    assert.equal(finalInvocation[finalInvocation.indexOf("-map") + 1], "[outv]");
    assert.equal(finalInvocation[finalInvocation.lastIndexOf("-map") + 1], "[outa]");
    assert.equal(finalInvocation.includes("copy"), false);
    assert.equal(finalInvocation.includes("libx264"), false);
    assert.equal(finalInvocation.includes("aac"), false);
    assert.equal(finalInvocation[finalInvocation.indexOf("-fps_mode") + 1], "cfr");
    assert.equal(finalInvocation[finalInvocation.indexOf("-r") + 1], "30");
    assert.equal(finalInvocation[finalInvocation.indexOf("-c:v") + 1], "prores_ks");
    assert.equal(finalInvocation[finalInvocation.indexOf("-profile:v") + 1], "3");
    assert.equal(finalInvocation[finalInvocation.indexOf("-pix_fmt") + 1], "yuv422p10le");
    assert.equal(finalInvocation[finalInvocation.indexOf("-c:a") + 1], "pcm_s16le");
    assert.equal(finalInvocation[finalInvocation.indexOf("-ar") + 1], "48000");
    assert.equal(finalInvocation.at(-1), path.join(projectDir, "renders", "final.mov"));
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("rough-cut-axi render uses persisted user render settings", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-cli-render-settings-"));
  const projectDir = path.join(homeDir, "projects", "20260514-120000-render-settings");
  const ffmpegLog = path.join(homeDir, "ffmpeg.log");
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(homeDir, "render-settings.json"),
    `${JSON.stringify({ version: 1, final: { frameRate: 24, codec: "h264" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(projectDir, "timeline.json"),
    `${JSON.stringify(
      {
        version: 1,
        duration: 1,
        segments: [
          {
            passageId: "passage_ftg_1_0001",
            footageId: "ftg_1",
            footagePath: "/tmp/one_sentence.mp4",
            start: 0,
            end: 1,
            duration: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeMockRenderBins({
    ffmpegBin,
    ffprobeBin,
    ffmpegLog,
    duration: 1,
    encoders: " V..... libx264              H.264\n V..... prores_ks            Apple ProRes\n",
  });

  try {
    const { stdout, stderr } = await runCli(["render", projectDir, "--json"], {
      ROUGH_CUT_AXI_HOME: homeDir,
      ROUGH_CUT_AXI_FFMPEG_BIN: ffmpegBin,
      ROUGH_CUT_AXI_FFPROBE_BIN: ffprobeBin,
    });

    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).output, path.join(projectDir, "renders", "final.mp4"));
    const [finalInvocation] = (await readFile(ffmpegLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.match(finalInvocation[finalInvocation.indexOf("-filter_complex") + 1], /fps=24,setpts=PTS-STARTPTS\[outv\]/);
    assert.equal(finalInvocation[finalInvocation.indexOf("-r") + 1], "24");
    assert.equal(finalInvocation[finalInvocation.indexOf("-c:v") + 1], "libx264");
    assert.equal(finalInvocation[finalInvocation.indexOf("-crf") + 1], "16");
    assert.equal(finalInvocation[finalInvocation.indexOf("-c:a") + 1], "aac");
    assert.equal(finalInvocation[finalInvocation.indexOf("-b:a") + 1], "320k");
    assert.equal(finalInvocation.at(-1), path.join(projectDir, "renders", "final.mp4"));
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

async function runCli(args, env = {}) {
  return await execFileAsync(process.execPath, ["bin/rough-cut-axi.js", ...args], {
    env: { ...process.env, ...env },
  });
}

function createProjectJson({ chat } = {}) {
  return {
    version: 1,
    title: "One Sentence",
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
            reason: "Strong opening line.",
          },
        ],
      },
    ],
    timeline: ["ftg_1"],
    chat: chat || {
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
  await mkdir(path.join(projectDir, "transcripts"), { recursive: true });
  await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
}

async function writeMockRenderBins({ ffmpegBin, ffprobeBin, ffmpegLog, duration, encoders = "" }) {
  await writeFile(
    ffmpegBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  process.stdout.write(${JSON.stringify(encoders || " V..... prores_ks            Apple ProRes\n")});
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(ffmpegLog)}, JSON.stringify(args) + "\\n");
fs.mkdirSync(require("node:path").dirname(args.at(-1)), { recursive: true });
fs.writeFileSync(args.at(-1), "mp4");
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
