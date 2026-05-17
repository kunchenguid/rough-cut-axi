const SPLIT_LEAD_IN_SECONDS = 0.08;

export function applyEditOperation(project, operation) {
  if (
    !operation ||
    typeof operation !== "object" ||
    typeof operation.type !== "string" ||
    operation.type.trim() === ""
  ) {
    throw new Error("Edit operation must be an object with a type");
  }
  if (operation.type !== operation.type.trim()) {
    throw new Error("Edit operation type must be trimmed");
  }

  switch (operation.type) {
    case "setPassageStatus":
      return updatePassage(project, operation, (passage) => ({
        ...passage,
        status: requirePassageStatus(operation.status),
        reason: getReason(operation),
      }));
    case "trimPassage":
      return updatePassage(
        project,
        operation,
        (passage) => ({
          ...passage,
          start: snapCut(operation.start, operation.wordBoundaryTimes),
          end: snapCut(operation.end, operation.wordBoundaryTimes),
        }),
        { validateFootageDuration: "when-extending" },
      );
    case "splitPassage":
      return splitPassage(project, operation);
    case "reorderFootages":
      return reorderFootages(project, operation);
    case "replacePassageRange":
      return updatePassage(project, operation, (passage) => ({
        ...passage,
        start: snapCut(operation.start, operation.wordBoundaryTimes),
        end: snapCut(operation.end, operation.wordBoundaryTimes),
        status: "active",
        reason: getReason(operation),
      }));
    case "setPassageReason":
      return updatePassage(project, operation, (passage) => ({ ...passage, reason: getReason(operation) }));
    default:
      throw new Error(`Unsupported edit operation: ${operation.type}`);
  }
}

function updatePassage(project, operation, update, options = {}) {
  const footages = requireFootages(project);
  const { footage, passage } = requirePassage(project, operation.passageId);
  const nextPassage = update(passage);
  validatePassageRange(nextPassage, footage);
  if (options.validateFootageDuration === "when-extending" && nextPassage.end > passage.end) {
    validatePassageFootageDuration(nextPassage, footage);
  } else if (options.validateFootageDuration) {
    validatePassageFootageDuration(nextPassage, footage);
  }

  const loggedOperation =
    Object.hasOwn(operation, "start") || Object.hasOwn(operation, "end")
      ? { ...operation, start: nextPassage.start, end: nextPassage.end }
      : operation;

  return withMutation(project, sanitizeOperation(loggedOperation), {
    footages: footages.map((candidate) =>
      candidate.id === footage.id
        ? {
            ...candidate,
            passages: candidate.passages.map((candidatePassage) =>
              candidatePassage.id === passage.id ? nextPassage : candidatePassage,
            ),
          }
        : candidate,
    ),
  });
}

function splitPassage(project, operation) {
  const footages = requireFootages(project);
  const { footage, passage } = requirePassage(project, operation.passageId);
  const splitAt = snapCut(operation.at, operation.wordBoundaryTimes);
  if (!Number.isFinite(splitAt)) {
    throw new Error("split point must be a finite number");
  }
  if (splitAt <= passage.start || splitAt >= passage.end) {
    throw new Error("split point must be inside the passage range");
  }
  const footageDuration = getFiniteFootageDuration(footage);
  if (footageDuration !== undefined && splitAt >= footageDuration) {
    throw new Error("split point must be before footage duration");
  }
  const splitCutAt = getSplitCutAt({ passage, splitAt });
  const splitText = splitPassageText({ passage, splitAt, transcriptWords: operation.transcriptWords });

  const nextPassage = {
    ...passage,
    id: nextPassageId(footage.passages),
    start: splitCutAt,
    text: splitText?.after ?? passage.text,
  };
  const previousPassage = {
    ...passage,
    end: splitCutAt,
    text: splitText?.before ?? passage.text,
  };

  return withMutation(project, sanitizeOperation({ ...operation, at: splitAt }), {
    footages: footages.map((candidate) => {
      if (candidate.id !== footage.id) {
        return candidate;
      }
      const nextPassages = [];
      for (const candidatePassage of candidate.passages) {
        if (candidatePassage.id === passage.id) {
          nextPassages.push(previousPassage, nextPassage);
          continue;
        }
        nextPassages.push(candidatePassage);
      }
      return { ...candidate, passages: nextPassages };
    }),
  });
}

