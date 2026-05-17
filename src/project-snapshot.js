import { readFile } from "node:fs/promises";
import path from "node:path";

export function parseSnapshotRange(value) {
  const [start, end] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return null;
  }

  return { start, end };
}

export async function renderProjectSnapshot(projectDir, project, { outputRange = null } = {}) {
  const snapshot = await buildProjectSnapshot(projectDir, project, { outputRange });
  const lines = ["snapshot:", `  passages[${snapshot.passages.length}]{id,footage,start,end,status,reason,text}:`];

  if (snapshot.passages.length === 0) {
    lines.push("    <none>");
  } else {
    for (const passage of snapshot.passages) {
      lines.push(
        `    ${passage.id},${passage.footage},${formatSnapshotTime(passage.start)},${formatSnapshotTime(passage.end)},${passage.status},${passage.reason},${passage.text}`,
      );
    }
  }

  lines.push(`  nearby_transcript[${snapshot.nearbyTranscript.length}]{footage,start,end,text}:`);
  if (snapshot.nearbyTranscript.length === 0) {
    lines.push("    <none>");
  } else {
    for (const segment of snapshot.nearbyTranscript) {
      lines.push(
        `    ${segment.footage},${formatSnapshotTime(segment.start)},${formatSnapshotTime(segment.end)},${segment.text}`,
      );
    }
  }

  lines.push(`  render: ${snapshot.render.finalPath}`.trimEnd());
  return lines;
}

export async function buildProjectSnapshot(projectDir, project, { outputRange = null } = {}) {
  const footagesById = new Map((project.footages || []).map((footage) => [footage.id, footage]));
  let outputTime = 0;
  const timelinePassages = (project.timeline || [])
    .map((footageId) => footagesById.get(footageId))
    .filter(Boolean)
    .flatMap((footage) =>
      (footage.passages || []).map((passage) => {
        const status = passage.status === "skip" ? "skip" : passage.status === "active" ? "active" : "keep";
        const duration = Math.max(0, Number(passage.end) - Number(passage.start));
        const outputStart = status === "skip" ? null : outputTime;
        const outputEnd = status === "skip" ? null : outputStart + duration;
        if (status !== "skip") {
          outputTime = outputEnd;
        }
        return { ...passage, footageId: footage.id, outputStart, outputEnd, status };
      }),
    )
    .filter((passage) => {
      if (!outputRange) {
        return true;
      }
      return (
        passage.status !== "skip" && passage.outputEnd > outputRange.start && passage.outputStart < outputRange.end
      );
    })
    .map(({ outputStart: _outputStart, outputEnd: _outputEnd, ...passage }) => passage);
  const nearbyTranscript = await loadNearbyTranscript(projectDir, project, timelinePassages);
  return {
    passages: timelinePassages.map(({ footageId, ...passage }) => {
      const footage = footagesById.get(footageId);
      return {
        ...passage,
        footage: footage?.name || footageId,
      };
    }),
    nearbyTranscript: nearbyTranscript.map((segment) => ({
      footage: segment.footageName,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    })),
    render: {
      finalPath: project.render?.finalPath || "renders/final.mov",
    },
  };
}

export function summarizeTarget(target) {
  if (!target || typeof target !== "object") {
    return "none";
  }

  if (target.type === "time-range") {
    return `time-range ${target.start}-${target.end}`;
  }

  if (target.type === "transcript-range") {
    return `${target.footageId || "footage"} ${formatSnapshotTime(target.start)}-${formatSnapshotTime(target.end)}`;
  }

  return target.type || "unknown";
}

async function loadNearbyTranscript(projectDir, project, timelinePassages) {
  const footagesById = new Map((project.footages || []).map((footage) => [footage.id, footage]));
  const ranges = timelinePassages.map((passage) => ({
    footageId: passage.footageId,
    start: passage.start,
    end: passage.end,
  }));
  const nearby = [];

  for (const range of ranges) {
    const footage = footagesById.get(range.footageId);
    if (!footage?.transcriptPath) {
      continue;
    }

    let transcript;
    try {
      transcript = JSON.parse(await readFile(path.join(projectDir, footage.transcriptPath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const segment of transcript.segments || []) {
      if (Number(segment.end) < Number(range.start) || Number(segment.start) > Number(range.end)) {
        continue;
      }
      nearby.push({
        footageName: footage.name,
        start: segment.start,
        end: segment.end,
        text: segment.text,
      });
    }
  }

  return nearby.slice(0, 5);
}

function formatSnapshotTime(value) {
  return Number(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
