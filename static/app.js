"use strict";

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $("#fetch-form"),
  urlInput: $("#url-input"),
  fetchBtn: $("#fetch-btn"),
  errorBanner: $("#error-banner"),
  videoCard: $("#video-card"),
  thumb: $("#video-thumb"),
  title: $("#video-title"),
  uploader: $("#video-uploader"),
  duration: $("#video-duration"),
  qualitySection: $("#quality-section"),
  qualityList: $("#quality-list"),
  downloadBtn: $("#download-btn"),
  downloadsSection: $("#downloads-section"),
  downloadsList: $("#downloads-list"),
};

const state = { url: null, title: null, qualities: [], selected: null };
const downloads = new Map();

const MUSIC_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "";
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bps) {
  const s = formatBytes(bps);
  return s ? `${s}/s` : null;
}

function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.classList.remove("hidden");
}

function hideError() {
  els.errorBanner.classList.add("hidden");
  els.errorBanner.textContent = "";
}

function setLoading(loading) {
  els.fetchBtn.disabled = loading;
  els.urlInput.disabled = loading;
}

async function fetchInfo(event) {
  event.preventDefault();
  hideError();
  const url = els.urlInput.value.trim();
  if (!url) {
    showError("Paste a YouTube link first.");
    return;
  }
  setLoading(true);
  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not read that video.");
    state.url = url;
    state.title = data.title;
    state.qualities = data.qualities || [];
    renderVideo(data);
    renderQualities();
  } catch (err) {
    showError(err.message || "Something went wrong fetching the video.");
  } finally {
    setLoading(false);
  }
}

function renderVideo(data) {
  els.thumb.src = data.thumbnail || "";
  els.title.textContent = data.title || "Untitled";
  els.uploader.textContent = data.uploader || "";
  els.duration.textContent = formatDuration(data.duration);
  els.videoCard.classList.remove("hidden");
}

function renderQualities() {
  els.qualityList.replaceChildren();
  state.qualities.forEach((q, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "quality-row";
    row.style.animationDelay = `${index * 40}ms`;
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", "false");

    const label = document.createElement("span");
    label.className = "q-label";
    if (q.label === "mp3") {
      const span = document.createElement("span");
      span.innerHTML = MUSIC_SVG;
      label.appendChild(span.firstChild);
    }
    label.appendChild(document.createTextNode(q.label === "mp3" ? "MP3" : q.label));

    const size = document.createElement("span");
    size.className = "q-size";
    const sizeText = formatBytes(q.filesize);
    size.textContent = sizeText ? `~${sizeText}` : "";

    row.append(label, size);
    row.addEventListener("click", () => selectQuality(q.label));
    els.qualityList.appendChild(row);
  });

  const firstVideo = state.qualities.find((q) => q.label !== "mp3");
  if (firstVideo) selectQuality(firstVideo.label);

  els.qualitySection.classList.toggle("hidden", state.qualities.length === 0);
}

function selectQuality(label) {
  state.selected = label;
  [...els.qualityList.children].forEach((row) => {
    const isSelected = row.querySelector(".q-label").textContent.replace(/^/, "") === (label === "mp3" ? "MP3" : label);
    row.classList.toggle("selected", isSelected);
    row.setAttribute("aria-checked", String(isSelected));
  });
}

async function startDownload() {
  if (!state.url || !state.selected) return;
  hideError();
  els.downloadBtn.disabled = true;
  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: state.url, quality: state.selected }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start the download.");
    addDownloadCard(data.download_id, state.title, state.selected);
    poll(data.download_id);
  } catch (err) {
    showError(err.message || "Could not start the download.");
  } finally {
    els.downloadBtn.disabled = false;
  }
}

function addDownloadCard(id, title, quality) {
  els.downloadsSection.classList.remove("hidden");

  const card = document.createElement("div");
  card.className = "card dl-card";

  const head = document.createElement("div");
  head.className = "dl-head";
  const name = document.createElement("span");
  name.className = "dl-title";
  name.textContent = `${title || "Video"} - ${quality === "mp3" ? "MP3" : quality}`;
  const chip = document.createElement("span");
  chip.className = "chip chip-downloading";
  chip.textContent = "Starting";
  head.append(name, chip);

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "bar-fill indeterminate";
  bar.appendChild(fill);

  const stats = document.createElement("div");
  stats.className = "dl-stats";
  const pct = document.createElement("span");
  pct.className = "dl-pct";
  pct.textContent = "0%";
  const sub = document.createElement("span");
  sub.className = "dl-sub";
  stats.append(pct, sub);

  const foot = document.createElement("div");
  foot.className = "dl-foot hidden";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-small";
  saveBtn.textContent = "Save again";
  saveBtn.addEventListener("click", () => triggerSave(id));
  foot.appendChild(saveBtn);

  card.append(head, bar, stats, foot);
  els.downloadsList.prepend(card);

  downloads.set(id, { chip, fill, pct, sub, foot, timer: null, saved: false });
}

function poll(id) {
  const entry = downloads.get(id);
  if (!entry) return;
  fetch(`/api/progress/${id}`)
    .then((res) => res.json())
    .then((p) => {
      if (!p || (!p.status && p.error)) {
        finishWithError(entry, p ? p.error : "Lost track of this download.");
        return;
      }
      updateCard(entry, p);
      if (p.status === "finished") {
        triggerSave(id);
        setChip(entry, "Finished", "chip-finished");
        entry.fill.classList.remove("indeterminate");
        entry.fill.style.width = "100%";
        entry.pct.textContent = "100%";
        entry.sub.textContent = "";
        entry.foot.classList.remove("hidden");
      } else if (p.status === "error") {
        finishWithError(entry, p.error || "Download failed.");
      } else {
        entry.timer = setTimeout(() => poll(id), 800);
      }
    })
    .catch(() => {
      entry.timer = setTimeout(() => poll(id), 800);
    });
}

function updateCard(entry, p) {
  if (p.status === "downloading") {
    setChip(entry, "Downloading", "chip-downloading");
    entry.fill.classList.remove("indeterminate");
    entry.fill.style.width = `${Math.max(0, Math.min(100, p.progress || 0))}%`;
    entry.pct.textContent = `${Math.floor(p.progress || 0)}%`;
    const parts = [];
    const speed = formatSpeed(p.speed);
    const eta = formatEta(p.eta);
    if (speed) parts.push(speed);
    if (eta) parts.push(`ETA ${eta}`);
    entry.sub.textContent = parts.join(" - ");
  } else if (p.status === "processing") {
    setChip(entry, "Processing", "chip-processing");
    entry.fill.classList.add("indeterminate");
    entry.pct.textContent = "100%";
    entry.sub.textContent = "Merging / converting...";
  }
}

function setChip(entry, text, cls) {
  entry.chip.textContent = text;
  entry.chip.className = `chip ${cls}`;
}

function finishWithError(entry, message) {
  if (entry.timer) clearTimeout(entry.timer);
  setChip(entry, "Failed", "chip-error");
  entry.fill.classList.remove("indeterminate");
  const errLine = document.createElement("p");
  errLine.className = "dl-error";
  errLine.textContent = message;
  entry.fill.parentElement.after(errLine);
}

function triggerSave(id) {
  const entry = downloads.get(id);
  if (entry && !entry.saved) entry.saved = true;
  const a = document.createElement("a");
  a.href = `/api/file/${id}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

els.form.addEventListener("submit", fetchInfo);
els.downloadBtn.addEventListener("click", startDownload);
