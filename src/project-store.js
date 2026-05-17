import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { createInitialProject } from "./project-schema.js";

const execFileAsync = promisify(execFile);

export async function createProject({ config, footagePaths, now = new Date() }) {
  const id = config.testProjectId || createProjectId({ footagePaths, now });
  const projectDir = path.join(config.projectsDir, id);
  const firstFootageName = path.basename(footagePaths[0] || "video-project");
  const title = titleFromFilename(firstFootageName);
  const transcriptPaths = uniqueTranscriptPaths(footagePaths);
  const footages = await Promise.all(
    footagePaths.map(async (footagePath, index) => {
      const name = path.basename(footagePath);
      const absolutePath = path.resolve(footagePath);
      const metadata = await probeFootageMetadata({
        ffprobeBin: config.ffprobeBin || "ffprobe",
        footagePath: absolutePath,
      });

      return {
        id: `ftg_${index + 1}`,
        name,
        label: titleFromFilename(name),
        path: absolutePath,
        ...metadata,
        transcriptPath: transcriptPaths[index],
        footageFingerprint: await fingerprintFootage(absolutePath),
        passages: [],
      };
    }),
  );
  const project = createInitialProject({ title, footages });

  await mkdir(path.join(projectDir, "transcripts"), { recursive: true });
  await mkdir(path.join(projectDir, "renders"), { recursive: true });
  await mkdir(path.join(projectDir, "segments"), { recursive: true });
  await mkdir(path.join(projectDir, "verify"), { recursive: true });
  await writeFile(path.join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  await writeTimelineExport(projectDir, project);
  await writeFile(path.join(projectDir, "project.md"), `# ${title}\n`);

  return { id, title, projectDir, footageCount: footages.length };
}

export async function listProjects({ config }) {
  let entries;

  try {
    entries = await readdir(config.projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectDir = path.join(config.projectsDir, entry.name);
    try {
      const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
      projects.push({
        id: entry.name,
        title: project.title,
        projectDir,
        footageCount: Array.isArray(project.footages) ? project.footages.length : 0,
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readProjectSummary({ projectDir }) {
  const projectPath = path.resolve(projectDir);
  const projectStats = await stat(projectPath);
  if (!projectStats.isDirectory()) {
    return null;
  }

  const project = JSON.parse(await readFile(path.join(projectPath, "project.json"), "utf8"));
  return {
    id: path.basename(projectPath),
    title: project.title,
    projectDir: projectPath,
    footageCount: Array.isArray(project.footages) ? project.footages.length : 0,
  };
}

export async function writeTimelineExport(projectDir, project) {
  if (!Array.isArray(project.timeline)) {
    throw new Error("Project timeline must be an array of footage IDs");
  }
  if (!Array.isArray(project.footages)) {
    throw new Error("Project footages must be an array of footage records");
  }

  const footagesById = new Map();
  for (const footage of project.footages) {
    validateFootageRecord(footage);
    if (footagesById.has(footage.id)) {
      throw new Error(`Duplicate footage record: ${footage.id}`);
    }
    footagesById.set(footage.id, footage);
  }

  const seenTimelineFootageIds = new Set();
  const segments = [];
  for (const footageId of project.timeline) {
    if (typeof footageId !== "string" || footageId.trim().length === 0) {
      throw new Error("Project timeline entries must be footage ID strings");
    }
    if (footageId !== footageId.trim()) {
      throw new Error("Project timeline entries must be footage IDs without surrounding whitespace");
    }
    if (seenTimelineFootageIds.has(footageId)) {
      throw new Error(`Duplicate timeline footage: ${footageId}`);
    }
    seenTimelineFootageIds.add(footageId);

    const footage = footagesById.get(footageId);
    if (!footage) {
      throw new Error(`Unknown timeline footage: ${footageId}`);
    }

    for (const passage of footage.passages || []) {
      validatePassageForTimeline({ footage, passage });
      if (passage.status === "skip") {
        continue;
      }
      const duration = roundSeconds(passage.end - passage.start);
      segments.push({
        passageId: passage.id,
        footageId: footage.id,
        footagePath: footage.path,
        start: roundSeconds(passage.start),
        end: roundSeconds(passage.end),
        duration,
      });
    }
  }

  const timeline = {
    version: 1,
    duration: roundSeconds(segments.reduce((total, segment) => total + segment.duration, 0)),
    segments,
  };

  await writeFile(path.join(projectDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  return timeline;
}

function validateFootageRecord(footage) {
  if (!footage || typeof footage !== "object") {
    throw new Error("footage record must be an object with a trimmed non-empty string id");
  }
  if (typeof footage.id !== "string" || footage.id.trim().length === 0) {
    throw new Error("footage record must have an id");
  }
  if (footage.id !== footage.id.trim()) {
    throw new Error("footage record id must be a trimmed non-empty string");
  }
  if (footage.path === undefined || footage.path === "") {
    throw new Error(`Missing footage path for ${footage.id}`);
  }
  if (typeof footage.path !== "string") {
    throw new Error(`Footage path for ${footage.id} must be a string: ${footage.path}`);
  }
  if (footage.path !== footage.path.trim()) {
    throw new Error(`Footage path for ${footage.id} must not contain surrounding whitespace: ${footage.path}`);
  }
  if (!path.isAbsolute(footage.path)) {
    throw new Error(`Footage path for ${footage.id} must be absolute: ${footage.path}`);
  }
  if (footage.duration !== undefined && typeof footage.duration !== "number") {
    throw new Error(`Footage duration for ${footage.id} must be a number: ${footage.duration}`);
  }
  if (footage.duration !== undefined && (!Number.isFinite(footage.duration) || footage.duration <= 0)) {
    throw new Error(`Invalid footage duration for ${footage.id}: ${footage.duration}`);
  }
  if (!Array.isArray(footage.passages)) {
    throw new Error(`Footage ${footage.id} passages must be an array`);
  }
}

function validatePassageForTimeline({ footage, passage }) {
  if (!passage || typeof passage !== "object") {
    throw new Error(`Footage ${footage.id} passage record must be an object`);
  }
  if (typeof passage.id !== "string" || passage.id.trim().length === 0) {
    throw new Error(`Footage ${footage.id} passage record must have an id`);
  }
  if (passage.id !== passage.id.trim()) {
    throw new Error(`Passage record id must be a trimmed non-empty string: ${passage.id}`);
  }
  if (!PASSAGE_STATUSES.has(passage.status)) {
    throw new Error(`Passage ${passage.id} status must be keep, skip, or active`);
  }
  if (typeof passage.start !== "number" || typeof passage.end !== "number") {
    throw new Error(`Passage range for ${passage.id} must use numeric start and end values`);
  }
  if (!Number.isFinite(passage.start) || !Number.isFinite(passage.end) || passage.start >= passage.end) {
    throw new Error(
      `Invalid passage range for ${passage.id}: start ${passage.start} must be before end ${passage.end}`,
    );
  }
  if (passage.start < 0) {
    throw new Error(`Invalid passage range for ${passage.id}: start ${passage.start} cannot be negative`);
  }
  if (Number.isFinite(footage.duration) && passage.start >= footage.duration) {
    throw new Error(
      `Invalid passage range for ${passage.id}: start ${passage.start} must be before footage duration ${footage.duration}`,
    );
  }
  const duration = roundSeconds(passage.end - passage.start);
  if (duration <= 0) {
    throw new Error(`Invalid passage range for ${passage.id}: rounded duration must be greater than 0`);
  }
}

const PASSAGE_STATUSES = new Set(["keep", "skip", "active"]);

function roundSeconds(value) {
  return Math.round(Number(value) * 100) / 100;
}

function titleFromFilename(filename) {
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return (
    stem
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || "Video Project"
  );
}

function createProjectId({ footagePaths, now }) {
  return `${formatTimestamp(now)}-${slugFromFootagePaths(footagePaths)}`;
}

function formatTimestamp(value) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hour = String(value.getUTCHours()).padStart(2, "0");
  const minute = String(value.getUTCMinutes()).padStart(2, "0");
  const second = String(value.getUTCSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function slugFromFootagePaths(footagePaths) {
  const sharedParent = sharedParentName(footagePaths);
  if (sharedParent) {
    return slugify(sharedParent) || "video-project";
  }

  const firstFootageName = path.basename(footagePaths[0] || "video-project");
  const extension = path.extname(firstFootageName);
  const stem = extension ? firstFootageName.slice(0, -extension.length) : firstFootageName;

  return slugify(stem) || "video-project";
}

function sharedParentName(footagePaths) {
  if (footagePaths.length < 2) {
    return "";
  }

  const parentDirs = footagePaths.map((footagePath) => path.dirname(path.resolve(footagePath)));
  const [firstParent] = parentDirs;
  if (!parentDirs.every((parentDir) => parentDir === firstParent)) {
    return "";
  }

  return path.basename(firstParent);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueTranscriptPaths(footagePaths) {
  const counts = new Map();

  return footagePaths.map((footagePath) => {
    const name = path.basename(footagePath);
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const count = counts.get(stem) || 0;
    counts.set(stem, count + 1);
    const suffix = count === 0 ? "" : `-${count + 1}`;

    return `transcripts/${stem}${suffix}.json`;
  });
}

export async function fingerprintFootage(footagePath) {
  const footageStats = await stat(footagePath);
  return `size:${footageStats.size}:mtimeMs:${footageStats.mtimeMs}`;
}

async function probeFootageMetadata({ ffprobeBin, footagePath }) {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    footagePath,
  ]);
  const probe = JSON.parse(stdout);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video") || {};

  return {
    duration: roundSeconds(probe.format?.duration || videoStream.duration || 0),
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    fps: roundFps(videoStream.r_frame_rate || videoStream.avg_frame_rate || "0/1"),
  };
}

function roundFps(value) {
  const [numerator, denominator] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100) / 100;
}
