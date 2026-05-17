/* global CSS, EventSource, createRenderEtaEstimator, document, window */

let livePreviewBoundaryWatcher = 0;
let passageAudioBoundaryWatcher = 0;
const manuscriptScrollStorageKey = "rough-cut-axi:manuscript-scroll";
initializeManuscriptScrollRestoration();
initializePassageEditing();
initializePromptQueue();
initializeLivePreview();
initializePassageAudio();
initializeFootageSelection();
initializeRenderFinal();
initializeSessionControls();
initializeProjectEvents();

function initializeManuscriptScrollRestoration() {
  const manuscript = document.querySelector("[data-region='manuscript']");
  const savedScrollTop = takeSavedManuscriptScrollTop();
  if (!manuscript || savedScrollTop === null) return;
  window.requestAnimationFrame(() => {
    manuscript.scrollTop = Math.max(0, savedScrollTop);
  });
}

function takeSavedManuscriptScrollTop() {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  if (!projectDir) return null;
  try {
    const rawValue = window.sessionStorage.getItem(manuscriptScrollStorageKey);
    if (!rawValue) return null;
    window.sessionStorage.removeItem(manuscriptScrollStorageKey);
    const saved = JSON.parse(rawValue);
    const scrollTop = Number(saved?.scrollTop);
    if (saved?.projectDir !== projectDir || !Number.isFinite(scrollTop)) return null;
    return scrollTop;
  } catch (_error) {
    return null;
  }
}

function saveManuscriptScrollTop() {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  const manuscript = document.querySelector("[data-region='manuscript']");
  if (!projectDir || !manuscript) return;
  try {
    window.sessionStorage.setItem(
      manuscriptScrollStorageKey,
      JSON.stringify({ projectDir, scrollTop: manuscript.scrollTop }),
    );
  } catch (_error) {
    // Scroll restoration is best-effort; editing must still succeed if storage is unavailable.
  }
}

function initializePassageEditing() {
  document.addEventListener("click", async (event) => {
    const passageButton = event.target.closest("[data-action='select-passage']");
    if (passageButton) {
      event.preventDefault();
      toggleSelectedPassage(passageButton);
      return;
    }

    const playButton = event.target.closest("[data-action='play-selected-passage']");
    if (playButton) {
      event.preventDefault();
      toggleSelectedPassagePlayback();
      return;
    }

    const closeButton = event.target.closest("[data-action='deselect-passage']");
    if (closeButton) {
      event.preventDefault();
      setSelectedPassage(null);
      return;
    }

    const statusButton = event.target.closest("[data-action='set-passage-status']");
    if (!statusButton) return;
    event.preventDefault();
    await setSelectedPassageStatus(statusButton);
  });

  const waveform = document.querySelector("[data-region='passage-waveform']");
  waveform?.addEventListener("pointermove", updateSplitMarkerFromPointer);
  waveform?.addEventListener("pointerleave", () => {
    waveform.dataset.hovering = "false";
  });
  waveform?.addEventListener("click", async (event) => {
    event.preventDefault();
    await splitSelectedPassageAtRatio(getWaveformPointerRatio(event));
  });
  waveform?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    await splitSelectedPassageAtRatio(Number(waveform.dataset.hoverRatio || 0.5));
  });
}

async function setSelectedPassageStatus(button) {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  const passageId = button.dataset.passageId || getSelectedPassage()?.dataset.passageId;
  if (!projectDir || !passageId) return;
  const nextStatus = button.dataset.nextStatus;
  button.disabled = true;
  const response = await fetch("/api/edit-operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectDir,
      operation: {
        type: "setPassageStatus",
        passageId,
        status: nextStatus,
        reason: nextStatus === "keep" ? "Kept by user." : "Skipped by user.",
      },
    }),
  });
  if (!response.ok) {
    button.disabled = false;
    throw new Error(await response.text());
  }
  updatePassageStatus(passageId, nextStatus);
  syncLivePreviewSegments();
  const selectedPassage = getSelectedPassage();
  if (selectedPassage?.dataset.passageId === passageId) {
    updateSelectedPassageControls(selectedPassage);
    jumpLivePreviewToPassage(selectedPassage);
  }
}

function updatePassageStatus(passageId, status) {
  const nextStatus = status === "skip" ? "keep" : "skip";
  const passageSelector = '[data-passage-id="' + CSS.escape(passageId) + '"]';
  const reason = status === "keep" ? "Kept by user." : "Skipped by user.";
  document.querySelectorAll(passageSelector).forEach((element) => {
    element.disabled = false;
    element.dataset.passageStatus = status;
    element.dataset.nextStatus = nextStatus;
    if (element.dataset.region === "prose-passage") {
      element.dataset.previewInclude = status === "skip" ? "false" : "true";
    }
    const statusLabel = element.querySelector("[data-region='passage-status-label']");
    if (statusLabel) statusLabel.textContent = " " + status;
    const reasonLabel = element.querySelector("[data-region='passage-reason-label']");
    if (reasonLabel) reasonLabel.textContent = " " + reason;
  });
}

function toggleSelectedPassage(passage) {
  if (passage.dataset.selected === "true") {
    setSelectedPassage(null);
    return;
  }
  setSelectedPassage(passage);
  jumpLivePreviewToPassage(passage);
}

function getSelectedPassage() {
  return document.querySelector("[data-region='prose-passage'][data-selected='true']");
}

