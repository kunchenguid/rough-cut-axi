import { readFileSync } from "node:fs";

const EDITOR_STYLES = readFileSync(new URL("./editor-shell.css", import.meta.url), "utf8").trimEnd();
const RENDER_PROGRESS_ESTIMATOR_SCRIPT = readFileSync(
  new URL("./render-progress-estimator.js", import.meta.url),
  "utf8",
)
  .replace(/^export /gm, "")
  .trimEnd();
const EDITOR_CLIENT_SCRIPT = readFileSync(new URL("./editor-shell-client.js", import.meta.url), "utf8").trimEnd();

export function renderEditorShell({
  projectDir = "",
  title = "Untitled project",
  footages = [],
  pendingPrompts = [],
  chatMessages = [],
  agentPresence = "waiting",
} = {}) {
  const passageCount = footages.reduce((total, footage) => total + (footage.passages || []).length, 0);
  const keptPassages = footages.flatMap((footage) =>
    (footage.passages || []).filter((passage) => passage.status !== "skip").map((passage) => ({ footage, passage })),
  );
  const keptDuration = keptPassages.reduce(
    (total, { passage }) => total + Math.max(0, Number(passage.end) - Number(passage.start)),
    0,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Rough Cut editor</title>
    <style>
${EDITOR_STYLES}
    </style>
  </head>
  <body>
    <main class="editor-shell" aria-label="Rough Cut editor" data-project-dir="${escapeHtml(projectDir)}">
      ${renderTopbar({ projectDir })}
      ${renderManuscript({ title, footages, passageCount, keptDuration, projectDir })}
      <aside class="workshop" data-region="workshop" aria-label="Workshop">
        <section class="panel" data-region="preview" aria-labelledby="preview-title">
          <div class="eyebrow" id="preview-title">Live preview</div>
          ${renderPreviewPlayer({ projectDir, keptPassages })}
          ${renderFootagesStrip({ footages, keptDuration })}
        </section>
        ${renderAgentDock({ agentPresence, pendingPrompts, chatMessages })}
      </aside>
    </main>
    ${renderRenderDialog()}
    <script>
${RENDER_PROGRESS_ESTIMATOR_SCRIPT}
${EDITOR_CLIENT_SCRIPT}
    </script>
  </body>
</html>`;
}

function renderRenderDialog() {
  return `<div class="render-dialog-backdrop" data-region="render-dialog" hidden>
      <section class="render-dialog" data-region="render-dialog-card" role="dialog" aria-modal="true" aria-labelledby="render-dialog-title"></section>
    </div>`;
}

function renderTopbar({ projectDir }) {
  const renderFinalDisabled = projectDir ? "" : " disabled";
  return `<header class="topbar" data-region="topbar">
        <div class="wordmark" aria-label="Rough Cut">
          <span>rough</span><span class="wordmark-playhead" aria-hidden="true"><svg viewBox="0 0 10 34" width="10" height="34"><polygon points="1,2 9,2 5,8" fill="var(--vermillion)"></polygon><line x1="5" y1="8" x2="5" y2="32" stroke="var(--vermillion)" stroke-width="1.25" stroke-linecap="square"></line></svg></span><span>cut</span>
        </div>
        <span class="topbar-divider" aria-hidden="true"></span>
        <span class="topbar-save"><span class="pill-dot ok" aria-hidden="true"></span>saved: local</span>
        <span class="topbar-spacer"></span>
        <span class="render-final-error" data-region="render-final-error" role="status" aria-live="polite" hidden></span>
        <button class="button sm render-final" type="button" data-action="render-final" aria-label="Render final"${renderFinalDisabled}>${renderIcon("film", 12)}Render final</button>
        <button class="button sm" type="button" data-action="end-session">${renderIcon("log-out", 12)}End session</button>
      </header>`;
}

function renderIcon(name, size = 14) {
  const paths = {
    film: '<rect x="2" y="2" width="20" height="20" rx="2"></rect><path d="M7 2v20"></path><path d="M17 2v20"></path><path d="M2 12h20"></path><path d="M2 7h5"></path><path d="M2 17h5"></path><path d="M17 17h5"></path><path d="M17 7h5"></path>',
    "log-out":
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>',
    play: '<polygon points="6 3 20 12 6 21 6 3"></polygon>',
    plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
    send: '<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>',
    "more-horizontal":
      '<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>',
  };
  return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${paths[name] || ""}</svg>`;
}

function renderManuscript({ title, footages, passageCount, keptDuration, projectDir }) {
  return `<section class="manuscript" data-region="manuscript" aria-label="Manuscript">
        <article class="page" data-region="manuscript-page">
          <header class="manuscript-head">
            <div class="eyebrow">§ Manuscript · ${footages.length} footages · ${passageCount} passages</div>
            <h1 class="title">${escapeHtml(title)}</h1>
            <div class="manuscript-runtime">cut runs ${escapeHtml(formatClock(keptDuration))}</div>
            <div class="subtle-line" aria-hidden="true"></div>
          </header>
          ${renderPassages({ footages, projectDir })}
          ${renderPassageControlBar()}
        </article>
      </section>`;
}

function renderPassages({ footages, projectDir }) {
  const hasPassages = footages.some((footage) => (footage.passages || []).length > 0);
  if (!hasPassages) {
    return `<p class="empty-page">No transcript yet. Run \`rough-cut-axi transcribe\` and the prose will fill in.</p>`;
  }

  return footages
    .map((footage, index) => {
      const divider =
        index === 0
          ? ""
          : `<div class="footage-divider"><span>§</span><span>footage ${footage.order} · ${escapeHtml(footage.label || footage.name || footage.id)}</span></div>`;
      const lines = groupPassagesBySpeaker(footage.passages || [])
        .map((line) => renderPassageLine({ footage, line, projectDir }))
        .join("\n");
      return `${divider}${lines}`;
    })
    .join("\n");
}

function groupPassagesBySpeaker(passages) {
  const lines = [];
  let currentLine;
  let pendingPauses = [];
  for (const passage of passages) {
    const speaker = passage.speaker || "speaker_1";
    if (isPausePassage(passage) && currentLine) {
      currentLine.passages.push(passage);
      continue;
    }
    if (isPausePassage(passage)) {
      pendingPauses.push(passage);
      continue;
    }

    if (!currentLine || currentLine.speaker !== speaker) {
      currentLine = { speaker, startTime: pendingPauses[0]?.start ?? passage.start, passages: pendingPauses };
      pendingPauses = [];
      lines.push(currentLine);
    }
    currentLine.passages.push(passage);
  }
  if (pendingPauses.length > 0) {
    lines.push({ speaker: "pause", startTime: pendingPauses[0].start, passages: pendingPauses });
  }
  return lines;
}

function isPausePassage(passage) {
  return passage?.speaker === "pause" || /^\[pause [^\]]+\]$/.test(String(passage?.text || ""));
}

