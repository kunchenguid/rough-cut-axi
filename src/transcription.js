import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readElevenLabsApiKey } from "./auth-store.js";
import { fingerprintFootage, writeTimelineExport } from "./project-store.js";
import { ensureFootageWaveformCache } from "./waveform.js";

export async function transcribeProject({ config, projectDir }) {
  const resolvedProjectDir = path.resolve(projectDir);
  const projectPath = path.join(resolvedProjectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const written = [];
  const cached = [];
  const indexedTranscripts = [];
  const totalFootages = (project.footages || []).length;

  project.transcription = {
    status: "running",
    totalFootages,
    completedFootages: 0,
    currentFootageId: "",
    startedAt: new Date().toISOString(),
  };
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

  try {
    for (const footage of project.footages || []) {
      project.transcription.currentFootageId = footage.id;
      await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

      const transcriptPath = footage.transcriptPath || `transcripts/${footage.id}.json`;
      const destinationPath = path.join(resolvedProjectDir, transcriptPath);
      const currentFingerprint = await fingerprintFootage(footage.path);

      if (footage.footageFingerprint === currentFingerprint && (await fileExists(destinationPath))) {
        const transcript = await repairTranscriptForFootage({
          config,
          footage,
          transcript: JSON.parse(await readFile(destinationPath, "utf8")),
        });
        if (transcript.repaired) {
          await writeFile(destinationPath, `${JSON.stringify(transcript.value, null, 2)}\n`);
        }
        cached.push({ footageId: footage.id, transcriptPath });
        indexedTranscripts.push({ footage, transcript: transcript.value });
        project.transcription.completedFootages += 1;
        await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
        continue;
      }

      const transcript = await repairTranscriptForFootage({
        config,
        footage,
        transcript: config.elevenLabsFixtureDir
          ? await readFixtureTranscript({ config, footage })
          : await requestElevenLabsTranscript({ config, footage }),
      });

      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, `${JSON.stringify(transcript.value, null, 2)}\n`);
      footage.footageFingerprint = currentFingerprint;
      written.push({ footageId: footage.id, transcriptPath });
      indexedTranscripts.push({ footage, transcript: transcript.value });
      project.transcription.completedFootages += 1;
      await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    }
  } catch (error) {
    project.transcription = {
      ...project.transcription,
      status: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
    };
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    throw error;
  }

  const transcriptIndexPath = path.join(resolvedProjectDir, "transcript_index.md");
  const packedTranscriptPath = path.join(resolvedProjectDir, "takes_packed.md");
  await writeFile(transcriptIndexPath, buildTranscriptIndex(indexedTranscripts));
  await writeFile(packedTranscriptPath, buildPackedTranscript(indexedTranscripts));

  const passagesByFootageId = buildTranscriptPassages(indexedTranscripts, project.footages || []);
  project.footages = (project.footages || []).map((footage) => ({
    ...footage,
    passages: passagesByFootageId.get(footage.id) || footage.passages || [],
  }));
  await precacheFootageWaveforms({ config, projectDir: resolvedProjectDir, footages: project.footages });
  project.transcription = {
    ...project.transcription,
    status: "completed",
    completedFootages: totalFootages,
    currentFootageId: "",
    written: written.length,
    cached: cached.length,
    transcriptIndexPath,
    packedTranscriptPath,
    completedAt: new Date().toISOString(),
  };
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  await writeTimelineExport(resolvedProjectDir, project);

  return {
    projectId: path.basename(resolvedProjectDir),
    written,
    cached,
    transcriptIndexPath,
    packedTranscriptPath,
    transcription: project.transcription,
  };
}

async function precacheFootageWaveforms({ config, projectDir, footages }) {
  await Promise.all(
    (footages || []).map(async (footage) => {
      try {
        await ensureFootageWaveformCache({ projectDir, footage, ffmpegBin: config.ffmpegBin || "ffmpeg" });
      } catch (_error) {
        // Waveforms improve the editor but should not make transcription fail.
      }
    }),
  );
}

