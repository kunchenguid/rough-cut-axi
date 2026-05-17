import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createProject, listProjects, writeTimelineExport } from "../src/project-store.js";

test("createProject writes a discoverable project without touching footage files", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-projects-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-footages-"));

  try {
    const footagePath = path.join(footageDir, "one_sentence.mp4");
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "20260514-120000-one-sentence",
    };

    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);
    const project = await createProject({ config, footagePaths: [footagePath] });
    const projectJson = JSON.parse(await readFile(path.join(project.projectDir, "project.json"), "utf8"));

    assert.equal(project.id, "20260514-120000-one-sentence");
    assert.equal(project.title, "One Sentence");
    assert.equal(project.projectDir, path.join(config.projectsDir, "20260514-120000-one-sentence"));
    assert.equal(projectJson.footages.length, 1);
    assert.equal(projectJson.footages[0].id, "ftg_1");
    assert.equal(projectJson.footages[0].name, "one_sentence.mp4");
    assert.equal(projectJson.footages[0].label, "One Sentence");
    assert.equal(projectJson.footages[0].path, footagePath);
    assert.equal(projectJson.footages[0].transcriptPath, "transcripts/one_sentence.json");
    assert.match(projectJson.footages[0].footageFingerprint, /^size:\d+:mtimeMs:\d+(?:\.\d+)?$/);
    assert.deepEqual(projectJson.timeline, ["ftg_1"]);
    assert.equal(await readFile(path.join(project.projectDir, "project.md"), "utf8"), "# One Sentence\n");

    assert.deepEqual(await listProjects({ config }), [
      {
        id: "20260514-120000-one-sentence",
        title: "One Sentence",
        projectDir: project.projectDir,
        footageCount: 1,
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("createProject names production project directories with timestamp and first footage slug", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-project-naming-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-footages-"));

  try {
    const footagePath = path.join(footageDir, "Launch Cut!.mp4");
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    };

    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);
    const project = await createProject({
      config,
      footagePaths: [footagePath],
      now: new Date("2026-05-14T12:34:56Z"),
    });

    assert.equal(project.id, "20260514-123456-launch-cut");
    assert.equal(project.projectDir, path.join(config.projectsDir, "20260514-123456-launch-cut"));
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("createProject assigns unique transcript paths for matching footage filenames", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-project-unique-transcripts-"));
  const footageRoot = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-footages-"));
  const footageADir = path.join(footageRoot, "camera-a");
  const footageBDir = path.join(footageRoot, "camera-b");

  try {
    await mkdir(footageADir);
    await mkdir(footageBDir);
    const footageAPath = path.join(footageADir, "take.mp4");
    const footageBPath = path.join(footageBDir, "take.mp4");
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "20260514-120000-multi-footage",
    };

    await copyFile("test/fixtures/media/one_sentence.mp4", footageAPath);
    await copyFile("test/fixtures/media/two_takes.mp4", footageBPath);
    const project = await createProject({ config, footagePaths: [footageAPath, footageBPath] });
    const projectJson = JSON.parse(await readFile(path.join(project.projectDir, "project.json"), "utf8"));

    assert.deepEqual(
      projectJson.footages.map((footage) => footage.transcriptPath),
      ["transcripts/take.json", "transcripts/take-2.json"],
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageRoot, { force: true, recursive: true });
  }
});

test("createProject records footage metadata from configured ffprobe", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-project-metadata-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-footages-"));

  try {
    const footagePath = path.join(footageDir, "one_sentence.mp4");
    const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "20260514-120000-one-sentence",
      ffprobeBin,
    };

    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);
    await writeFile(
      ffprobeBin,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  streams: [
    { codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30000/1001" },
  ],
  format: { duration: "2.642" },
}));
`,
    );
    await chmod(ffprobeBin, 0o755);

    const project = await createProject({ config, footagePaths: [footagePath] });
    const projectJson = JSON.parse(await readFile(path.join(project.projectDir, "project.json"), "utf8"));

    assert.equal(projectJson.footages[0].duration, 2.64);
    assert.equal(projectJson.footages[0].width, 1920);
    assert.equal(projectJson.footages[0].height, 1080);
    assert.equal(projectJson.footages[0].fps, 29.97);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("writeTimelineExport writes kept passages from ordered footages", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-timeline-export-"));

  try {
    const project = {
      footages: [
        {
          id: "ftg_1",
          path: "/absolute/first.mp4",
          duration: 5,
          passages: [
            { id: "passage_ftg_1_0001", start: 0, end: 1.2, status: "keep", reason: "Opening." },
            { id: "passage_ftg_1_0002", start: 1.2, end: 2, status: "skip", reason: "Repeat." },
          ],
        },
        {
          id: "ftg_2",
          path: "/absolute/second.mp4",
          duration: 5,
          passages: [{ id: "passage_ftg_2_0001", start: 0.5, end: 1, status: "active", reason: "Current." }],
        },
      ],
      timeline: ["ftg_2", "ftg_1"],
    };

    const timeline = await writeTimelineExport(projectDir, project);

    assert.deepEqual(
      timeline.segments.map((segment) => segment.passageId),
      ["passage_ftg_2_0001", "passage_ftg_1_0001"],
    );
    assert.equal(timeline.duration, 1.7);
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
});

test("writeTimelineExport rejects malformed footage and passage references", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-timeline-export-invalid-"));

  try {
    await assert.rejects(
      writeTimelineExport(projectDir, { footages: [], timeline: ["ftg_missing"] }),
      /Unknown timeline footage: ftg_missing/,
    );
    await assert.rejects(
      writeTimelineExport(projectDir, { footages: "ftg_1", timeline: [] }),
      /Project footages must be an array of footage records/,
    );
    await assert.rejects(
      writeTimelineExport(projectDir, {
        footages: [{ id: "ftg_1", path: "relative.mp4", duration: 5, passages: [] }],
        timeline: ["ftg_1"],
      }),
      /Footage path for ftg_1 must be absolute/,
    );
    await assert.rejects(
      writeTimelineExport(projectDir, {
        footages: [
          {
            id: "ftg_1",
            path: "/absolute/one.mp4",
            duration: 5,
            passages: [{ id: "passage_1", start: 2, end: 1, status: "keep" }],
          },
        ],
        timeline: ["ftg_1"],
      }),
      /Invalid passage range for passage_1/,
    );
  } finally {
    await rm(projectDir, { force: true, recursive: true });
  }
});