function setSelectedPassage(passage) {
  const currentPassage = getSelectedPassage();
  if (!passage || currentPassage !== passage) pauseSelectedPassageAudio();
  document.querySelectorAll("[data-region='passage-line'][data-selected='true']").forEach((line) => {
    line.dataset.selected = "false";
  });
  document.querySelectorAll("[data-region='prose-passage'][data-selected='true']").forEach((selectedPassage) => {
    selectedPassage.dataset.selected = "false";
  });
  if (!passage) {
    setActivePassage(null);
    hideSelectedPassageControls();
    return;
  }
  passage.dataset.selected = "true";
  passage.closest("[data-region='passage-line']")?.setAttribute("data-selected", "true");
  setActivePassage(passage);
  insertPassageControlBarAfterLine(passage);
  updateSelectedPassageControls(passage);
  setWaveformProgress(0);
}

function updateSelectedPassageControls(passage) {
  const toolbar = document.querySelector("[data-region='passage-control-bar']");
  if (!toolbar || !passage) return;
  toolbar.hidden = false;
  toolbar.dataset.passageId = passage.dataset.passageId;
  toolbar.dataset.start = passage.dataset.start;
  toolbar.dataset.end = passage.dataset.end;
  const statusButton = toolbar.querySelector("[data-action='set-passage-status']");
  const nextStatus = passage.dataset.passageStatus === "skip" ? "keep" : "skip";
  const actionLabel = nextStatus === "skip" ? "Skip" : "Keep";
  if (statusButton) {
    statusButton.disabled = false;
    statusButton.dataset.passageId = passage.dataset.passageId;
    statusButton.dataset.nextStatus = nextStatus;
    statusButton.setAttribute("aria-label", actionLabel + " selected passage");
    const label = statusButton.querySelector("[data-region='selected-passage-status-action-label']");
    if (label) label.textContent = actionLabel;
  }
  const playButton = toolbar.querySelector("[data-action='play-selected-passage']");
  if (playButton) playButton.disabled = !passage.dataset.footageSrc;
  const waveform = toolbar.querySelector("[data-region='passage-waveform']");
  if (waveform) {
    waveform.disabled = Number(passage.dataset.end) <= Number(passage.dataset.start);
    waveform.dataset.hoverRatio = "0.5";
    const splitMarker = waveform.querySelector("[data-region='passage-split-marker']");
    if (splitMarker) splitMarker.style.left = "50%";
  }
  updateSelectedPassagePlayControl();
  resetWaveformBars();
  loadSelectedPassageWaveform(passage).catch(() => {
    // Keep the neutral waveform if extraction is unavailable.
  });
}

function hideSelectedPassageControls() {
  const toolbar = document.querySelector("[data-region='passage-control-bar']");
  if (!toolbar) return;
  toolbar.hidden = true;
  delete toolbar.dataset.passageId;
  const statusButton = toolbar.querySelector("[data-action='set-passage-status']");
  if (statusButton) {
    statusButton.disabled = true;
    delete statusButton.dataset.passageId;
  }
  setWaveformProgress(0);
}

function insertPassageControlBarAfterLine(passage) {
  const toolbar = document.querySelector("[data-region='passage-control-bar']");
  if (!toolbar || toolbar.previousElementSibling === passage) return;
  passage.after(toolbar);
}

function setActivePassage(button, { scroll = false } = {}) {
  document.querySelectorAll("[data-region='prose-passage'][data-active='true']").forEach((passage) => {
    passage.dataset.active = "false";
  });
  if (!button) return;
  button.dataset.active = "true";
  if (scroll) button.scrollIntoView({ block: "center", inline: "nearest" });
}

function jumpLivePreviewToPassage(passage) {
  pauseLivePreviewForPassageJump();
  setActiveFootage(passage.dataset.footageId);
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player || !passage.dataset.footageSrc) return;
  const start = Number(passage.dataset.start);
  const segments = player._passagePreviewSegments || [];
  const segmentIndex = segments.findIndex((segment) => segment.passageId === passage.dataset.passageId);
  if (segmentIndex >= 0) {
    const segment = segments[segmentIndex];
    setLivePreviewSegment(segmentIndex, false, start);
    updateLivePreviewControls(segment.outputStart);
    return;
  }
  seekMediaElementToTime(player, passage.dataset.footageSrc, start);
  updateLivePreviewControls(getLivePreviewOutputTime());
}

function pauseLivePreviewForPassageJump() {
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player) return;
  player.dataset.playbackIntent = "paused";
  player.pause();
  stopLivePreviewBoundaryWatcher();
  updateLivePreviewControls();
}

function initializePassageAudio() {
  const player = document.querySelector("[data-region='passage-audio-player']");
  if (!player) return;
  player.addEventListener("play", () => {
    startPassageAudioBoundaryWatcher();
    updateSelectedPassagePlayControl();
  });
  player.addEventListener("pause", () => {
    stopPassageAudioBoundaryWatcher();
    updateSelectedPassagePlayControl();
    updateSelectedWaveformPlayback();
  });
  player.addEventListener("ended", () => {
    stopPassageAudioBoundaryWatcher();
    updateSelectedPassagePlayControl();
    updateSelectedWaveformPlayback();
  });
  player.addEventListener("timeupdate", () => {
    advancePassageAudioIfNeeded();
    updateSelectedWaveformPlayback();
  });
}