function getSplitCutAt({ passage, splitAt }) {
  const passageStart = Number(passage.start);
  const passageEnd = Number(passage.end);
  if (!Number.isFinite(passageStart) || !Number.isFinite(passageEnd) || passageEnd <= passageStart) {
    return splitAt;
  }
  const leadIn = Math.min(SPLIT_LEAD_IN_SECONDS, Math.max(0, splitAt - passageStart) / 2);
  const cutAt = roundTime(splitAt - leadIn);
  if (cutAt <= passageStart || cutAt >= passageEnd) {
    return splitAt;
  }
  return cutAt;
}

function splitPassageText({ passage, splitAt, transcriptWords }) {
  if (!Array.isArray(transcriptWords) || transcriptWords.length === 0) {
    return null;
  }

  const passageStart = Number(passage.start);
  const passageEnd = Number(passage.end);
  const words = transcriptWords
    .map(normalizeTranscriptWord)
    .filter((word) => word && word.end > passageStart && word.start < passageEnd && word.text.trim() !== "");
  if (words.length === 0) {
    return null;
  }

  const before = [];
  const after = [];
  for (const word of words) {
    if (word.end <= splitAt) {
      before.push(word);
      continue;
    }
    if (word.start >= splitAt) {
      after.push(word);
      continue;
    }
    const midpoint = word.start + (word.end - word.start) / 2;
    if (midpoint <= splitAt) {
      before.push(word);
    } else {
      after.push(word);
    }
  }

  if (before.length === 0 || after.length === 0) {
    return null;
  }

  return {
    before: wordsToText(before),
    after: wordsToText(after),
  };
}