export function buildTranscriptPassages(indexedTranscripts, existingFootages = []) {
  const existingPassages = existingFootages.flatMap((footage) =>
    (footage.passages || []).map((passage) => ({ ...passage, footageId: footage.id })),
  );
  const existingPassagesById = new Map(existingPassages.map((passage) => [passage.id, passage]));
  const hasExistingPassages = existingPassages.length > 0;
  const passagesByFootageId = new Map();

  for (const { footage, transcript } of indexedTranscripts) {
    const phrases = groupTranscriptPhrases({
      words: transcript.words || [],
      confidence: transcript.languageConfidence ?? null,
      splitOnSentenceEnd: true,
      includePauses: true,
      startBufferSeconds: PASSAGE_START_BUFFER_SECONDS,
      endBufferSeconds: PASSAGE_END_BUFFER_SECONDS,
      leadingPauseSeconds: PASSAGE_LEADING_PAUSE_SECONDS,
      silences: transcript.audioSilences || transcript.silences || [],
    });

    const phraseMatches = phrases.map((phrase, index) => {
      const id = `passage_${footage.id}_${String(index + 1).padStart(4, "0")}`;
      return {
        id,
        phrase,
        existingPassage: findExistingPassageForPhrase({
          existingPassages,
          existingPassagesById,
          id,
          phrase,
          footageId: footage.id,
        }),
      };
    });

    passagesByFootageId.set(
      footage.id,
      phraseMatches.map(({ id, phrase, existingPassage }, index) => {
        const withinFootageDuration =
          !Number.isFinite(footage.duration) || Number(phrase.start) < Number(footage.duration);
        const keepLeadingPause = shouldKeepLeadingPause({ phraseMatches, index, hasExistingPassages });
        const shouldSkip =
          existingPassage?.status === "skip" ||
          !withinFootageDuration ||
          (!keepLeadingPause && !existingPassage && hasExistingPassages);
        return {
          id,
          start: roundTime(phrase.start),
          end: roundTime(phrase.end),
          speaker: phrase.speaker,
          text: phrase.text,
          status: shouldSkip ? "skip" : existingPassage?.status || "keep",
          reason:
            existingPassage?.reason ||
            (withinFootageDuration
              ? keepLeadingPause
                ? "Kept as first-word lead-in."
                : hasExistingPassages
                  ? "Skipped because it is outside the existing cut."
                  : "Default keep after transcription."
              : "Skipped because it starts past footage duration."),
        };
      }),
    );
  }

  return passagesByFootageId;
}

function shouldKeepLeadingPause({ phraseMatches, index, hasExistingPassages }) {
  if (!phraseMatches[index]?.phrase?.leadingPause) {
    return false;
  }
  if (!hasExistingPassages) {
    return true;
  }

  const nextSpokenMatch = phraseMatches.slice(index + 1).find(({ phrase }) => !isPausePhrase(phrase));
  return Boolean(nextSpokenMatch?.existingPassage && nextSpokenMatch.existingPassage.status !== "skip");
}

function isPausePhrase(phrase) {
  return phrase?.speaker === "pause";
}

function findExistingPassageForPhrase({ existingPassages, existingPassagesById, id, phrase, footageId }) {
  const existingPassage = existingPassagesById.get(id);
  if (existingPassage?.footageId === footageId && rangesMatch(existingPassage, phrase)) {
    return existingPassage;
  }

  const containingPassage = existingPassages
    .filter((passage) => passage?.footageId === footageId && rangeContains(passage, phrase))
    .sort((left, right) => Number(left.end) - Number(left.start) - (Number(right.end) - Number(right.start)))[0];
  if (containingPassage) {
    return containingPassage;
  }
  if (isPausePhrase(phrase)) {
    return null;
  }

  // Removing the word cap can merge old chunks; skip wins to avoid reintroducing rejected material.
  return findOverlappingExistingPassageForPhrase({ existingPassages, phrase, footageId });
}