function toggleSelectedPassagePlayback() {
  const passage = getSelectedPassage();
  const player = document.querySelector("[data-region='passage-audio-player']");
  if (!passage || !player || !passage.dataset.footageSrc) return;
  if (player.dataset.passageId === passage.dataset.passageId && !player.paused) {
    pauseSelectedPassageAudio();
    return;
  }
  pauseLivePreviewForPassageJump();
  player.dataset.passageId = passage.dataset.passageId;
  player.dataset.start = passage.dataset.start;
  player.dataset.end = passage.dataset.end;
  seekMediaElementToTime(player, passage.dataset.footageSrc, Number(passage.dataset.start));
  setWaveformProgress(0);
  player
    .play()
    .then(startPassageAudioBoundaryWatcher)
    .catch(() => {
      player.pause();
      updateSelectedPassagePlayControl();
    });
  updateSelectedPassagePlayControl();
}

function pauseSelectedPassageAudio() {
  const player = document.querySelector("[data-region='passage-audio-player']");
  if (!player) return;
  player.pause();
  stopPassageAudioBoundaryWatcher();
  updateSelectedPassagePlayControl();
}

function startPassageAudioBoundaryWatcher() {
  stopPassageAudioBoundaryWatcher();
  const tick = () => {
    passageAudioBoundaryWatcher = 0;
    advancePassageAudioIfNeeded();
    updateSelectedWaveformPlayback();
    const player = document.querySelector("[data-region='passage-audio-player']");
    if (player && !player.paused) passageAudioBoundaryWatcher = window.requestAnimationFrame(tick);
  };
  passageAudioBoundaryWatcher = window.requestAnimationFrame(tick);
}

function stopPassageAudioBoundaryWatcher() {
  if (passageAudioBoundaryWatcher) {
    window.cancelAnimationFrame(passageAudioBoundaryWatcher);
    passageAudioBoundaryWatcher = 0;
  }
}

function advancePassageAudioIfNeeded() {
  const player = document.querySelector("[data-region='passage-audio-player']");
  if (!player || player.paused) return;
  const end = Number(player.dataset.end);
  if (!Number.isFinite(end) || player.currentTime < end) return;
  player.currentTime = end;
  player.pause();
}

function updateSelectedPassagePlayControl() {
  const passage = getSelectedPassage();
  const player = document.querySelector("[data-region='passage-audio-player']");
  const button = document.querySelector("[data-action='play-selected-passage']");
  if (!button) return;
  const isPlaying = Boolean(passage && player?.dataset.passageId === passage.dataset.passageId && !player.paused);
  const nextControlState = isPlaying ? "pause" : "play";
  if (button.dataset.controlState === nextControlState) return;
  button.dataset.controlState = nextControlState;
  button.innerHTML =
    renderClientIcon(nextControlState, 12) +
    '<span data-region="selected-passage-play-label">' +
    (isPlaying ? "Pause" : "Play") +
    "</span>";
  button.setAttribute("aria-label", (isPlaying ? "Pause" : "Play") + " selected passage");
}

function updateSelectedWaveformPlayback() {
  const passage = getSelectedPassage();
  const player = document.querySelector("[data-region='passage-audio-player']");
  if (!passage || !player || player.dataset.passageId !== passage.dataset.passageId) {
    setWaveformProgress(0);
    return;
  }
  const start = Number(passage.dataset.start);
  const end = Number(passage.dataset.end);
  const duration = Math.max(0, end - start);
  const progress = duration > 0 ? (player.currentTime - start) / duration : 0;
  setWaveformProgress(progress);
}

function setWaveformProgress(progress) {
  const bars = Array.from(document.querySelectorAll("[data-region='passage-waveform-bar']"));
  const clampedProgress = Math.max(0, Math.min(Number.isFinite(progress) ? progress : 0, 1));
  const playedCount = Math.floor(clampedProgress * bars.length);
  bars.forEach((bar, index) => {
    bar.dataset.played = index < playedCount ? "true" : "false";
  });
}

function resetWaveformBars() {
  renderWaveformPeaks([]);
}

async function loadSelectedPassageWaveform(passage) {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  const bars = Array.from(document.querySelectorAll("[data-region='passage-waveform-bar']"));
  if (!projectDir || !passage?.dataset.passageId || bars.length === 0) return;
  const passageId = passage.dataset.passageId;
  const response = await fetch(
    "/api/passage-waveform?project=" +
      encodeURIComponent(projectDir) +
      "&passage=" +
      encodeURIComponent(passageId) +
      "&bars=" +
      encodeURIComponent(String(bars.length)),
  ).catch(() => null);
  if (!response?.ok) return;
  const body = await response.json();
  if (getSelectedPassage()?.dataset.passageId !== passageId) return;
  renderWaveformPeaks(Array.isArray(body.peaks) ? body.peaks : []);
}

function renderWaveformPeaks(peaks) {
  const bars = Array.from(document.querySelectorAll("[data-region='passage-waveform-bar']"));
  bars.forEach((bar, index) => {
    const value = Math.max(0, Math.min(Number(peaks[index]) || 0, 1));
    bar.dataset.waveformValue = String(value);
    bar.style.setProperty("--bar-height", waveformBarHeight(value) + "px");
  });
}

function waveformBarHeight(value) {
  return Math.max(3, Math.round(3 + value * 25));
}

function updateSplitMarkerFromPointer(event) {
  const waveform = event.currentTarget;
  const ratio = getWaveformPointerRatio(event);
  waveform.dataset.hovering = "true";
  waveform.dataset.hoverRatio = ratio.toFixed(4);
  const marker = waveform.querySelector("[data-region='passage-split-marker']");
  if (marker) marker.style.left = ratio * 100 + "%";
}

function getWaveformPointerRatio(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return 0.5;
  return Math.max(0.01, Math.min((event.clientX - rect.left) / rect.width, 0.99));
}

