import { readFile } from "node:fs/promises";
import path from "node:path";

export async function addWordBoundaryTimes(projectDir, project, operation) {
  const footage = resolveOperationFootage(project, operation);
  if (!footage?.transcriptPath) {
    return operation;
  }

  let transcript;
  try {
    transcript = JSON.parse(await readFile(path.join(projectDir, footage.transcriptPath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return operation;
    }
    throw error;
  }

  const transcriptWords = (transcript.words || []).map(normalizeTranscriptWord).filter(Boolean);
  const wordBoundaryTimes = [
    ...new Set(transcriptWords.flatMap((word) => [word.start, word.end]).filter(Number.isFinite)),
  ].sort((left, right) => left - right);

  if (wordBoundaryTimes.length === 0) {
    return operation;
  }

  return { ...operation, wordBoundaryTimes, transcriptWords };
}

function normalizeTranscriptWord(word) {
  const start = Number(word?.start);
  const end = Number(word?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return {
    text: String(word.text || ""),
    start,
    end,
    speaker: word.speaker || word.speaker_id || "",
    type: word.type || "word",
  };
}

function resolveOperationFootage(project, operation) {
  if (operation.footageId) {
    return (project.footages || []).find((footage) => footage.id === operation.footageId);
  }

  if (!operation.passageId) {
    return null;
  }

  return (project.footages || []).find((footage) =>
    (footage.passages || []).some((passage) => passage.id === operation.passageId),
  );
}