function findOverlappingExistingPassageForPhrase({ existingPassages, phrase, footageId }) {
  const overlappingPassages = existingPassages
    .filter((passage) => passage?.footageId === footageId && rangesOverlap(passage, phrase))
    .sort((left, right) => Number(left.start) - Number(right.start));
  const statusCandidates = overlappingPassages.filter((passage) => !isPausePhrase(passage));
  if (statusCandidates.length === 0) {
    return null;
  }

  return (
    statusCandidates.find((passage) => passage.status === "skip") ||
    statusCandidates.find((passage) => passage.status === "active") ||
    statusCandidates[0]
  );
}

function rangesOverlap(left, right) {
  return (
    Number(left.start) < roundTime(comparisonEnd(right)) - 0.02 &&
    Number(left.end) > roundTime(comparisonStart(right)) + 0.02
  );
}

function rangesMatch(left, right) {
  return timeMatches(left.start, comparisonStart(right)) && timeMatches(left.end, comparisonEnd(right));
}

function rangeContains(container, phrase) {
  return (
    Number(container.start) <= roundTime(comparisonStart(phrase)) + 0.02 &&
    Number(container.end) >= roundTime(comparisonEnd(phrase)) - 0.02
  );
}

function comparisonStart(phrase) {
  return phrase.sourceStart ?? phrase.start;
}

function comparisonEnd(phrase) {
  return phrase.sourceEnd ?? phrase.end;
}

function timeMatches(left, right) {
  return Math.abs(Number(left) - roundTime(right)) <= 0.02;
}

async function readFixtureTranscript({ config, footage }) {
  const fixtureName = fixtureNameForFootage(footage.name || footage.path || footage.id);
  return JSON.parse(await readFile(path.join(config.elevenLabsFixtureDir, fixtureName), "utf8"));
}

async function requestElevenLabsTranscript({ config, footage }) {
  const apiKey = await readElevenLabsApiKey({ config });
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-transcribe-"));
  try {
    const audioPath = path.join(tempDir, `${audioStemForFootage(footage)}.wav`);
    await extractAudio({ config, footage, audioPath });
    const requestBody = await buildElevenLabsRequestBody({ filePath: audioPath });

    const response = await fetch(`${config.elevenLabsApiUrl.replace(/\/$/, "")}/v1/speech-to-text`, {
      method: "POST",
      headers: {
        "content-length": String(requestBody.contentLength),
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
        "xi-api-key": apiKey,
      },
      body: requestBody.body,
      duplex: "half",
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs transcription failed with HTTP ${response.status}`);
    }

    return normalizeElevenLabsTranscript({ footage, response: await response.json() });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

const MULTIPART_BOUNDARY = "rough-cut-axi-elevenlabs-boundary";

async function extractAudio({ config, footage, audioPath }) {
  await runCommand(config.ffmpegBin || "ffmpeg", [
    "-y",
    "-i",
    footage.path,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (buffer) => {
      stderr += buffer;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function runCommandStderr(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (buffer) => {
      stderr += buffer;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }

      reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function buildElevenLabsRequestBody({ filePath }) {
  const fileName = path.basename(filePath);
  const fileStats = await stat(filePath);
  const textParts = [
    textPart("model_id", "scribe_v2"),
    textPart("timestamps_granularity", "word"),
    textPart("diarize", "true"),
    textPart("tag_audio_events", "true"),
  ];
  const fileHeader = Buffer.from(
    `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${escapeHeaderValue(fileName)}"\r\nContent-Type: audio/wav\r\n\r\n`,
    "utf8",
  );
  const fileFooter = Buffer.from("\r\n", "utf8");
  const closingBoundary = Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`, "utf8");
  const contentLength =
    textParts.reduce((total, part) => total + part.length, 0) +
    fileHeader.length +
    fileStats.size +
    fileFooter.length +
    closingBoundary.length;

  return {
    body: multipartBody({ textParts, fileHeader, filePath, fileFooter, closingBoundary }),
    contentLength,
  };
}

async function* multipartBody({ textParts, fileHeader, filePath, fileFooter, closingBoundary }) {
  for (const part of textParts) {
    yield part;
  }
  yield fileHeader;
  for await (const buffer of createReadStream(filePath)) {
    yield buffer;
  }
  yield fileFooter;
  yield closingBoundary;
}

function textPart(name, value) {
  return Buffer.from(
    `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8",
  );
}

function escapeHeaderValue(value) {
  return String(value).replaceAll('"', "");
}

function audioStemForFootage(footage) {
  const name = path.basename(footage.name || footage.path || footage.id || "footage");
  const extension = path.extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

export function normalizeElevenLabsTranscript({ footage, response }) {
  const words = (response.words || [])
    .filter((word) => word.type !== "spacing" && word.start != null && word.end != null)
    .map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      speaker: word.speaker_id || "speaker_1",
      type: word.type || "word",
      confidence: confidenceFromLogprob(word.logprob),
    }));

  return {
    provider: "elevenlabs",
    footageFilename: path.basename(footage.path),
    languageCode: response.language_code || "",
    languageConfidence: response.language_probability ?? null,
    text: response.text || words.map((word) => word.text).join(" "),
    segments: groupTranscriptPhrases({ words, confidence: response.language_probability ?? null }),
    words,
  };
}