async function splitSelectedPassageAtRatio(ratio) {
  const passage = getSelectedPassage();
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  if (!passage || !projectDir) return;
  const start = Number(passage.dataset.start);
  const end = Number(passage.dataset.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const splitRatio = Math.max(0.01, Math.min(Number.isFinite(ratio) ? ratio : 0.5, 0.99));
  const at = Number((start + (end - start) * splitRatio).toFixed(2));
  const waveform = document.querySelector("[data-region='passage-waveform']");
  if (waveform) waveform.disabled = true;
  const response = await fetch("/api/edit-operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectDir,
      operation: {
        type: "splitPassage",
        passageId: passage.dataset.passageId,
        at,
      },
    }),
  });
  if (!response.ok) {
    if (waveform) waveform.disabled = false;
    throw new Error(await response.text());
  }
  saveManuscriptScrollTop();
  window.location.reload();
}

function seekMediaElementToTime(media, src, time) {
  const absoluteSrc = new URL(src, window.location.href).href;
  const seek = () => {
    media.currentTime = time;
  };
  if (media.src !== absoluteSrc) {
    media.src = src;
    media.addEventListener("loadedmetadata", seek, { once: true });
    try {
      seek();
    } catch (_error) {
      // Some browsers reject pre-metadata seeking; loadedmetadata will retry.
    }
    media.load();
    return;
  }
  seek();
}

function initializeFootageSelection() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='select-footage']");
    if (!button) return;
    setActiveFootage(button.dataset.footageId);
  });
}

function setActiveFootage(footageId) {
  if (!footageId) return;
  document.querySelectorAll("[data-region='footage-card']").forEach((card) => {
    card.dataset.active = card.dataset.footageId === footageId ? "true" : "false";
  });
  const activeCard = document.querySelector(
    '[data-region="footage-card"][data-footage-id="' + CSS.escape(footageId) + '"]',
  );
  const label = document.querySelector("[data-region='preview-footage-label']");
  if (activeCard && label) {
    label.textContent = "footage " + activeCard.dataset.footageOrder + " · " + activeCard.dataset.footageLabel;
  }
}

function initializeRenderFinal() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='render-final']");
    if (!button) return;
    const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
    if (!projectDir) return;
    setRenderFinalError("");
    try {
      button.disabled = true;
      const response = await fetch("/api/render-settings?project=" + encodeURIComponent(projectDir));
      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }
      renderRenderDialogSetup(await response.json());
      showRenderDialog();
    } catch (error) {
      setRenderFinalError(error.message || "Render settings failed.");
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-render-dialog-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.renderDialogAction;
    if (action === "close") {
      hideRenderDialog();
      return;
    }
    if (action === "select-frame-rate") {
      setRenderDialogSetting("frameRate", Number(actionButton.dataset.value));
      return;
    }
    if (action === "select-codec") {
      setRenderDialogSetting("codec", actionButton.dataset.value);
      return;
    }
    if (action === "start" || action === "retry") {
      await startRenderFromDialog();
      return;
    }
    if (action === "open") {
      await openRenderedFile();
      return;
    }
    if (action === "copy-path") {
      await copyRenderedPath(actionButton);
    }
  });
}

const renderDialogState = {
  settings: null,
  options: null,
  summary: null,
  outputPath: "",
  sizeBytes: 0,
  startedAt: 0,
  progress: { percent: 0, outTime: 0, expectedDuration: 0 },
  etaEstimator: createRenderEtaEstimator(),
  etaEstimate: { estimating: true, roundedEtaSeconds: 0 },
  progressStream: null,
  error: "",
};

function renderRenderDialogSetup(body) {
  renderDialogState.settings = { ...body.settings };
  renderDialogState.options = body.options;
  renderDialogState.summary = body.summary;
  renderDialogState.outputPath = "";
  renderDialogState.sizeBytes = 0;
  renderDialogState.progress = { percent: 0, outTime: 0, expectedDuration: body.summary?.duration || 0 };
  renderDialogState.etaEstimator = createRenderEtaEstimator();
  renderDialogState.etaEstimate = { estimating: true, roundedEtaSeconds: 0 };
  renderDialogState.error = "";
  const card = getRenderDialogCard();
  if (!card) return;
  const meta = formatPreviewClock(body.summary?.duration || 0) + " · " + (body.summary?.footages || 0) + " footages";
  card.setAttribute("aria-labelledby", "render-dialog-title");
  card.innerHTML =
    '<div class="render-dialog-inner">' +
    '<div class="render-dialog-head"><h2 id="render-dialog-title">Final render</h2><span class="render-dialog-meta">' +
    escapeHtml(meta) +
    "</span></div>" +
    renderSegmentedField({
      label: "Frame rate",
      action: "select-frame-rate",
      selected: body.settings.frameRate,
      options: body.options.frameRates,
    }) +
    renderSegmentedField({
      label: "Codec",
      action: "select-codec",
      selected: body.settings.codec,
      options: body.options.codecs,
    }) +
    '<div class="render-dialog-footer"><span class="render-dialog-info">' +
    escapeHtml(renderSettingsInfo()) +
    '</span><div class="render-dialog-actions"><button class="button quiet sm" type="button" data-render-dialog-action="close">Cancel</button><button class="button primary sm" type="button" data-render-dialog-action="start">Start render</button></div></div>' +
    "</div>";
}

