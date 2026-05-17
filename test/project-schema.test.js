import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProject } from "../src/project-store.js";
import { PROJECT_SCHEMA, validateProject } from "../src/project-schema.js";

test("project schema describes the footage and passage project state", () => {
  assert.equal(PROJECT_SCHEMA.version, 1);
  assert.deepEqual(Object.keys(PROJECT_SCHEMA.properties), [
    "version",
    "title",
    "footages",
    "timeline",
    "chat",
    "render",
    "operationLog",
  ]);
  assert.deepEqual(PROJECT_SCHEMA.required, Object.keys(PROJECT_SCHEMA.properties));
});

test("createProject writes a project.json that satisfies the project schema", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-schema-home-"));
  const footageDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-schema-footage-"));

  try {
    const footagePath = path.join(footageDir, "one_sentence.mp4");
    await copyFile("test/fixtures/media/one_sentence.mp4", footagePath);

    const project = await createProject({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
        noBrowserOpen: true,
        testProjectId: "20260514-120000-one-sentence",
      },
      footagePaths: [footagePath],
    });
    const projectJson = JSON.parse(await readFile(path.join(project.projectDir, "project.json"), "utf8"));

    assert.deepEqual(validateProject(projectJson), []);
    assert.deepEqual(projectJson.timeline, ["ftg_1"]);
    assert.deepEqual(projectJson.footages[0].passages, []);
    assert.deepEqual(projectJson.chat, {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    });
    assert.deepEqual(projectJson.render, { finalPath: "renders/final.mov" });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(footageDir, { force: true, recursive: true });
  }
});

test("validateProject reports missing required project state", () => {
  const errors = validateProject({
    version: 1,
    title: "Incomplete",
    footages: [],
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  });

  assert.deepEqual(errors, ["timeline is required", "chat is required"]);
});