function renderPassageLine({ footage, line, projectDir }) {
  const footageSrc =
    projectDir && footage?.id
      ? `/api/footage-media?project=${encodeURIComponent(projectDir)}&footage=${encodeURIComponent(footage.id)}`
      : "";
  return `<section class="passage-line" data-region="passage-line" data-footage-id="${escapeHtml(footage.id)}">
            <div class="passage-meta">${escapeHtml(line.speaker)}<div class="timecode">${escapeHtml(formatPassageTime(line.startTime))}</div></div>
            <div class="passage-text">${line.passages.map((passage) => renderProsePassage({ footage, passage, footageSrc })).join(" ")}</div>
            <div></div>
          </section>`;
}

function renderProsePassage({ footage, passage, footageSrc }) {
  const status = PASSAGE_STATUSES.has(passage.status) ? passage.status : "keep";
  const nextStatus = status === "skip" ? "keep" : "skip";
  return `<button class="prose-passage" type="button" data-region="prose-passage" data-action="select-passage" data-passage-id="${escapeHtml(passage.id)}" data-passage-status="${escapeHtml(status)}" data-active="${status === "active" ? "true" : "false"}" data-selected="false" data-next-status="${escapeHtml(nextStatus)}" data-passage-text="${escapeHtml(passage.text || "passage")}" data-preview-include="${status === "skip" ? "false" : "true"}" data-footage-id="${escapeHtml(footage.id)}" data-footage-src="${escapeHtml(footageSrc)}" data-start="${escapeHtml(formatTime(passage.start))}" data-end="${escapeHtml(formatTime(passage.end))}" title="${escapeHtml(`${footage.label || footage.name || footage.id} ${formatPassageTime(passage.start)}-${formatPassageTime(passage.end)} ${status}`)}" aria-label="${escapeHtml(`Select ${passage.text || "passage"}`)}">${escapeHtml(passage.text || "")}<span class="sr-only" data-region="passage-status-label"> ${escapeHtml(status)}</span><span class="sr-only" data-region="passage-reason-label"> ${escapeHtml(passage.reason || "No reason recorded.")}</span></button>`;
}

