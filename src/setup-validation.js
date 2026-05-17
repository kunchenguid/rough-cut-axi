import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readElevenLabsApiKey } from "./auth-store.js";
import { detectRenderCapabilities, hasAnyRenderEncoder } from "./render-settings.js";

const execFileAsync = promisify(execFile);

export async function validateSetup({
  config,
  env = process.env,
  ffmpegBin = config.ffmpegBin || "ffmpeg",
  ffprobeBin = config.ffprobeBin || "ffprobe",
}) {
  const errors = [];

  const ffmpegAvailable = await canRun(ffmpegBin);
  if (!ffmpegAvailable) {
    errors.push({
      code: "missing-ffmpeg",
      message: "ffmpeg is required",
      help: "Install ffmpeg or make sure it is available on PATH",
    });
  }

  if (ffmpegAvailable && !hasAnyRenderEncoder(await detectRenderCapabilities({ ffmpegBin }))) {
    errors.push({
      code: "missing-render-encoder",
      message: "ffmpeg must support at least one final render encoder",
      help: "Install a full ffmpeg build with libx264, libx265, or prores_ks support",
    });
  }

  if (!(await canRun(ffprobeBin))) {
    errors.push({
      code: "missing-ffprobe",
      message: "ffprobe is required",
      help: "Install ffprobe or make sure it is available on PATH",
    });
  }

  if (!(await readElevenLabsApiKey({ config, env }))) {
    errors.push({
      code: "missing-elevenlabs-api-key",
      message: "ELEVENLABS_API_KEY is required",
      help: "Run `rough-cut-axi auth elevenlabs --api-key <key>` or set ELEVENLABS_API_KEY in your environment",
    });
  }

  if (!(await canWriteProjectStorage(config.projectsDir))) {
    errors.push({
      code: "project-storage-not-writable",
      message: `Project storage is not writable: ${config.projectsDir}`,
      help: "Choose a writable ROUGH_CUT_AXI_HOME or fix directory permissions",
    });
  }

  return { ok: errors.length === 0, errors };
}

async function canRun(bin) {
  try {
    await execFileAsync(bin, ["-version"]);
    return true;
  } catch {
    try {
      await execFileAsync(bin, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
}

async function canWriteProjectStorage(projectsDir) {
  const probePath = path.join(projectsDir, `.rough-cut-axi-write-test-${process.pid}`);

  try {
    await mkdir(projectsDir, { recursive: true });
    await access(projectsDir, constants.W_OK);
    await writeFile(probePath, "ok");
    await rm(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