function renderSegmentedField({ label, action, selected, options }) {
  return (
    '<div class="render-dialog-field"><span class="render-dialog-field-label">' +
    escapeHtml(label) +
    '</span><div class="render-segmented">' +
    (options || [])
      .map((option) => {
        const value = String(option.value);
        const pressed = String(selected) === value ? "true" : "false";
        const disabled = option.available === false ? " disabled" : "";
        return (
          '<button class="render-segmented-button" type="button" data-render-dialog-action="' +
          escapeHtml(action) +
          '" data-value="' +
          escapeHtml(value) +
          '" aria-pressed="' +
          pressed +
          '"' +
          disabled +
          ">" +
          escapeHtml(option.label || value) +
          "</button>"
        );
      })
      .join("") +
    "</div></div>"
  );
}

function setRenderDialogSetting(key, value) {
  if (!renderDialogState.settings) return;
  renderDialogState.settings[key] = value;
  renderRenderDialogSetup({
    settings: renderDialogState.settings,
    options: renderDialogState.options,
    summary: renderDialogState.summary,
  });
}

async function startRenderFromDialog() {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  if (!projectDir || !renderDialogState.settings) return;
  const button = document.querySelector("[data-action='render-final']");
  const jobId = createRenderJobId();
  if (button) button.disabled = true;
  renderRenderDialogRendering();
  try {
    await openRenderProgressSource(jobId);
    const response = await fetch("/api/render-final", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, settings: renderDialogState.settings, jobId }),
    });
    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }
    const body = await response.json();
    renderDialogState.outputPath = body.outputPath || "";
    renderDialogState.sizeBytes = Number(body.sizeBytes || 0);
    closeRenderProgressSource();
    renderRenderDialogDone();
  } catch (error) {
    closeRenderProgressSource();
    renderDialogState.error = error.message || "Render failed.";
    renderRenderDialogFailed();
    setRenderFinalError(renderDialogState.error);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderRenderDialogRendering() {
  renderDialogState.startedAt = Date.now();
  renderDialogState.progress = {
    percent: 0,
    outTime: 0,
    expectedDuration: renderDialogState.summary?.duration || 0,
  };
  renderDialogState.etaEstimator = createRenderEtaEstimator();
  renderDialogState.etaEstimate = { estimating: true, roundedEtaSeconds: 0 };
  const card = getRenderDialogCard();
  if (!card) return;
  card.innerHTML =
    '<div class="render-dialog-inner"><div class="render-dialog-head"><h2 id="render-dialog-title">Rendering...</h2><span class="render-dialog-meta">working locally</span></div>' +
    '<div class="render-progress-wrap" data-region="render-progress-bar" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="render-progress-bg"></div><div class="render-progress-fg" data-region="render-progress-fg" style="width: 0%"></div><div class="render-progress-head" data-region="render-progress-head" style="left: 0%">' +
    renderPlayheadSvg() +
    "</div></div>" +
    '<div class="render-stages"><div class="render-stage" data-state="done"><span class="render-stage-dot">✓</span>Preparing timeline</div><div class="render-stage" data-state="active"><span class="render-stage-dot"><span class="render-stage-now"></span></span><span data-region="render-progress-label">' +
    escapeHtml(renderProgressLabel()) +
    '</span></div><div class="render-stage"><span class="render-stage-dot"></span>Verifying duration</div></div>' +
    '<div class="render-dialog-footer"><span class="render-dialog-info">encoding ' +
    escapeHtml(renderDialogState.settings.codec) +
    ", " +
    escapeHtml(String(renderDialogState.settings.frameRate)) +
    "fps · target " +
    escapeHtml(formatPreviewClock(renderDialogState.summary?.duration || 0)) +
    '</span><div class="render-dialog-actions"><button class="button quiet sm" type="button" data-render-dialog-action="close">Hide</button></div></div></div>';
}

function renderRenderDialogDone() {
  const card = getRenderDialogCard();
  if (!card) return;
  const elapsed = ((Date.now() - renderDialogState.startedAt) / 1000).toFixed(1) + "s";
  const sizeLabel = renderDialogState.sizeBytes > 0 ? formatBytes(renderDialogState.sizeBytes) : "size unknown";
  card.innerHTML =
    '<div class="render-dialog-inner"><div class="render-dialog-head"><div class="render-dialog-title-row"><span class="render-dialog-status-dot" aria-hidden="true"></span><h2 id="render-dialog-title">Rendered.</h2></div></div>' +
    '<p class="render-dialog-copy">The press run finished. File is on disk at the path below.</p>' +
    '<div class="render-file-row"><span aria-hidden="true">▱</span><span class="render-file-name" data-region="render-output-path">' +
    escapeHtml(renderDialogState.outputPath) +
    '</span><button class="render-copy-button" type="button" data-render-dialog-action="copy-path">Copy path</button></div>' +
    '<div class="render-dialog-footer"><span class="render-dialog-info" data-region="render-output-size">' +
    escapeHtml(sizeLabel + " · " + elapsed) +
    '</span><div class="render-dialog-actions"><button class="button quiet sm" type="button" data-render-dialog-action="close">Close</button><button class="button primary sm" type="button" data-render-dialog-action="open">Show in Finder</button></div></div></div>';
}

function renderRenderDialogFailed() {
  const card = getRenderDialogCard();
  if (!card) return;
  const elapsed = renderDialogState.startedAt
    ? ((Date.now() - renderDialogState.startedAt) / 1000).toFixed(1) + "s"
    : "";
  card.innerHTML =
    '<div class="render-dialog-inner"><div class="render-dialog-head"><div class="render-dialog-title-row"><span class="render-dialog-status-dot danger" aria-hidden="true"></span><h2 id="render-dialog-title">Render failed.</h2></div></div>' +
    '<p class="render-dialog-copy">ffmpeg returned a non-zero exit. Error below; the log file is on disk too.</p>' +
    '<pre class="render-dialog-error-log" data-region="render-dialog-error">' +
    escapeHtml(renderDialogState.error) +
    "</pre>" +
    '<div class="render-dialog-footer"><span class="render-dialog-info">' +
    escapeHtml(elapsed) +
    '</span><div class="render-dialog-actions"><button class="button quiet sm" type="button" data-render-dialog-action="close">Dismiss</button><button class="button sm" type="button" disabled>View log</button><button class="button primary sm" type="button" data-render-dialog-action="retry">Try again</button></div></div></div>';
}

function showRenderDialog() {
  const dialog = document.querySelector("[data-region='render-dialog']");
  if (!dialog) return;
  dialog.hidden = false;
  dialog.querySelector("button")?.focus();
}

function hideRenderDialog() {
  const dialog = document.querySelector("[data-region='render-dialog']");
  if (dialog) dialog.hidden = true;
}

function getRenderDialogCard() {
  return document.querySelector("[data-region='render-dialog-card']");
}

function renderSettingsInfo() {
  const settings = renderDialogState.settings || {};
  const extension = settings.codec === "prores" ? "mov" : "mp4";
  return "ffmpeg, locally · final." + extension;
}

function renderPlayheadSvg() {
  return '<svg viewBox="0 0 12 36" width="12" height="36" style="overflow: visible; display: block;"><polygon points="1,1 11,1 6,7" fill="currentColor"></polygon><line x1="6" y1="7" x2="6" y2="34" stroke="currentColor" stroke-width="1.25" stroke-linecap="square"></line></svg>';
}

function createRenderJobId() {
  return "render_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function openRenderProgressSource(jobId) {
  closeRenderProgressSource();
  if (typeof EventSource !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const stream = new EventSource("/api/render-final-progress?jobId=" + encodeURIComponent(jobId));
    renderDialogState.progressStream = stream;
    stream.addEventListener("render-progress", (event) => {
      try {
        updateRenderProgress(JSON.parse(event.data));
      } catch (_error) {
        // Ignore malformed progress events; the render request still owns success or failure.
      }
    });

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      stream.removeEventListener("open", settle);
      stream.removeEventListener("error", settle);
      resolve(stream);
    };
    const timer = window.setTimeout(settle, 250);
    stream.addEventListener("open", settle, { once: true });
    stream.addEventListener("error", settle, { once: true });
  });
}