function renderPassageControlBar() {
  return `<div class="passage-control-bar" data-region="passage-control-bar" aria-label="Selected passage controls" hidden>
            <button class="passage-control-button" type="button" data-action="play-selected-passage" aria-label="Play selected passage">${renderIcon("play", 12)}<span data-region="selected-passage-play-label">Play</span></button>
            <button class="passage-control-button" type="button" data-action="set-passage-status" aria-label="Skip selected passage" disabled><span data-region="selected-passage-status-action-label">Skip</span></button>
            <button class="passage-waveform" type="button" data-region="passage-waveform" aria-label="Split selected passage">
              <span class="passage-waveform-bars" data-region="passage-waveform-bars" aria-hidden="true">${renderWaveformBars()}</span>
              <span class="passage-split-marker" data-region="passage-split-marker" aria-hidden="true"></span>
            </button>
            <button class="passage-control-close" type="button" data-action="deselect-passage" aria-label="Close selected passage controls">&times;</button>
            <video class="passage-audio-player" data-region="passage-audio-player" preload="metadata" hidden></video>
          </div>`;
}

function renderWaveformBars() {
  return Array.from(
    { length: 56 },
    () =>
      `<span class="passage-waveform-bar" data-region="passage-waveform-bar" data-waveform-value="0" data-played="false" style="--bar-height: 3px"></span>`,
  ).join("");
}

function renderPreviewPlayer({ projectDir, keptPassages }) {
  const firstSegment = keptPassages[0];
  const firstSrc = firstSegment
    ? `/api/footage-media?project=${encodeURIComponent(projectDir)}&footage=${encodeURIComponent(firstSegment.footage.id)}`
    : "";
  const duration = keptPassages.reduce(
    (total, { passage }) => total + Math.max(0, Number(passage.end) - Number(passage.start)),
    0,
  );
  const durationText = formatPreviewClock(duration);
  const activeFootageLabel = firstSegment
    ? `footage ${firstSegment.footage.order} · ${firstSegment.footage.label || firstSegment.footage.name || firstSegment.footage.id}`
    : "—";

  return `<div class="preview-frame" data-region="preview-frame">
            <video class="live-preview-player" data-region="live-preview-player" data-preview-segment-count="${keptPassages.length}" data-preview-duration="${escapeHtml(formatTime(duration))}"${firstSrc ? ` src="${escapeHtml(firstSrc)}"` : ""} preload="metadata" aria-label="Live preview"></video>
            <div class="preview-footage-label" data-region="preview-footage-label">${escapeHtml(activeFootageLabel)}</div>
            <div class="live-preview-controls" data-region="live-preview-controls" aria-label="Live preview controls">
              <button class="live-preview-toggle" type="button" data-action="toggle-live-preview" aria-label="Play live preview"${duration <= 0 ? " disabled" : ""}>${renderIcon("play", 14)}</button>
              <input class="live-preview-scrubber" data-region="live-preview-scrubber" type="range" min="0" max="${escapeHtml(formatTime(duration))}" step="0.01" value="0" aria-label="Live preview position"${duration <= 0 ? " disabled" : ""}>
              <span class="live-preview-time" data-region="live-preview-time">00:00.0 / ${escapeHtml(durationText)}</span>
            </div>
          </div>`;
}

function renderFootagesStrip({ footages, keptDuration }) {
  return `<section class="footages-strip" data-region="footages-strip" aria-label="Footages">
          <div class="strip-head">
            <div class="eyebrow">Footages · ${footages.length} in cut · ${escapeHtml(formatClock(keptDuration))}</div>
            <button class="button quiet sm" type="button" disabled>${renderIcon("plus", 12)}Add footage</button>
          </div>
          <div class="footage-cards">
            ${footages.length === 0 ? `<p class="empty-footages">No footage opened.</p>` : footages.map((footage, index) => `${renderFootageCard(footage, { active: index === 0 })}${index < footages.length - 1 ? `<span class="footage-arrow" data-region="footage-arrow">→</span>` : ""}`).join("\n")}
          </div>
        </section>`;
}

