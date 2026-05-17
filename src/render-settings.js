import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FRAME_RATE_OPTIONS = [24, 30, 60];
export const CODEC_OPTIONS = [
  { value: "h264", label: "H.264", encoders: ["libx264", "h264_videotoolbox"], extension: "mp4" },
  { value: "h265", label: "H.265", encoders: ["libx265", "hevc_videotoolbox"], extension: "mp4" },
  { value: "prores", label: "ProRes", encoders: ["prores_ks"], extension: "mov" },
];

const DEFAULT_RENDER_SETTINGS = { frameRate: 30, codec: "prores" };

export async function getRenderSettingsState({ config, requestedSettings = null, strict = false } = {}) {
  const capabilities = await detectRenderCapabilities({ ffmpegBin: config.ffmpegBin || "ffmpeg" });
  const persisted = requestedSettings || (await readUserRenderSettings({ config }));
  const settings = resolveRenderSettings({ settings: persisted, capabilities, strict });
  return {
    settings,
    options: {
      frameRates: FRAME_RATE_OPTIONS.map((value) => ({ value, label: String(value), available: true })),
      codecs: capabilities.codecs.map(({ value, label, available }) => ({ value, label, available })),
    },
    capabilities,
  };
}

export async function saveRenderSettings({ config, settings }) {
  const state = await getRenderSettingsState({ config, requestedSettings: settings, strict: Boolean(settings) });
  await mkdir(config.homeDir, { recursive: true });
  await writeFile(renderSettingsPath(config), `${JSON.stringify({ version: 1, final: state.settings }, null, 2)}\n`);
  return state.settings;
}

export async function detectRenderCapabilities({ ffmpegBin }) {
  const stdout = await readFfmpegEncoders(ffmpegBin);
  const codecs = CODEC_OPTIONS.map((option) => {
    const encoder = option.encoders.find((candidate) => hasEncoder(stdout, candidate)) || "";
    return { ...option, encoder, available: encoder !== "" };
  });
  return { codecs };
}

export function renderProfileForSettings(settings, capabilities) {
  const codec = capabilities.codecs.find((candidate) => candidate.value === settings.codec && candidate.available);
  if (!codec) {
    throw new Error(`render codec is unavailable on this machine: ${settings.codec}`);
  }

  if (settings.codec === "prores") {
    return {
      extension: "mov",
      videoArgs: ["-c:v", codec.encoder, "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"],
      audioArgs: ["-c:a", "pcm_s16le", "-ar", "48000"],
      outputArgs: [],
    };
  }

  if (settings.codec === "h265") {
    return {
      extension: "mp4",
      videoArgs: ["-c:v", codec.encoder, "-crf", "18", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"],
      audioArgs: ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"],
      outputArgs: ["-movflags", "+faststart"],
    };
  }

  return {
    extension: "mp4",
    videoArgs: ["-c:v", codec.encoder, "-crf", "16", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"],
    outputArgs: ["-movflags", "+faststart"],
  };
}

export function hasAnyRenderEncoder(capabilities) {
  return capabilities.codecs.some((codec) => codec.available);
}

function resolveRenderSettings({ settings, capabilities, strict }) {
  const frameRate = Number(settings?.frameRate || DEFAULT_RENDER_SETTINGS.frameRate);
  const codec = String(settings?.codec || DEFAULT_RENDER_SETTINGS.codec);

  if (strict && !FRAME_RATE_OPTIONS.includes(frameRate)) {
    throw new Error(`render frame rate is not supported: ${settings.frameRate}`);
  }

  const resolvedFrameRate = FRAME_RATE_OPTIONS.includes(frameRate) ? frameRate : DEFAULT_RENDER_SETTINGS.frameRate;
  const availableCodecs = capabilities.codecs
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.value);
  if (availableCodecs.length === 0) {
    throw new Error("ffmpeg must support at least one final render encoder");
  }
  if (availableCodecs.includes(codec)) {
    return { frameRate: resolvedFrameRate, codec };
  }
  if (strict) {
    throw new Error(`render codec is unavailable on this machine: ${codec}`);
  }

  return { frameRate: resolvedFrameRate, codec: availableCodecs.includes("prores") ? "prores" : availableCodecs[0] };
}

async function readUserRenderSettings({ config }) {
  try {
    const body = JSON.parse(await readFile(renderSettingsPath(config), "utf8"));
    return body?.final || null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readFfmpegEncoders(ffmpegBin) {
  try {
    const { stdout } = await execFileAsync(ffmpegBin, ["-hide_banner", "-encoders"]);
    return stdout;
  } catch {
    return "";
  }
}

function hasEncoder(stdout, encoder) {
  return new RegExp(`(^|\\s)${escapeRegExp(encoder)}(\\s|$)`, "m").test(stdout);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSettingsPath(config) {
  return path.join(config.homeDir, "render-settings.json");
}
