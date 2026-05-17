import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getRenderSettingsState, renderProfileForSettings } from "./render-settings.js";

export async function renderTimeline({ config, projectDir, settings = null, onProgress = () => {} }) {
  const resolvedProjectDir = path.resolve(projectDir);
  const timeline = JSON.parse(await readFile(path.join(resolvedProjectDir, "timeline.json"), "utf8"));
  const renderDir = path.join(resolvedProjectDir, "renders");
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  const renderSettings = await getRenderSettingsState({
    config,
    requestedSettings: settings,
    strict: Boolean(settings),
  });
  const profile = renderProfileForSettings(renderSettings.settings, renderSettings.capabilities);
  const outputPath = path.join(renderDir, `final.${profile.extension}`);

  await mkdir(renderDir, { recursive: true });
  if (segments.length === 0) {
    throw new Error("cannot render an empty timeline");
  }

  const expectedDuration = Number(timeline.duration || 0);
  const inputPaths = uniqueInputPaths(segments);
  const inputIndexByPath = new Map(inputPaths.map((inputPath, index) => [inputPath, index]));
  await runCommand(
    config.ffmpegBin,
    [
      "-y",
      "-progress",
      "pipe:1",
      "-nostats",
      ...inputPaths.flatMap((inputPath) => ["-i", inputPath]),
      "-filter_complex",
      renderFinalFilter(segments, inputIndexByPath, renderSettings.settings.frameRate),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-t",
      formatSeconds(expectedDuration),
      "-fps_mode",
      "cfr",
      ...profile.videoArgs,
      "-r",
      formatSeconds(renderSettings.settings.frameRate),
      ...profile.audioArgs,
      ...profile.outputArgs,
      outputPath,
    ],
    { expectedDuration, onProgress },
  );
  const actualDuration = await probeDuration({ ffprobeBin: config.ffprobeBin, outputPath });
  const durationDelta = roundSeconds(Math.abs(actualDuration - expectedDuration));
  const durationOk = durationDelta <= 0.25;
  if (!durationOk) {
    throw new Error(`render duration mismatch: expected ${expectedDuration}s, got ${actualDuration}s`);
  }

  return {
    target: "final",
    outputPath,
    sizeBytes: (await stat(outputPath)).size,
    segmentCount: segments.length,
    expectedDuration,
    actualDuration,
    durationDelta,
    durationOk,
  };
}

function uniqueInputPaths(segments) {
  const seen = new Set();
  const inputPaths = [];
  for (const segment of segments) {
    const inputPath = segment.footagePath;
    if (!seen.has(inputPath)) {
      seen.add(inputPath);
      inputPaths.push(inputPath);
    }
  }
  return inputPaths;
}

function renderFinalFilter(segments, inputIndexByPath, frameRate) {
  const filters = [];
  const concatInputs = [];
  for (const [index, segment] of segments.entries()) {
    const inputIndex = inputIndexByPath.get(segment.footagePath);
    filters.push(
      `[${inputIndex}:v]trim=start=${formatSeconds(segment.start)}:end=${formatSeconds(segment.end)},setpts=PTS-STARTPTS[v${index}]`,
    );
    filters.push(
      `[${inputIndex}:a]atrim=start=${formatSeconds(segment.start)}:end=${formatSeconds(segment.end)},asetpts=PTS-STARTPTS[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[concatv][outa]`);
  filters.push(`[concatv]fps=${formatSeconds(frameRate)},setpts=PTS-STARTPTS[outv]`);
  return filters.join(";");
}

function runCommand(command, args, { expectedDuration = 0, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutRemainder = "";
    const progressState = {};
    const handleProgressLine = (line) => {
      const progress = parseFfmpegProgressLine(line, progressState, expectedDuration);
      if (progress) {
        onProgress(progress);
      }
    };

    child.stdout.on("data", (buffer) => {
      const lines = String(stdoutRemainder + buffer).split(/\r?\n/);
      stdoutRemainder = lines.pop() || "";
      for (const line of lines) {
        handleProgressLine(line);
      }
    });
    child.stderr.on("data", (buffer) => {
      stderr += buffer;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdoutRemainder) {
        handleProgressLine(stdoutRemainder);
      }
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function parseFfmpegProgressLine(line, state, expectedDuration) {
  const separatorIndex = line.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  state[key] = value;
  if (key !== "out_time_us" && key !== "out_time_ms" && key !== "out_time") {
    return null;
  }

  const outTime = parseFfmpegOutTime(state);
  if (!Number.isFinite(outTime)) {
    return null;
  }

  const duration = Number(expectedDuration) || 0;
  const percent = duration > 0 ? Math.max(0, Math.min(outTime / duration, 1)) : 0;
  return {
    percent,
    outTime: roundSeconds(outTime),
    expectedDuration: roundSeconds(duration),
    speed: state.speed || "",
  };
}

function parseFfmpegOutTime(state) {
  if (state.out_time_us !== undefined) {
    return Number(state.out_time_us) / 1_000_000;
  }
  if (state.out_time_ms !== undefined) {
    return Number(state.out_time_ms) / 1_000_000;
  }
  if (state.out_time !== undefined) {
    return parseFfmpegTimecode(state.out_time);
  }
  return Number.NaN;
}

function parseFfmpegTimecode(value) {
  const match = String(value).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function runCommandWithOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buffer) => {
      stdout += buffer;
    });
    child.stderr.on("data", (buffer) => {
      stderr += buffer;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`ffprobe exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function probeDuration({ ffprobeBin, outputPath }) {
  const stdout = await runCommandWithOutput(ffprobeBin, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    outputPath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`ffprobe returned invalid duration for ${outputPath}`);
  }

  return roundSeconds(duration);
}

function formatSeconds(value) {
  return String(Number(value));
}

function roundSeconds(value) {
  return Math.round(Number(value) * 100) / 100;
}