function renderFootageCard(footage, { active = false } = {}) {
  const passages = footage.passages || [];
  const kept = passages.filter((passage) => passage.status !== "skip");
  const keptDuration = kept.reduce(
    (total, passage) => total + Math.max(0, Number(passage.end) - Number(passage.start)),
    0,
  );
  return `<button class="footage-card" type="button" data-region="footage-card" data-footage-id="${escapeHtml(footage.id)}" data-action="select-footage" data-footage-order="${escapeHtml(footage.order || 1)}" data-footage-label="${escapeHtml(footage.label || footage.name || footage.id)}" data-active="${active ? "true" : "false"}">
            <div class="thumb" aria-hidden="true">
              <span class="thumb-label">${String(footage.order || 1).padStart(2, "0")}</span>
              <span class="thumb-duration">${escapeHtml(formatFootageDuration(footage.duration))}</span>
            </div>
            <div class="footage-card-body">
              <div class="footage-card-title">${escapeHtml(footage.label || footage.name || footage.id)}</div>
              <div class="footage-card-meta"><span>${kept.length}/${passages.length} kept</span><span>${escapeHtml(formatClock(keptDuration))}</span></div>
            </div>
          </button>`;
}

function renderAgentDock({ agentPresence, pendingPrompts, chatMessages }) {
  const state = ["waiting", "listening", "working"].includes(agentPresence) ? agentPresence : "waiting";
  return `<section class="agent-dock" data-region="agent-dock" aria-label="agent">
          <header class="agent-head" data-region="agent-presence" data-agent-presence-state="${escapeHtml(state)}">
            <h2 class="agent-title"><span class="presence-dot" data-state="${escapeHtml(state)}" aria-hidden="true"></span><span>agent</span><span class="agent-state" data-region="agent-presence-label">· ${escapeHtml(state)}</span></h2>
            <button class="button quiet sm" type="button" aria-label="Agent options">${renderIcon("more-horizontal", 12)}</button>
          </header>
          <div class="agent-thread" data-region="agent-thread" aria-label="Agent thread">
            ${renderChatThread(chatMessages, pendingPrompts)}
          </div>
          <form class="agent-composer" aria-label="Prompt agent">
            <textarea class="agent-input" data-region="agent-input" placeholder="Note to the agent. Tighten the intro, skip repeats, keep the first clean answer." rows="2"></textarea>
            <div class="composer-actions"><button class="button agent sm" type="button" data-action="queue-prompt">${renderIcon("send", 12)}Send</button></div>
          </form>
        </section>`;
}

function renderChatThread(chatMessages, pendingPrompts) {
  const messages = [
    ...chatMessages.map((message) => ({
      author: message.author || message.role || "message",
      body: message.body || message.text || "",
      time: message.time || "",
    })),
    ...pendingPrompts.map((prompt) => ({ author: "you", body: prompt.prompt || "", time: "queued" })),
  ];

  if (messages.length === 0) {
    return `<p class="message-body">Agent waiting for a prompt.</p>`;
  }

  return messages
    .map(
      (
        message,
      ) => `<article class="agent-message" data-region="agent-message" data-author="${escapeHtml(message.author)}">
            <div class="message-meta"><span>↳ ${escapeHtml(message.author)}</span><span>${escapeHtml(message.time)}</span></div>
            <div class="message-body">${escapeHtml(message.body)}</div>
          </article>`,
    )
    .join("\n");
}

function formatFootageDuration(duration) {
  const value = Number(duration);
  if (!Number.isFinite(value)) {
    return "00:00";
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remaining = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(1).padStart(4, "0")}`;
}

function formatPreviewClock(seconds) {
  return formatClock(seconds);
}

function formatPassageTime(value) {
  return formatClock(value);
}

function formatTime(value) {
  return Number(value).toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const PASSAGE_STATUSES = new Set(["keep", "skip", "active"]);