function closeRenderProgressSource() {
  if (renderDialogState.progressStream) {
    renderDialogState.progressStream.close();
    renderDialogState.progressStream = null;
  }
}

function updateRenderProgress(progress) {
  const percent = clampProgressPercent(progress?.percent);
  const outTime = Math.max(0, Number(progress?.outTime) || 0);
  const expectedDuration = Math.max(0, Number(progress?.expectedDuration) || renderDialogState.summary?.duration || 0);
  renderDialogState.progress = {
    percent,
    outTime,
    expectedDuration,
    speed: typeof progress?.speed === "string" ? progress.speed : "",
  };
  renderDialogState.etaEstimate = renderDialogState.etaEstimator.update({ outTime, expectedDuration });
  const percentValue = String(Math.round(percent * 100));
  const percentStyle = percent * 100 + "%";
  const bar = document.querySelector("[data-region='render-progress-bar']");
  const fg = document.querySelector("[data-region='render-progress-fg']");
  const head = document.querySelector("[data-region='render-progress-head']");
  const label = document.querySelector("[data-region='render-progress-label']");
  if (bar) bar.setAttribute("aria-valuenow", percentValue);
  if (fg) fg.style.width = percentStyle;
  if (head) head.style.left = percentStyle;
  if (label) label.textContent = renderProgressLabel();
}

function renderProgressLabel() {
  const progress = renderDialogState.progress || {};
  const percent = clampProgressPercent(progress.percent);
  const percentLabel = Math.round(percent * 100) + "% estimated";
  const outTimeLabel = formatPreviewClock(progress.outTime || 0) + " encoded";
  return percentLabel + " · " + outTimeLabel + " · " + estimateRenderEta(percent);
}

function estimateRenderEta(percent) {
  if (percent >= 1) {
    return "ETA 00:00.0";
  }
  const estimate = renderDialogState.etaEstimate || {};
  if (!(percent > 0) || estimate.estimating) {
    return "ETA estimating";
  }
  return "ETA " + formatPreviewClock(estimate.roundedEtaSeconds || 0);
}

function clampProgressPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(percent, 1));
}

async function openRenderedFile() {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  if (!projectDir || !renderDialogState.outputPath.startsWith(projectDir + "/")) return;
  const relativePath = renderDialogState.outputPath.slice(projectDir.length + 1);
  const response = await fetch("/api/reveal-render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectDir, file: relativePath }),
  });
  if (!response.ok) {
    setRenderFinalError(await readResponseError(response));
  }
}

async function copyRenderedPath(button) {
  if (!renderDialogState.outputPath) return;
  await navigator.clipboard.writeText(renderDialogState.outputPath);
  const previousText = button.textContent || "Copy path";
  button.textContent = "✓ Copied";
  button.setAttribute("aria-label", "Copied");
  window.setTimeout(() => {
    button.textContent = previousText;
    button.setAttribute("aria-label", "Copy path");
  }, 1200);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return String(value) + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = "B";
  for (const nextUnit of units) {
    scaled /= 1024;
    unit = nextUnit;
    if (scaled < 1024) break;
  }
  return scaled.toFixed(1) + " " + unit;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readResponseError(response) {
  try {
    const body = await response.json();
    return body?.error || response.statusText || "Render failed.";
  } catch (_error) {
    return response.statusText || "Render failed.";
  }
}

function setRenderFinalError(message) {
  const error = document.querySelector("[data-region='render-final-error']");
  if (!error) return;
  const text = String(message || "").trim();
  error.textContent = text;
  error.hidden = text === "";
}

function initializePromptQueue() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='queue-prompt']");
    if (!button) return;
    const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
    const input = document.querySelector("[data-region='agent-input']");
    const prompt = input?.value || "";
    if (!projectDir || prompt.trim() === "") return;
    button.disabled = true;
    const response = await fetch("/api/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDir, prompt }),
    });
    if (response.ok) {
      input.value = "";
      window.location.reload();
      return;
    }
    button.disabled = false;
  });
}