async function repairTranscriptForFootage({ config, footage, transcript }) {
  const segmentRepair = repairTranscriptSegments(transcript);
  const hasCurrentAudioSilences =
    Array.isArray(segmentRepair.value.audioSilences) &&
    audioSilenceSettingsMatch(segmentRepair.value.audioSilenceSettings);
  const audioSilences = hasCurrentAudioSilences
    ? segmentRepair.value.audioSilences
    : await detectAudioSilences({ audioPath: footage.path, ffmpegBin: config.ffmpegBin || "ffmpeg" }).catch(() => []);
  const timingRepair = await repairGluedSentenceWordTimings({
    audioPath: footage.path,
    ffmpegBin: config.ffmpegBin || "ffmpeg",
    words: segmentRepair.value.words || [],
    audioSilences,
  });

  const value = {
    ...segmentRepair.value,
    audioSilences,
    audioSilenceSettings: currentAudioSilenceSettings(),
    words: timingRepair.words,
    segments: timingRepair.repaired
      ? groupTranscriptPhrases({
          words: timingRepair.words,
          confidence: segmentRepair.value.languageConfidence ?? null,
        })
      : segmentRepair.value.segments,
  };

  return {
    value,
    repaired: segmentRepair.repaired || timingRepair.repaired || !hasCurrentAudioSilences,
  };
}

function currentAudioSilenceSettings() {
  return { noiseDb: AUDIO_SILENCE_NOISE_DB, minSeconds: AUDIO_SILENCE_MIN_SECONDS };
}

function audioSilenceSettingsMatch(settings) {
  return (
    Number(settings?.noiseDb) === AUDIO_SILENCE_NOISE_DB && Number(settings?.minSeconds) === AUDIO_SILENCE_MIN_SECONDS
  );
}

export async function repairGluedSentenceWordTimings({ words, audioPath, ffmpegBin = "ffmpeg", audioSilences = [] }) {
  if (!audioPath && audioSilences.length === 0) {
    return { words, repaired: false };
  }

  const repairedWords = [];
  let repaired = false;
  for (const word of words) {
    const parts = splitGluedSentenceText(word);
    if (!shouldRepairGluedSentenceWordWithAudio(word, parts)) {
      repairedWords.push(word);
      continue;
    }

    const silence = await findSilenceInsideWord({ audioPath, ffmpegBin, word, audioSilences }).catch(() => null);
    if (!silence) {
      repairedWords.push(word);
      continue;
    }

    repairedWords.push(
      { ...word, text: parts[0], end: roundMilliseconds(silence.start) },
      { ...word, text: parts[1], start: roundMilliseconds(silence.end) },
    );
    repaired = true;
  }

  return { words: repairedWords, repaired };
}