function normalizeTranscriptWord(word) {
  const start = Number(word?.start);
  const end = Number(word?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { text: String(word.text || ""), start, end };
}

function wordsToText(words) {
  return words
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(" ");
}

function reorderFootages(project, operation) {
  const timeline = requireTimeline(project);
  if (!Array.isArray(operation.footageIds)) {
    throw new Error("reorderFootages footageIds must be an array of footage ids");
  }
  for (const footageId of operation.footageIds) {
    if (typeof footageId !== "string" || footageId.trim() === "") {
      throw new Error("reorderFootages footageIds must contain non-empty string footage ids");
    }
    if (footageId !== footageId.trim()) {
      throw new Error("reorderFootages footageIds must contain trimmed string footage ids");
    }
    requireFootage(project, footageId);
  }
  const activeIds = timeline.toSorted();
  const requestedIds = [...operation.footageIds].toSorted();
  if (JSON.stringify(activeIds) !== JSON.stringify(requestedIds)) {
    throw new Error("reorderFootages must include each timeline footage exactly once");
  }

  return withMutation(project, operation, { timeline: [...operation.footageIds] });
}

function withMutation(project, operation, patch) {
  const operationLog = requireOperationLog(project);
  return {
    ...project,
    ...patch,
    operationLog: [...operationLog, operation],
  };
}

function requireFootages(project) {
  if (!Array.isArray(project.footages)) {
    throw new Error("Project footages must be an array of footage records");
  }
  const seen = new Set();
  for (const footage of project.footages) {
    validateFootageRecord(footage);
    if (seen.has(footage.id)) {
      throw new Error(`Duplicate footage record: ${footage.id}`);
    }
    seen.add(footage.id);
  }
  return project.footages;
}

function requireTimeline(project) {
  if (!Array.isArray(project.timeline)) {
    throw new Error("Project timeline must be an array of footage IDs");
  }
  return project.timeline;
}

function requireOperationLog(project) {
  if (!Array.isArray(project.operationLog)) {
    throw new Error("Project operationLog must be an array");
  }
  return project.operationLog;
}

function requireFootage(project, footageId) {
  if (typeof footageId !== "string" || footageId.trim() === "" || footageId !== footageId.trim()) {
    throw new Error("footageId must be a trimmed non-empty string");
  }
  const footages = requireFootages(project);
  const footage = footages.find((candidate) => candidate.id === footageId);
  if (!footage) {
    throw new Error(`Unknown footage: ${footageId}`);
  }
  return footage;
}

function requirePassage(project, passageId) {
  if (typeof passageId !== "string" || passageId.trim() === "" || passageId !== passageId.trim()) {
    throw new Error("passageId must be a trimmed non-empty string");
  }
  const matches = [];
  for (const footage of requireFootages(project)) {
    for (const passage of footage.passages) {
      if (passage.id === passageId) {
        matches.push({ footage, passage });
      }
    }
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate passage: ${passageId}`);
  }
  if (matches.length === 0) {
    throw new Error(`Unknown passage: ${passageId}`);
  }
  return matches[0];
}

function validateFootageRecord(footage) {
  if (!footage || typeof footage !== "object" || typeof footage.id !== "string" || footage.id.trim() === "") {
    throw new Error("footage record must be an object with a trimmed non-empty string id");
  }
  if (footage.id !== footage.id.trim()) {
    throw new Error("footage record id must be a trimmed non-empty string");
  }
  if (!Array.isArray(footage.passages)) {
    throw new Error(`Footage ${footage.id} passages must be an array`);
  }
  const seen = new Set();
  for (const passage of footage.passages) {
    validatePassageRecord(passage);
    if (seen.has(passage.id)) {
      throw new Error(`Duplicate passage record: ${passage.id}`);
    }
    seen.add(passage.id);
  }
}

function validatePassageRecord(passage) {
  if (!passage || typeof passage !== "object" || typeof passage.id !== "string" || passage.id.trim() === "") {
    throw new Error("passage record must be an object with a trimmed non-empty string id");
  }
  if (passage.id !== passage.id.trim()) {
    throw new Error("passage record id must be a trimmed non-empty string");
  }
  requirePassageStatus(passage.status);
}

function validatePassageRange(passage, footage) {
  if (typeof passage.start !== "number" || typeof passage.end !== "number") {
    throw new Error("passage range must use numeric start and end values");
  }
  if (!Number.isFinite(passage.start) || !Number.isFinite(passage.end) || passage.start >= passage.end) {
    throw new Error("passage start must be before end");
  }
  if (passage.start < 0) {
    throw new Error("passage start cannot be negative");
  }
  validatePassageFootageDuration(passage, footage);
}

function validatePassageFootageDuration(passage, footage) {
  const duration = getFiniteFootageDuration(footage);
  if (duration === undefined) {
    return;
  }
  if (passage.start >= duration) {
    throw new Error("passage start must be before footage duration");
  }
}

function getFiniteFootageDuration(footage) {
  if (!Object.hasOwn(footage, "duration")) {
    return undefined;
  }
  const duration = Number(footage.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid footage duration: ${footage.duration}`);
  }
  return duration;
}

function requirePassageStatus(status) {
  if (!PASSAGE_STATUSES.has(status)) {
    throw new Error("passage status must be keep, skip, or active");
  }
  return status;
}

function getReason(operation) {
  if (operation.reason === undefined) {
    return "";
  }
  if (typeof operation.reason !== "string") {
    throw new Error("reason must be a string when present");
  }
  return operation.reason;
}

function snapCut(value, wordBoundaryTimes) {
  const cut = Number(value);
  if (!Number.isFinite(cut)) {
    return cut;
  }
  if (!Array.isArray(wordBoundaryTimes) || wordBoundaryTimes.length === 0) {
    return roundTime(cut);
  }
  let nearest = cut;
  let distance = Infinity;
  for (const boundary of wordBoundaryTimes) {
    if (!Number.isFinite(boundary)) {
      continue;
    }
    const nextDistance = Math.abs(boundary - cut);
    if (nextDistance < distance) {
      nearest = boundary;
      distance = nextDistance;
    }
  }
  return roundTime(nearest);
}

function nextPassageId(passages) {
  const existing = new Set(passages.map((passage) => passage.id));
  for (let index = passages.length + 1; ; index += 1) {
    const id = `passage_${String(index).padStart(4, "0")}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function sanitizeOperation(operation) {
  const sanitized = { ...operation };
  delete sanitized.wordBoundaryTimes;
  delete sanitized.transcriptWords;
  return sanitized;
}

function roundTime(value) {
  return Math.round(Number(value) * 100) / 100;
}

const PASSAGE_STATUSES = new Set(["keep", "skip", "active"]);
