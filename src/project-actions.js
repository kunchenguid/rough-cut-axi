import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEditOperation } from "./edit-operations.js";
import { writeTimelineExport } from "./project-store.js";
import { addWordBoundaryTimes } from "./word-boundaries.js";

export async function applyPersistedEditOperation({ projectDir, operation } = {}) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("projectDir is required");
  }
  if (!operation || typeof operation !== "object") {
    throw new Error("operation is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const projectPath = path.join(resolvedProjectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const nextProject = applyEditOperation(project, await addWordBoundaryTimes(resolvedProjectDir, project, operation));

  await writeFile(projectPath, `${JSON.stringify(nextProject, null, 2)}\n`);
  await writeTimelineExport(resolvedProjectDir, nextProject);
  return { ok: true, timeline: nextProject.timeline, footages: nextProject.footages };
}

export async function queuePrompt({ projectDir, prompt, target = { type: "project" }, tag = "freeform" } = {}) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("projectDir is required");
  }
  if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("prompt is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const projectPath = path.join(resolvedProjectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const pendingPrompts = Array.isArray(project.chat?.pendingPrompts) ? project.chat.pendingPrompts : [];
  const queuedPrompt = {
    uid: `prompt_${pendingPrompts.length + 1}`,
    tag,
    prompt: prompt.trim(),
    target,
  };
  const nextProject = {
    ...project,
    chat: {
      ...project.chat,
      pendingPrompts: [...pendingPrompts, queuedPrompt],
    },
  };

  await writeFile(projectPath, `${JSON.stringify(nextProject, null, 2)}\n`);
  return { ok: true, prompt: queuedPrompt, pendingPromptCount: nextProject.chat.pendingPrompts.length };
}

export async function renderFinalProject({ projectDir, config, settings, renderer, onProgress = () => {} }) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("projectDir is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const project = JSON.parse(await readFile(path.join(resolvedProjectDir, "project.json"), "utf8"));
  await writeTimelineExport(resolvedProjectDir, project);
  return await renderer({ config, projectDir: resolvedProjectDir, settings, onProgress });
}