function shouldRepairGluedSentenceWordWithAudio(word, parts) {
  return parts.length === 2 && Number(word.end) - Number(word.start) >= GLUED_SENTENCE_AUDIO_REPAIR_MIN_SECONDS;
}

async function findSilenceInsideWord({ audioPath, ffmpegBin, word, audioSilences = [] }) {
  const wordStart = Number(word.start);
  const wordEnd = Number(word.end);
  if (audioSilences.length > 0) {
    return bestSilenceInsideRange({ start: wordStart, end: wordEnd, silences: audioSilences });
  }

  const scanStart = Math.max(0, wordStart - GLUED_SENTENCE_REPAIR_SCAN_PADDING_SECONDS);
  const scanEnd = wordEnd + GLUED_SENTENCE_REPAIR_SCAN_PADDING_SECONDS;
  const stderr = await runCommandStderr(ffmpegBin, [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(scanStart),
    "-t",
    String(scanEnd - scanStart),
    "-i",
    audioPath,
    "-vn",
    "-af",
    `silencedetect=noise=${AUDIO_SILENCE_NOISE_DB}dB:d=${AUDIO_SILENCE_MIN_SECONDS}`,
    "-f",
    "null",
    "-",
  ]);
  return bestSilenceInsideRange({
    start: wordStart,
    end: wordEnd,
    silences: parseSilencedetectOutput(stderr, scanStart),
  });
}

function bestSilenceInsideRange({ start, end, silences }) {
  const candidates = silences
    .map((silence) => ({
      start: Math.max(Number(silence.start), start),
      end: Math.min(Number(silence.end), end),
    }))
    .map((silence) => ({ ...silence, duration: silence.end - silence.start }))
    .filter((silence) => silence.duration >= 0.3 && silence.start > start + 0.05 && silence.end < end - 0.05)
    .sort((left, right) => right.duration - left.duration);

  return candidates[0] || null;
}

async function detectAudioSilences({ audioPath, ffmpegBin = "ffmpeg" }) {
  if (!audioPath) {
    return [];
  }

  const stderr = await runCommandStderr(ffmpegBin, [
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-vn",
    "-af",
    `silencedetect=noise=${AUDIO_SILENCE_NOISE_DB}dB:d=${AUDIO_SILENCE_MIN_SECONDS}`,
    "-f",
    "null",
    "-",
  ]);

  return parseSilencedetectOutput(stderr, 0).map((silence) => ({
    start: roundMilliseconds(silence.start),
    end: roundMilliseconds(silence.end),
    duration: roundMilliseconds(silence.duration),
  }));
}

function parseSilencedetectOutput(output, offset) {
  const silences = [];
  let current = null;
  for (const line of String(output || "").split("\n")) {
    const start = line.match(/silence_start: ([0-9.]+)/);
    if (start) {
      current = { start: offset + Number(start[1]) };
      continue;
    }

    const end = line.match(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/);
    if (end && current) {
      silences.push({ ...current, end: offset + Number(end[1]), duration: Number(end[2]) });
      current = null;
    }
  }

  return silences;
}

function splitGluedSentenceText(word) {
  if (!isPhraseWord(word)) {
    return [String(word?.text || "")];
  }

  const text = String(word.text || "");
  const parts = text.split(/(?<=[.!?])(?=[A-Za-z])/);
  return parts.length > 1 && parts.every((part) => part.length > 0) ? parts : [text];
}