function initializeSessionControls() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='end-session']");
    if (!button) return;
    button.disabled = true;
    await fetch("/shutdown", { method: "POST" }).catch(() => {});
  });
}

function initializeLivePreview() {
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player) return;
  player.dataset.playbackIntent = "paused";
  syncLivePreviewSegments();
  const toggle = document.querySelector("[data-action='toggle-live-preview']");
  const scrubber = document.querySelector("[data-region='live-preview-scrubber']");
  toggle?.addEventListener("click", () => toggleLivePreviewPlayback());
  scrubber?.addEventListener("input", () => {
    const outputTime = Number(scrubber.value);
    player.dataset.playbackIntent = "paused";
    player.pause();
    seekLivePreviewToOutputTime(outputTime, false);
  });
  player.addEventListener("play", () => {
    player.dataset.playbackIntent = "playing";
    ensureLivePreviewSegmentLoaded(0);
    startLivePreviewBoundaryWatcher();
    updateLivePreviewControls();
  });
  player.addEventListener("pause", () => {
    player.dataset.playbackIntent = "paused";
    stopLivePreviewBoundaryWatcher();
    updateLivePreviewControls();
  });
  player.addEventListener("ended", () => {
    player.dataset.playbackIntent = "paused";
    stopLivePreviewBoundaryWatcher();
    updateLivePreviewControls();
  });
  player.addEventListener("timeupdate", () => {
    advanceLivePreviewIfNeeded();
    updateLivePreviewControls();
  });
}

function toggleLivePreviewPlayback() {
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player) return;
  if (player.dataset.playbackIntent === "playing" || !player.paused) {
    player.dataset.playbackIntent = "paused";
    player.pause();
    updateLivePreviewControls();
    return;
  }
  player.dataset.playbackIntent = "playing";
  updateLivePreviewControls();
  const duration = Number(player.dataset.previewDuration || 0);
  if (duration > 0 && getLivePreviewOutputTime() >= duration) {
    seekLivePreviewToOutputTime(0, false);
  }
  const currentIndex = Number(player.dataset.currentSegmentIndex || 0);
  setLivePreviewSegment(Number.isFinite(currentIndex) ? currentIndex : 0, false);
  player
    .play()
    .then(startLivePreviewBoundaryWatcher)
    .catch(() => {
      player.dataset.playbackIntent = "paused";
      updateLivePreviewControls();
    });
}

function startLivePreviewBoundaryWatcher() {
  stopLivePreviewBoundaryWatcher();
  const tick = () => {
    livePreviewBoundaryWatcher = 0;
    advanceLivePreviewIfNeeded();
    updateLivePreviewControls();
    const player = document.querySelector("[data-region='live-preview-player']");
    if (player && !player.paused) livePreviewBoundaryWatcher = window.requestAnimationFrame(tick);
  };
  livePreviewBoundaryWatcher = window.requestAnimationFrame(tick);
}

function stopLivePreviewBoundaryWatcher() {
  if (livePreviewBoundaryWatcher) {
    window.cancelAnimationFrame(livePreviewBoundaryWatcher);
    livePreviewBoundaryWatcher = 0;
  }
}

function advanceLivePreviewIfNeeded() {
  const player = document.querySelector("[data-region='live-preview-player']");
  const segments = player?._passagePreviewSegments || [];
  const index = Number(player?.dataset.currentSegmentIndex || 0);
  const segment = segments[index];
  if (!player || !segment || player.currentTime < segment.end) return;
  const nextIndex = index + 1;
  if (nextIndex >= segments.length) {
    player.currentTime = segment.end;
    player.pause();
    updateLivePreviewControls();
    return;
  }
  setLivePreviewSegment(nextIndex, true);
}

function syncLivePreviewSegments() {
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player) return;
  const passages = Array.from(document.querySelectorAll("[data-region='prose-passage']"));
  const segments = passages
    .filter((passage) => passage.dataset.previewInclude === "true")
    .map((passage) => ({
      passageId: passage.dataset.passageId,
      passageOrder: passages.indexOf(passage),
      footageId: passage.dataset.footageId,
      src: passage.dataset.footageSrc,
      start: Number(passage.dataset.start),
      end: Number(passage.dataset.end),
    }))
    .filter(
      (segment) =>
        segment.passageId &&
        segment.footageId &&
        segment.src &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start,
    );
  let outputCursor = 0;
  player._passagePreviewSegments = segments.map((segment) => {
    const duration = segment.end - segment.start;
    const outputSegment = { ...segment, outputStart: outputCursor, outputEnd: outputCursor + duration };
    outputCursor += duration;
    return outputSegment;
  });
  player.dataset.previewSegmentCount = String(segments.length);
  player.dataset.previewDuration = outputCursor.toFixed(2);
  if (segments.length === 0) {
    player.removeAttribute("src");
    player.load();
    updateLivePreviewControls();
    return;
  }
  const currentIndex = Math.min(Number(player.dataset.currentSegmentIndex || 0), segments.length - 1);
  setLivePreviewSegment(Number.isFinite(currentIndex) ? currentIndex : 0, false);
  updateLivePreviewControls();
}

