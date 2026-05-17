import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fingerprintFootage } from "./project-store.js";

const WAVEFORM_CACHE_VERSION = 1;
const WAVEFORM_SAMPLE_RATE = 8000;
const WAVEFORM_BARS_PER_SECOND = 40;

export function computeWaveformPeaks(samples, bars) {
  const barCount = requireBarCount(bars);
  if (!samples || samples.length === 0) {
    return Array.from({ length: barCount }, () => 0);
  }

  const peaks = [];
  for (let index = 0; index < barCount; index += 1) {
    const start = Math.floor((index / barCount) * samples.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / barCount) * samples.length));
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < Math.min(end, samples.length); sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(Number(samples[sampleIndex]) || 0));
    }
    peaks.push(peak);
  }

  return normalizePeaks(peaks);
}

export function sliceWaveformPeaks({ peaks, duration, start, end, bars }) {
  const barCount = requireBarCount(bars);
  const sourcePeaks = Array.isArray(peaks) ? peaks : [];
  const sourceDuration = Number(duration);
  const passageStart = Number(start);
  const passageEnd = Number(end);
  if (
    sourcePeaks.length === 0 ||
    !Number.isFinite(sourceDuration) ||
    sourceDuration <= 0 ||
    !Number.isFinite(passageStart) ||
    !Number.isFinite(passageEnd) ||
    passageEnd <= passageStart
  ) {
    return Array.from({ length: barCount }, () => 0);
  }

  const clampedStart = Math.max(0, Math.min(passageStart, sourceDuration));
  const clampedEnd = Math.max(clampedStart, Math.min(passageEnd, sourceDuration));
  const passageDuration = clampedEnd - clampedStart;
  const passagePeaks = [];
  for (let index = 0; index < barCount; index += 1) {
    const barStart = clampedStart + (index / barCount) * passageDuration;
    const barEnd = clampedStart + ((index + 1) / barCount) * passageDuration;
    const peakStart = Math.max(0, Math.floor((barStart / sourceDuration) * sourcePeaks.length));
    const peakEnd = Math.max(peakStart + 1, Math.ceil((barEnd / sourceDuration) * sourcePeaks.length));
    let peak = 0;
    for (let peakIndex = peakStart; peakIndex < Math.min(peakEnd, sourcePeaks.length); peakIndex += 1) {
      peak = Math.max(peak, Number(sourcePeaks[peakIndex]) || 0);
    }
    passagePeaks.push(peak);
  }

  return normalizePeaks(passagePeaks);
}

export async function readPassageWaveform({ projectDir, footage, passage, bars, ffmpegBin = "ffmpeg" }) {
  const cache = await ensureFootageWaveformCache({ projectDir, footage, ffmpegBin });
  return sliceWaveformPeaks({
    peaks: cache.peaks,
    duration: cache.duration,
    start: passage.start,
    end: passage.end,
    bars,
  });
}

export async function ensureFootageWaveformCache({ projectDir, footage, ffmpegBin = "ffmpeg" }) {
  const sourceFingerprint = await fingerprintFootage(footage.path);
  const cachePath = getFootageWaveformCachePath(projectDir, footage);
  const cached = await readWaveformCache(cachePath);
  if (isCurrentWaveformCache(cached, { footage, sourceFingerprint })) {
    return cached;
  }

  const waveform = await renderFootageWaveform({ footage, ffmpegBin, sourceFingerprint });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(waveform, null, 2)}\n`);
  return waveform;
}

async function renderFootageWaveform({ footage, ffmpegBin, sourceFingerprint }) {
  const peaks = await extractFootageWaveformPeaks({ footagePath: footage.path, ffmpegBin });
  return {
    version: WAVEFORM_CACHE_VERSION,
    footageId: footage.id,
    sourceFingerprint,
    duration: Number(footage.duration) || peaks.length / WAVEFORM_BARS_PER_SECOND,
    barsPerSecond: WAVEFORM_BARS_PER_SECOND,
    peaks,
  };
}

function extractFootageWaveformPeaks({ footagePath, ffmpegBin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-nostats",
        "-i",
        footagePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(WAVEFORM_SAMPLE_RATE),
        "-f",
        "f32le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const samplesPerPeak = Math.max(1, Math.round(WAVEFORM_SAMPLE_RATE / WAVEFORM_BARS_PER_SECOND));
    const peaks = [];
    let currentPeak = 0;
    let currentSamples = 0;
    let leftover = Buffer.alloc(0);
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const buffer = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      const readableBytes = buffer.length - (buffer.length % 4);
      for (let offset = 0; offset < readableBytes; offset += 4) {
        currentPeak = Math.max(currentPeak, Math.abs(buffer.readFloatLE(offset)) || 0);
        currentSamples += 1;
        if (currentSamples >= samplesPerPeak) {
          peaks.push(currentPeak);
          currentPeak = 0;
          currentSamples = 0;
        }
      }
      leftover = buffer.subarray(readableBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      if (currentSamples > 0) {
        peaks.push(currentPeak);
      }
      resolve(normalizePeaks(peaks));
    });
  });
}

function isCurrentWaveformCache(cache, { footage, sourceFingerprint }) {
  return (
    cache?.version === WAVEFORM_CACHE_VERSION &&
    cache.footageId === footage.id &&
    cache.sourceFingerprint === sourceFingerprint &&
    cache.barsPerSecond === WAVEFORM_BARS_PER_SECOND &&
    Array.isArray(cache.peaks)
  );
}

async function readWaveformCache(cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function getFootageWaveformCachePath(projectDir, footage) {
  const filename = String(footage.id || "footage").replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(path.resolve(projectDir), "waveforms", `${filename}.json`);
}

function normalizePeaks(peaks) {
  let maxPeak = 0;
  for (const peak of peaks) {
    maxPeak = Math.max(maxPeak, Number(peak) || 0);
  }
  if (maxPeak <= 0) {
    return peaks.map(() => 0);
  }
  return peaks.map((peak) => roundPeak(Math.max(0, Math.min(Number(peak) / maxPeak, 1))));
}

function requireBarCount(bars) {
  const barCount = Number(bars);
  if (!Number.isInteger(barCount) || barCount <= 0) {
    throw new Error("waveform bars must be a positive integer");
  }
  return barCount;
}

function roundPeak(value) {
  return Math.round(value * 10000) / 10000;
}