const PHRASE_GAP_SECONDS = 0.5;
const PASSAGE_START_BUFFER_SECONDS = 0.08;
const PASSAGE_END_BUFFER_SECONDS = 0.08;
const PASSAGE_LEADING_PAUSE_SECONDS = 0.5;
const GLUED_SENTENCE_AUDIO_REPAIR_MIN_SECONDS = 2;
const GLUED_SENTENCE_REPAIR_SCAN_PADDING_SECONDS = 0.6;
const AUDIO_SILENCE_MIN_SECONDS = 0.1;
const AUDIO_SILENCE_NOISE_DB = -45;

function groupTranscriptPhrases({
  words,
  confidence,
  splitOnSentenceEnd = false,
  includePauses = false,
  startBufferSeconds = 0,
  endBufferSeconds = 0,
  leadingPauseSeconds = 0,
  silences = [],
}) {
  const phrases = [];
  let currentWords = [];
  let currentStart = null;
  let previousBoundaryEnd = null;

  const flushPhrase = () => {
    if (currentWords.length === 0) {
      return;
    }

    const phrase = phraseFromWords(currentWords, confidence);
    const nextPhrase = { ...phrase, start: currentStart ?? phrase.start };
    if (nextPhrase.start !== phrase.start) {
      nextPhrase.sourceStart = phrase.start;
      nextPhrase.sourceEnd = phrase.end;
    }
    phrases.push(nextPhrase);
    previousBoundaryEnd = phrase.end;
    currentWords = [];
    currentStart = null;
  };

  const startPhrase = (word) => {
    const wordStart = Number(word.start);
    if (includePauses && previousBoundaryEnd == null && leadingPauseSeconds > 0 && wordStart >= leadingPauseSeconds) {
      appendPausePhrase({
        start: wordStart - leadingPauseSeconds,
        end: wordStart,
        confidence,
        phrases,
        leadingPause: true,
      });
      currentStart = wordStart;
      return;
    }

    const bufferedStart = Math.max(0, Number(word.start) - startBufferSeconds);
    const phraseStart = previousBoundaryEnd == null ? bufferedStart : Math.max(previousBoundaryEnd, bufferedStart);
    if (
      includePauses &&
      previousBoundaryEnd != null &&
      Number(word.start) - previousBoundaryEnd >= PHRASE_GAP_SECONDS
    ) {
      appendPausePhrase({ start: previousBoundaryEnd, end: phraseStart, confidence, phrases });
    }
    currentStart = phraseStart;
  };

  for (const word of words.flatMap(splitGluedSentenceWord)) {
    if (!isPhraseWord(word)) {
      continue;
    }

    if (isStandaloneAudioEvent(word)) {
      flushPhrase();
      startPhrase(word);
      currentWords.push(word);
      flushPhrase();
      continue;
    }

    const previousWord = currentWords.at(-1);
    if (
      previousWord &&
      (speakerForWord(word) !== speakerForWord(previousWord) || word.start - previousWord.end >= PHRASE_GAP_SECONDS)
    ) {
      flushPhrase();
    }

    if (currentWords.length === 0) {
      startPhrase(word);
    }
    currentWords.push(word);

    if (splitOnSentenceEnd && isSentenceEnd(word)) {
      flushPhrase();
    }
  }

  flushPhrase();

  if (includePauses && (silences.length > 0 || endBufferSeconds > 0)) {
    return repairPhraseBoundaries({ phrases, silences, startBufferSeconds, endBufferSeconds });
  }

  return phrases;
}

