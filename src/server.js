import express from "express";
import { execFile } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { renderTimeline } from "./rendering.js";
import { renderEditorShell } from "./editor-shell.js";
import { applyPersistedEditOperation, queuePrompt, renderFinalProject } from "./project-actions.js";
import { getRenderSettingsState, saveRenderSettings } from "./render-settings.js";
import { readPassageWaveform } from "./waveform.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const execFileAsync = promisify(execFile);

export async function startServer({
  config,
  port = 0,
  host = "127.0.0.1",
  finalRenderer = async ({ config: renderConfig, projectDir, settings, onProgress }) =>
    renderTimeline({ config: renderConfig, projectDir, settings, onProgress }),
  fileRevealer = revealFileInFolder,
  waveformRenderer = async ({ projectDir, footage, passage, bars, config: waveformConfig }) =>
    readPassageWaveform({
      projectDir,
      footage,
      passage,
      bars,
      ffmpegBin: waveformConfig.ffmpegBin || "ffmpeg",
    }),
}) {
  const app = express();
  const projectEventClients = new Map();
  const projectEventWatchers = new Map();
  const renderProgressClients = new Map();
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      app: "rough-cut-axi",
      version: VERSION,
      homeDir: config.homeDir,
      projectsDir: config.projectsDir,
    });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (_request, response) => {
    response.json({ status: "shutting-down" });
    setImmediate(() => {
      closeServer().catch(() => {});
    });
  });

  app.get("/api/project-events", async (request, response) => {
    try {
      const projectDir = resolveProjectEventDir(request.query.project);
      const eventData = await loadProjectEventState(projectDir);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      addProjectEventClient(projectEventClients, projectEventWatchers, projectDir, response);
      request.on("close", () =>
        removeProjectEventClient(projectEventClients, projectEventWatchers, projectDir, response),
      );
      writeProjectStateEvent(response, eventData);
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/", async (request, response) => {
    response.type("html").send(renderEditorShell(await loadEditorProjectState(request.query.project)));
  });

  app.get("/api/project-media", (request, response) => {
    try {
      const mediaPath = resolveProjectMediaPath(request.query.project, request.query.file);
      response.sendFile(mediaPath);
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/footage-media", async (request, response) => {
    try {
      const mediaPath = await resolveFootageMediaPath(request.query.project, request.query.footage);
      response.sendFile(mediaPath);
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/reveal-render", async (request, response) => {
    try {
      const mediaPath = resolveProjectRenderPath(request.body?.projectDir, request.body?.file);
      await stat(mediaPath);
      await fileRevealer(mediaPath);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/passage-waveform", async (request, response) => {
    try {
      const { projectDir, footage, passage, bars } = await resolvePassageWaveformRequest(request.query);
      const peaks = await waveformRenderer({ projectDir, footage, passage, bars, config });
      response.json({ ok: true, passageId: passage.id, peaks: sanitizeWaveformPeaks(peaks, bars) });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/render-settings", async (request, response) => {
    try {
      const projectDir = resolveProjectEventDir(request.query.project);
      const settingsState = await getRenderSettingsState({ config });
      response.json({
        ok: true,
        settings: settingsState.settings,
        options: settingsState.options,
        summary: await loadRenderSummary(projectDir),
      });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/render-final-progress", (request, response) => {
    try {
      const jobId = requireRenderJobId(request.query.jobId);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      addRenderProgressClient(renderProgressClients, jobId, response);
      request.on("close", () => removeRenderProgressClient(renderProgressClients, jobId, response));
      writeRenderProgressEvent(response, { percent: 0, outTime: 0, stage: "waiting" });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/edit-operations", async (request, response) => {
    try {
      const result = await applyPersistedEditOperation(request.body);
      await notifyProjectEventClients(projectEventClients, request.body?.projectDir);
      response.json(result);
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/prompts", async (request, response) => {
    try {
      const result = await queuePrompt(request.body);
      await notifyProjectEventClients(projectEventClients, request.body?.projectDir);
      response.json(result);
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/render-final", async (request, response) => {
    try {
      const jobId = optionalRenderJobId(request.body?.jobId);
      const onProgress = (progress) => notifyRenderProgressClients(renderProgressClients, jobId, progress);
      onProgress({ percent: 0, outTime: 0, stage: "encoding" });
      const settings = await saveRenderSettings({ config, settings: request.body?.settings });
      const result = await renderFinalProject({
        projectDir: request.body?.projectDir,
        config,
        settings,
        renderer: finalRenderer,
        onProgress,
      });
      onProgress({
        percent: 1,
        outTime: result?.actualDuration || result?.expectedDuration || 0,
        expectedDuration: result?.expectedDuration || 0,
        stage: "completed",
      });
      await notifyProjectEventClients(projectEventClients, request.body?.projectDir);
      response.json({ ok: true, outputPath: result?.outputPath || "", sizeBytes: await readOutputSize(result) });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });

  const address = httpServer.address();
  const actualHost = address.address === "::" ? "127.0.0.1" : address.address;

  return {
    app,
    port: address.port,
    url: `http://${actualHost}:${address.port}`,
    close: closeServer,
    done,
  };

  async function closeServer() {
    for (const clients of projectEventClients.values()) {
      for (const client of clients) {
        client.end();
      }
    }
    projectEventClients.clear();
    for (const watcher of projectEventWatchers.values()) {
      watcher.close();
    }
    projectEventWatchers.clear();
    for (const clients of renderProgressClients.values()) {
      for (const client of clients) {
        client.end();
      }
    }
    renderProgressClients.clear();

    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    shutdownResolve();
  }
}

async function loadRenderSummary(projectDir) {
  const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
  const timeline = Array.isArray(project.timeline) && project.timeline.length > 0 ? project.timeline : [];
  const footagesById = new Map((project.footages || []).map((footage) => [footage.id, footage]));
  const footages = timeline.map((footageId) => footagesById.get(footageId)).filter(Boolean);
  const duration = footages.reduce(
    (total, footage) =>
      total +
      (footage.passages || []).reduce((footageTotal, passage) => {
        if (passage.status === "skip") {
          return footageTotal;
        }
        return footageTotal + Math.max(0, Number(passage.end) - Number(passage.start));
      }, 0),
    0,
  );
  return { duration: roundSeconds(duration), footages: footages.length };
}

function roundSeconds(value) {
  return Math.round(Number(value) * 100) / 100;
}

function requireRenderJobId(value) {
  if (!value || typeof value !== "string") {
    throw new Error("jobId is required");
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error("jobId is invalid");
  }
  return value;
}

function optionalRenderJobId(value) {
  if (!value) {
    return "";
  }
  return requireRenderJobId(value);
}

function addRenderProgressClient(clientsByJob, jobId, response) {
  const clients = clientsByJob.get(jobId) || new Set();
  clients.add(response);
  clientsByJob.set(jobId, clients);
}

function removeRenderProgressClient(clientsByJob, jobId, response) {
  const clients = clientsByJob.get(jobId);
  if (!clients) {
    return;
  }
  clients.delete(response);
  if (clients.size === 0) {
    clientsByJob.delete(jobId);
  }
}

function notifyRenderProgressClients(clientsByJob, jobId, progress) {
  if (!jobId) {
    return;
  }
  const clients = clientsByJob.get(jobId);
  if (!clients || clients.size === 0) {
    return;
  }
  for (const client of clients) {
    writeRenderProgressEvent(client, progress);
  }
}

function writeRenderProgressEvent(response, progress) {
  response.write("event: render-progress\n");
  response.write(`data: ${JSON.stringify(sanitizeRenderProgress(progress))}\n\n`);
}

function sanitizeRenderProgress(progress = {}) {
  const percent = Number(progress.percent);
  const outTime = Number(progress.outTime);
  const expectedDuration = Number(progress.expectedDuration);
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(percent, 1)) : 0,
    outTime: Number.isFinite(outTime) ? Math.max(0, outTime) : 0,
    expectedDuration: Number.isFinite(expectedDuration) ? Math.max(0, expectedDuration) : 0,
    speed: typeof progress.speed === "string" ? progress.speed : "",
    stage: typeof progress.stage === "string" ? progress.stage : "encoding",
  };
}

async function readOutputSize(result) {
  if (Number.isFinite(Number(result?.sizeBytes)) && Number(result.sizeBytes) >= 0) {
    return Number(result.sizeBytes);
  }
  if (!result?.outputPath) {
    return 0;
  }
  try {
    return (await stat(result.outputPath)).size;
  } catch {
    return 0;
  }
}

async function revealFileInFolder(filePath) {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", filePath]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("explorer", ["/select,", filePath]);
    return;
  }
  await execFileAsync("xdg-open", [path.dirname(filePath)]);
}

async function loadEditorProjectState(projectDir) {
  if (!projectDir || typeof projectDir !== "string") {
    return {
      projectDir: "",
      title: "Untitled project",
      footages: [],
      pendingPrompts: [],
      chatMessages: [],
      agentPresence: "waiting",
      render: {},
    };
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const project = JSON.parse(await readFile(path.join(resolvedProjectDir, "project.json"), "utf8"));
  const footages = await buildEditorFootages({ projectDir: resolvedProjectDir, project });

  return {
    projectDir: resolvedProjectDir,
    title: project.title || "Untitled project",
    footages,
    pendingPrompts: Array.isArray(project.chat?.pendingPrompts) ? project.chat.pendingPrompts : [],
    chatMessages: Array.isArray(project.chat?.messages) ? project.chat.messages : [],
    agentPresence: project.chat?.agentPresence || "waiting",
    render: project.render || {},
  };
}

async function buildEditorFootages({ projectDir, project }) {
  const footagesById = new Map((project.footages || []).map((footage) => [footage.id, footage]));
  const timeline =
    Array.isArray(project.timeline) && project.timeline.length > 0 ? project.timeline : [...footagesById.keys()];
  const orderedFootages = timeline.map((footageId) => footagesById.get(footageId)).filter(Boolean);

  return await Promise.all(
    orderedFootages.map(async (footage, index) => {
      const passages =
        Array.isArray(footage.passages) && footage.passages.length > 0
          ? footage.passages
          : await loadTranscriptPassages(projectDir, footage);
      return {
        ...footage,
        order: index + 1,
        label: footage.label || footage.name || footage.id,
        passages,
      };
    }),
  );
}

async function loadTranscriptPassages(projectDir, footage) {
  if (!footage.transcriptPath) {
    return [];
  }

  let transcript;
  try {
    transcript = JSON.parse(await readFile(path.join(projectDir, footage.transcriptPath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return (transcript.segments || []).map((segment, index) => ({
    id: `passage_${footage.id}_${String(index + 1).padStart(4, "0")}`,
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker || "speaker_1",
    text: segment.text || "",
    status: "keep",
    reason: "Derived from transcript.",
  }));
}

async function loadProjectEventState(projectDir) {
  const resolvedProjectDir = resolveProjectEventDir(projectDir);
  const project = JSON.parse(await readFile(path.join(resolvedProjectDir, "project.json"), "utf8"));
  const pendingPrompts = Array.isArray(project.chat?.pendingPrompts) ? project.chat.pendingPrompts : [];
  const timelineFootageCount = Array.isArray(project.timeline) ? project.timeline.length : 0;

  return {
    projectDir: resolvedProjectDir,
    title: project.title || "Untitled project",
    agentPresence: project.chat?.agentPresence || "waiting",
    pendingPromptCount: pendingPrompts.length,
    timelineFootageCount,
  };
}

function resolveProjectEventDir(projectDir) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("project is required");
  }

  return path.resolve(projectDir);
}

function resolveProjectMediaPath(projectDir, filePath) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("project is required");
  }
  if (!filePath || typeof filePath !== "string") {
    throw new Error("file is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedMediaPath = path.resolve(resolvedProjectDir, filePath);
  if (!resolvedMediaPath.startsWith(`${resolvedProjectDir}${path.sep}`)) {
    throw new Error("file must be inside the project directory");
  }

  return resolvedMediaPath;
}

function resolveProjectRenderPath(projectDir, filePath) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("project is required");
  }
  if (!filePath || typeof filePath !== "string") {
    throw new Error("file is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedRendersDir = path.join(resolvedProjectDir, "renders");
  const resolvedMediaPath = path.resolve(resolvedProjectDir, filePath);
  if (!resolvedMediaPath.startsWith(`${resolvedRendersDir}${path.sep}`)) {
    throw new Error("file must be inside the project renders directory");
  }

  return resolvedMediaPath;
}

async function resolveFootageMediaPath(projectDir, footageId) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("project is required");
  }
  if (!footageId || typeof footageId !== "string") {
    throw new Error("footage is required");
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const project = JSON.parse(await readFile(path.join(resolvedProjectDir, "project.json"), "utf8"));
  const footage = (project.footages || []).find((candidate) => candidate.id === footageId);
  if (!footage?.path) {
    throw new Error("footage was not found in project");
  }

  return path.resolve(footage.path);
}

async function resolvePassageWaveformRequest(query) {
  const projectDir = resolveProjectEventDir(query.project);
  const passageId = requireTrimmedQueryString(query.passage, "passage");
  const bars = parseWaveformBars(query.bars);
  const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
  for (const footage of project.footages || []) {
    const passage = (footage.passages || []).find((candidate) => candidate.id === passageId);
    if (passage) {
      return { projectDir, footage, passage, bars };
    }
  }
  throw new Error(`Unknown passage: ${passageId}`);
}

function requireTrimmedQueryString(value, name) {
  if (!value || typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseWaveformBars(value) {
  if (value === undefined) {
    return 56;
  }
  const bars = Number(value);
  if (!Number.isInteger(bars) || bars < 1 || bars > 240) {
    throw new Error("bars must be an integer from 1 to 240");
  }
  return bars;
}

function sanitizeWaveformPeaks(peaks, bars) {
  if (!Array.isArray(peaks)) {
    return Array.from({ length: bars }, () => 0);
  }
  return peaks.slice(0, bars).map((peak) => Math.max(0, Math.min(Number(peak) || 0, 1)));
}

function addProjectEventClient(clientsByProject, watchersByProject, projectDir, response) {
  const clients = clientsByProject.get(projectDir) || new Set();
  clients.add(response);
  clientsByProject.set(projectDir, clients);
  ensureProjectEventWatcher(clientsByProject, watchersByProject, projectDir);
}

function removeProjectEventClient(clientsByProject, watchersByProject, projectDir, response) {
  const clients = clientsByProject.get(projectDir);
  if (!clients) {
    return;
  }

  clients.delete(response);
  if (clients.size === 0) {
    clientsByProject.delete(projectDir);
    const watcher = watchersByProject.get(projectDir);
    if (watcher) {
      watcher.close();
      watchersByProject.delete(projectDir);
    }
  }
}

function ensureProjectEventWatcher(clientsByProject, watchersByProject, projectDir) {
  if (watchersByProject.has(projectDir)) {
    return;
  }

  let timer;
  const watcher = watch(path.join(projectDir, "project.json"), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      notifyProjectEventClients(clientsByProject, projectDir).catch(() => {});
    }, 25);
  });
  const originalClose = watcher.close.bind(watcher);
  watcher.close = () => {
    clearTimeout(timer);
    originalClose();
  };
  watchersByProject.set(projectDir, watcher);
}

async function notifyProjectEventClients(clientsByProject, projectDir) {
  if (!projectDir || typeof projectDir !== "string") {
    return;
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const clients = clientsByProject.get(resolvedProjectDir);
  if (!clients || clients.size === 0) {
    return;
  }

  const eventData = await loadProjectEventState(resolvedProjectDir);
  for (const client of clients) {
    writeProjectStateEvent(client, eventData);
  }
}

function writeProjectStateEvent(response, eventData) {
  response.write(`event: project-state\n`);
  response.write(`data: ${JSON.stringify(eventData)}\n\n`);
}