function ensureLivePreviewSegmentLoaded(index) {
  const player = document.querySelector("[data-region='live-preview-player']");
  if (!player || player.src) return;
  setLivePreviewSegment(index, false);
}

function setLivePreviewSegment(index, autoplay, footageTime = null) {
  const player = document.querySelector("[data-region='live-preview-player']");
  const segments = player?._passagePreviewSegments || [];
  const segment = segments[index];
  if (!player || !segment) return;
  player.dataset.currentSegmentIndex = String(index);
  setActiveFootage(segment.footageId);
  const absoluteSrc = new URL(segment.src, window.location.href).href;
  const targetTime = Number.isFinite(footageTime) ? footageTime : segment.start;
  const seek = () => {
    player.currentTime = targetTime;
    if (autoplay && player.dataset.playbackIntent === "playing") {
      player
        .play()
        .then(startLivePreviewBoundaryWatcher)
        .catch(() => {
          player.dataset.playbackIntent = "paused";
          updateLivePreviewControls();
        });
    }
  };
  if (player.src !== absoluteSrc) {
    player.src = segment.src;
    player.addEventListener("loadedmetadata", seek, { once: true });
    player.load();
    return;
  }
  if (footageTime !== null || player.currentTime < segment.start || player.currentTime >= segment.end) seek();
  updateLivePreviewControls();
}

function seekLivePreviewToOutputTime(outputTime, autoplay) {
  const player = document.querySelector("[data-region='live-preview-player']");
  const segments = player?._passagePreviewSegments || [];
  if (!player || segments.length === 0) return;
  const duration = Number(player.dataset.previewDuration || 0);
  const target = Math.max(0, Math.min(Number.isFinite(outputTime) ? outputTime : 0, duration));
  const segment =
    segments.find((candidate) => target >= candidate.outputStart && target < candidate.outputEnd) || segments.at(-1);
  const index = segments.indexOf(segment);
  const footageTime = Math.min(segment.end, segment.start + Math.max(0, target - segment.outputStart));
  setLivePreviewSegment(index, autoplay, footageTime);
  updateLivePreviewControls(target);
}

function getLivePreviewOutputTime() {
  const player = document.querySelector("[data-region='live-preview-player']");
  const segments = player?._passagePreviewSegments || [];
  const index = Number(player?.dataset.currentSegmentIndex || 0);
  const segment = segments[index];
  if (!player || !segment) return 0;
  return Math.max(
    segment.outputStart,
    Math.min(segment.outputEnd, segment.outputStart + player.currentTime - segment.start),
  );
}

function updateLivePreviewControls(outputTime = getLivePreviewOutputTime()) {
  const player = document.querySelector("[data-region='live-preview-player']");
  const toggle = document.querySelector("[data-action='toggle-live-preview']");
  const scrubber = document.querySelector("[data-region='live-preview-scrubber']");
  const time = document.querySelector("[data-region='live-preview-time']");
  const duration = Number(player?.dataset.previewDuration || 0);
  const clampedOutputTime = Math.max(0, Math.min(Number.isFinite(outputTime) ? outputTime : 0, duration));
  if (toggle && player) {
    const isPlaybackRequested = player.dataset.playbackIntent === "playing";
    const nextControlState = isPlaybackRequested ? "pause" : "play";
    if (toggle.dataset.controlState !== nextControlState) {
      toggle.dataset.controlState = nextControlState;
      toggle.innerHTML = renderClientIcon(nextControlState, 14);
      toggle.setAttribute("aria-label", (isPlaybackRequested ? "Pause" : "Play") + " live preview");
    }
    toggle.disabled = duration <= 0;
  }
  if (scrubber) {
    scrubber.max = duration.toFixed(2);
    scrubber.value = clampedOutputTime.toFixed(2);
    scrubber.disabled = duration <= 0;
  }
  if (time) time.textContent = formatPreviewClock(clampedOutputTime) + " / " + formatPreviewClock(duration);
}

function formatPreviewClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remaining = value - minutes * 60;
  return String(minutes).padStart(2, "0") + ":" + remaining.toFixed(1).padStart(4, "0");
}

function renderClientIcon(name, size) {
  const paths = {
    play: '<polygon points="6 3 20 12 6 21 6 3"></polygon>',
    pause: '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>',
  };
  return (
    '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">' +
    (paths[name] || "") +
    "</svg>"
  );
}

function initializeProjectEvents() {
  const projectDir = document.querySelector("[data-project-dir]")?.dataset.projectDir;
  if (!projectDir || !window.EventSource) return;
  const eventSource = new EventSource("/api/project-events?project=" + encodeURIComponent(projectDir));
  eventSource.addEventListener("project-state", (event) => applyProjectStateEvent(JSON.parse(event.data)));
}

function applyProjectStateEvent(state) {
  updateAgentPresence(state.agentPresence || "waiting");
}

function updateAgentPresence(agentPresence) {
  const presence = document.querySelector("[data-region='agent-presence']");
  if (!presence) return;
  const state = ["waiting", "listening", "working"].includes(agentPresence) ? agentPresence : "waiting";
  presence.dataset.agentPresenceState = state;
  const dot = presence.querySelector(".presence-dot");
  if (dot) dot.dataset.state = state;
  const label = presence.querySelector("[data-region='agent-presence-label']");
  if (label) label.textContent = "· " + state;
}