function repairPhraseBoundaries({ phrases, silences, startBufferSeconds, endBufferSeconds }) {
  const speechPhrases = [];
  const leadingPauses = [];

  for (const phrase of phrases) {
    if (isPausePhrase(phrase)) {
      if (phrase.leadingPause && speechPhrases.length === 0) {
        leadingPauses.push(phrase);
      }
      continue;
    }

    speechPhrases.push(phrase);
  }

  const repairedPhrases = speechPhrases.map((phrase, index) =>
    repairSpeechPhraseBoundaries({
      phrase,
      silences,
      startBufferSeconds,
      endBufferSeconds,
      nextSourceStart: speechPhrases[index + 1] ? comparisonStart(speechPhrases[index + 1]) : null,
    }),
  );

  const rebuilt = [];
  let previousBoundaryEnd = null;
  for (const pause of leadingPauses) {
    rebuilt.push(pause);
    previousBoundaryEnd = pause.end;
  }

  for (const repairedPhrase of repairedPhrases) {
    const phrase =
      previousBoundaryEnd != null && Number(repairedPhrase.start) < previousBoundaryEnd
        ? { ...repairedPhrase, start: previousBoundaryEnd, sourceStart: comparisonStart(repairedPhrase) }
        : repairedPhrase;
    if (
      previousBoundaryEnd != null &&
      phrase.start - previousBoundaryEnd >= pauseDisplayThreshold(startBufferSeconds, endBufferSeconds)
    ) {
      appendPausePhrase({
        start: previousBoundaryEnd,
        end: phrase.start,
        confidence: phrase.confidence,
        phrases: rebuilt,
      });
    }
    rebuilt.push(phrase);
    previousBoundaryEnd = phrase.end;
  }

  return rebuilt;
}

function repairSpeechPhraseBoundaries({ phrase, silences, startBufferSeconds, endBufferSeconds, nextSourceStart }) {
  const sourceStart = comparisonStart(phrase);
  const sourceEnd = comparisonEnd(phrase);
  let start = phrase.start;
  let end = Number(phrase.end) + endBufferSeconds;

  const leadingSilence = silences.find(
    (silence) =>
      Number(silence.start) <= sourceStart + 0.02 &&
      Number(silence.end) > sourceStart + 0.05 &&
      Number(silence.end) < sourceEnd - 0.05,
  );
  if (leadingSilence) {
    start = Math.max(start, Number(leadingSilence.end) - startBufferSeconds);
  }

  const trailingSilence = silences.find(
    (silence) =>
      Number(silence.start) > sourceStart + 0.05 &&
      Number(silence.start) < sourceEnd - 0.05 &&
      Number(silence.end) >= sourceEnd - 0.02,
  );
  if (trailingSilence) {
    end = Math.min(end, Number(trailingSilence.start) + endBufferSeconds);
  }

  if (Number.isFinite(nextSourceStart)) {
    end = Math.min(end, Number(nextSourceStart));
  }

  if (roundTime(end) <= roundTime(start)) {
    return phrase;
  }

  return {
    ...phrase,
    start,
    end,
    ...(start !== sourceStart ? { sourceStart } : {}),
    ...(end !== sourceEnd ? { sourceEnd } : {}),
  };
}

function pauseDisplayThreshold(startBufferSeconds, endBufferSeconds) {
  return Math.max(0.1, PHRASE_GAP_SECONDS - startBufferSeconds - endBufferSeconds - 0.02);
}

function appendPausePhrase({ start, end, confidence, phrases, leadingPause = false }) {
  if (roundTime(end) <= roundTime(start)) {
    return;
  }

  phrases.push({
    start,
    end,
    speaker: "pause",
    text: `[pause ${formatPauseDuration(end - start)}]`,
    confidence,
    leadingPause,
  });
}

function formatPauseDuration(duration) {
  return `${Number(duration).toFixed(1)}s`;
}

function phraseFromWords(words, confidence) {
  return {
    start: words[0].start,
    end: words.at(-1).end,
    speaker: speakerForWord(words[0]),
    text: words.map((word) => word.text).join(" "),
    confidence,
  };
}

function isPhraseWord(word) {
  return (
    (word.type === "word" || word.type === "filler" || word.type === "audio_event") &&
    Number.isFinite(word.start) &&
    Number.isFinite(word.end) &&
    roundTime(word.end) > roundTime(word.start)
  );
}

function isStandaloneAudioEvent(word) {
  return word.type === "audio_event" || /^(?:\[[^\]]+\]\s*)+$/.test(String(word.text || "").trim());
}

function isSentenceEnd(word) {
  return /[.!?]["')\]]*$/.test(String(word.text || ""));
}

function splitGluedSentenceWord(word) {
  if (!isPhraseWord(word)) {
    return [word];
  }

  const text = String(word.text || "");
  const parts = splitGluedSentenceText(word);
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return [word];
  }

  const start = Number(word.start);
  const duration = Number(word.end) - start;
  let cursor = start;
  return parts.map((part, index) => {
    const partDuration =
      index === parts.length - 1 ? Number(word.end) - cursor : duration * (part.length / text.length);
    const partStart = cursor;
    const partEnd = index === parts.length - 1 ? Number(word.end) : cursor + partDuration;
    cursor = partEnd;
    return { ...word, text: part, start: roundTime(partStart), end: roundTime(partEnd) };
  });
}

function speakerForWord(word) {
  return word.speaker || word.speaker_id || "speaker_1";
}

function repairTranscriptSegments(transcript) {
  const segments = transcript.segments || [];
  const hasOneBlobSegment = (transcript.words || []).some(isPhraseWord) && segments.length <= 1;

  if (!hasOneBlobSegment) {
    return { value: transcript, repaired: false };
  }

  return {
    value: {
      ...transcript,
      segments: groupTranscriptPhrases({
        words: transcript.words || [],
        confidence: transcript.languageConfidence ?? segments[0]?.confidence ?? null,
      }),
    },
    repaired: true,
  };
}

export function buildPackedTranscript(indexedTranscripts) {
  const lines = [
    "# Packed transcripts",
    "",
    `Passage-level, grouped on silences >= ${PHRASE_GAP_SECONDS.toFixed(1)}s or speaker change.`,
    "Use [start-end] ranges to address passages; snap final edits to word boundaries.",
    "",
  ];

  for (const { footage, transcript } of indexedTranscripts) {
    const phrases = groupTranscriptPhrases({
      words: transcript.words || [],
      confidence: transcript.languageConfidence ?? null,
      splitOnSentenceEnd: true,
      includePauses: true,
      startBufferSeconds: PASSAGE_START_BUFFER_SECONDS,
      endBufferSeconds: PASSAGE_END_BUFFER_SECONDS,
      leadingPauseSeconds: PASSAGE_LEADING_PAUSE_SECONDS,
      silences: transcript.audioSilences || transcript.silences || [],
    });
    lines.push(`## ${footage.id}: ${footage.name} (${phrases.length} passages)`, "");
    for (const phrase of phrases) {
      lines.push(
        `- [${formatTime(phrase.start)}-${formatTime(phrase.end)}] ${formatSpeaker(phrase.speaker)}: ${phrase.text}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSpeaker(speaker) {
  const value = String(speaker || "speaker_1");
  return value.startsWith("speaker_") ? `S${value.slice("speaker_".length)}` : value;
}

function confidenceFromLogprob(logprob) {
  if (typeof logprob !== "number") {
    return null;
  }

  return Number(Math.exp(logprob).toFixed(4));
}

function fixtureNameForFootage(footageName) {
  const name = path.basename(footageName);
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;

  return `${stem}.elevenlabs.json`;
}

function buildTranscriptIndex(indexedTranscripts) {
  const lines = ["# Transcript index", ""];

  for (const { footage, transcript } of indexedTranscripts) {
    lines.push(`## ${footage.id}: ${footage.name}`, "");
    for (const segment of transcript.segments || []) {
      lines.push(`- [${formatTime(segment.start)}-${formatTime(segment.end)}] ${segment.speaker}: ${segment.text}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatTime(value) {
  return Number(value).toFixed(2);
}

function roundTime(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundMilliseconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
