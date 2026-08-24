"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const express = require("express");

const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const WORK_DIR = path.join(os.tmpdir(), "ytvd-downloader");
fs.mkdirSync(WORK_DIR, { recursive: true });

// Sweep outputs abandoned by previous runs (finished jobs nobody fetched).
try {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(WORK_DIR)) {
    const p = path.join(WORK_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
} catch {
  /* best effort */
}

const PORT = 5000;

// On Vercel the app runs as a single serverless function: downloads become
// synchronous and stream the finished file straight back to the client.
const IS_VERCEL = Boolean(process.env.VERCEL);

let FFMPEG_BIN = "ffmpeg";
try {
  const bundled = require("ffmpeg-static");
  if (bundled) {
    FFMPEG_BIN = bundled;
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(bundled, 0o755);
      } catch {
        /* best effort */
      }
    }
  }
} catch {
  /* ffmpeg-static not installed; fall back to system ffmpeg */
}

function hasFFmpeg() {
  if (path.isAbsolute(FFMPEG_BIN)) return fs.existsSync(FFMPEG_BIN);
  try {
    const result = spawnSync(FFMPEG_BIN, ["-version"], { windowsHide: true, stdio: "ignore" });
    return !result.error;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = hasFFmpeg();

/**
 * Identity-only cookie subset. Full browser cookie strings break mobile
 * InnerTube clients outright (the iOS endpoint answers HTTP 400), while this
 * subset is accepted and carries the actual sign-in state.
 */
const CORE_COOKIES = [
  "SID=",
  "HSID=",
  "SSID=",
  "APISID=",
  "SAPISID=",
  "__Secure-1PSID=",
  "__Secure-3PSID=",
  "LOGIN_INFO=",
  "__Secure-1PSIDTS=",
  "__Secure-3PSIDTS=",
];

function signedCookie() {
  const raw = process.env.YOUTUBE_COOKIE;
  if (!raw) return "";
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => CORE_COOKIES.some((name) => part.startsWith(name)))
    .join("; ");
}

/** Lazily created shared InnerTube session (fetches YouTube's player once). */
let ytSessionPromise = null;
// Client choice is empirical: the iOS client serves ready-to-use stream URLs
// but rejects cookies with HTTP 400, while the Android VR client accepts the
// identity-cookie subset and keeps serving plain URLs, so deciphering is
// never needed.
// youtubei.js is loaded with import(): its node entry is ESM-only, which
// require() cannot consume on runtimes like Vercel's, and loading it lazily
// also keeps a failed import from crashing boot.
function getSession() {
  if (!ytSessionPromise) {
    ytSessionPromise = (async () => {
      const mod = await import("youtubei.js");
      const { Innertube, ClientType } = mod.Innertube ? mod : mod.default;
      const cookie = signedCookie();
      const opts = { client_type: cookie ? ClientType.ANDROID_VR : ClientType.IOS };
      if (cookie) opts.cookie = cookie;
      return Innertube.create(opts);
    })().catch((err) => {
      ytSessionPromise = null;
      throw err;
    });
  }
  return ytSessionPromise;
}

function extractVideoId(raw) {
  const input = String(raw || "").trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0];
    const shorts = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    if (shorts) return shorts[2];
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

function cleanError(err) {
  let message = (err && err.message ? String(err.message) : String(err)).split("\n")[0].trim();
  if (message.startsWith("Error: ")) message = message.slice(7);
  return message.slice(0, 300) || "Unknown error.";
}

function sanitizeName(title) {
  const cleaned = String(title || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 140) || "video";
}

function bestThumb(thumbnail) {
  let best = null;
  for (const t of (thumbnail && thumbnail.thumbnails) || []) {
    if (!t || !t.url) continue;
    if (!best || (t.width || 0) >= (best.width || 0)) best = t;
  }
  return best ? best.url : null;
}

/** Flatten a raw /player format into the small shape this app uses.
 * `progressive` marks tracks from streamingData.formats (video+audio muxed),
 * which some clients refuse to serve even though they are advertised. */
function normalizeFormat(raw, progressive) {
  const mime = String(raw.mimeType || "");
  const seconds = Number(raw.approxDurationMs) > 0 ? Number(raw.approxDurationMs) / 1000 : null;
  let size = Number(raw.contentLength ?? raw.filesize ?? 0);
  if (!size && raw.bitrate && seconds) size = Math.round((raw.bitrate * seconds) / 8);
  return {
    mime,
    isVideo: mime.startsWith("video/"),
    isAudio: mime.startsWith("audio/"),
    height: raw.height ?? null,
    bitrate: Number(raw.bitrate) || 0,
    size: size > 0 ? size : null,
    url: raw.url || null,
    progressive: Boolean(progressive),
  };
}

/**
 * Call the InnerTube /player endpoint directly and read the raw response.
 * Deliberately bypasses youtubei.js getInfo(): its node parser crashes on
 * several clients' responses, while the raw JSON carries everything we need -
 * including plain stream URLs on both the iOS client and, when signed in,
 * the Android VR client.
 */
async function fetchPlayer(videoId) {
  const session = await getSession();
  const res = await session.actions.execute("/player", {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  });
  const data = res.data || res;
  const status = data.playabilityStatus || {};
  if (status.status && status.status !== "OK") {
    throw new Error(status.reason || "This video is unavailable.");
  }
  const details = data.videoDetails;
  if (!details) throw new Error("YouTube did not return video details.");
  const streaming = data.streamingData || {};
  const formats = [...(streaming.adaptiveFormats || []), ...(streaming.formats || [])]
    .map(normalizeFormat)
    .filter((f) => f.url);
  if (!formats.length) throw new Error("No downloadable streams were returned for this video.");
  return {
    id: details.videoId || videoId,
    title: details.title || "video",
    uploader: details.author || null,
    duration: Number(details.lengthSeconds) || null,
    thumbnail: bestThumb(details.thumbnail),
    formats,
  };
}

function buildQualities(formats) {
  let pool = formats.filter((f) => f.isVideo && f.height);
  const adaptive = pool.filter((f) => !f.progressive);
  if (adaptive.length) pool = adaptive;
  const bestByHeight = new Map();
  for (const f of pool) {
    const current = bestByHeight.get(f.height);
    if (!current || (f.size || 0) > (current.size || 0)) bestByHeight.set(f.height, f);
  }

  const qualities = [...bestByHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, f]) => ({ label: `${height}p`, height, filesize: f.size }));

  let audio = null;
  for (const f of formats) {
    if (!f.isAudio || f.isVideo) continue;
    if (!audio || (f.size || 0) > (audio.size || 0)) audio = f;
  }
  qualities.push({ label: "mp3", height: null, filesize: audio ? audio.size : null });
  return qualities;
}

function pickVideo(formats, maxHeight) {
  let list = formats.filter((f) => f.isVideo && f.height && f.height <= maxHeight);
  if (!list.length) throw new Error(`No video format up to ${maxHeight}p is available.`);
  // Progressive tracks (itag 18/22) can come back 403-blocked on some clients;
  // identical-height adaptive tracks stream fine, so prefer them.
  const adaptive = list.filter((f) => !f.progressive);
  if (adaptive.length) list = adaptive;
  list.sort(
    (a, b) =>
      b.height - a.height ||
      (a.mime.includes("mp4") ? 0 : 1) - (b.mime.includes("mp4") ? 0 : 1) ||
      b.bitrate - a.bitrate
  );
  return list[0];
}

function pickAudio(formats) {
  const list = formats.filter((f) => f.isAudio && !f.isVideo);
  if (!list.length) throw new Error("No audio stream is available.");
  list.sort((a, b) => b.bitrate - a.bitrate || (b.size || 0) - (a.size || 0));
  return list[0];
}

function makeSpeedo(totalBytes) {
  let lastTime = Date.now();
  let lastBytes = 0;
  let speed = 0;
  return (done) => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    if (dt >= 0.5) {
      const instant = (done - lastBytes) / dt;
      speed = speed ? speed * 0.7 + instant * 0.3 : instant;
      lastTime = now;
      lastBytes = done;
    }
    return {
      speed: speed > 0 ? Math.round(speed) : null,
      eta: speed > 0 && totalBytes > done ? Math.round((totalBytes - done) / speed) : null,
    };
  };
}

async function downloadUrl(url, destPath, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Stream request failed (HTTP ${res.status}).`);
  const headerTotal = Number(res.headers.get("content-length") || 0);
  let done = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      try {
        onProgress(done, headerTotal);
      } catch {
        /* progress reporting must never kill the download */
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    proc.on("error", () => reject(new Error("ffmpeg not found. Install ffmpeg and restart.")));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      const line = stderr.trim().split("\n").pop() || "";
      reject(new Error(`ffmpeg failed (${code}): ${line}`.slice(0, 300)));
    });
  });
}

function removeQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best-effort temp cleanup */
  }
}

async function processDownload(videoId, quality, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const onPhase = hooks.onPhase || (() => {});
  const tempFiles = [];
  try {
    const media = await fetchPlayer(videoId);
    if (hooks.onTitle) hooks.onTitle(media.title);
    const baseName = `${sanitizeName(media.title)} [${media.id}]`;

    if (quality === "mp3") {
      if (!HAS_FFMPEG) throw new Error("MP3 extraction requires ffmpeg on this machine.");
      const audio = pickAudio(media.formats);
      const audioPath = path.join(WORK_DIR, `${crypto.randomBytes(16).toString("hex")}.audio.tmp`);
      tempFiles.push(audioPath);

      const total = Number(audio.size || 0);
      const speedo = makeSpeedo(total || 1);
      await downloadUrl(audio.url, audioPath, (done, headerTotal) => {
        const known = total || headerTotal;
        const s = speedo(done);
        onProgress({
          progress: known ? Math.min(99.9, Math.round((done / known) * 990) / 10) : null,
          speed: s.speed,
          eta: s.eta,
        });
      });

      onPhase("processing");
      const outPath = path.join(WORK_DIR, `${baseName}.mp3`);
      await runFFmpeg(["-y", "-i", audioPath, "-vn", "-codec:a", "libmp3lame", "-q:a", "0", outPath]);
      return { title: media.title, filename: path.basename(outPath) };
    }

    const height = parseInt(quality, 10);
    const video = pickVideo(media.formats, height);
    const audio = pickAudio(media.formats);

    const uid = crypto.randomBytes(16).toString("hex");
    const videoPath = path.join(WORK_DIR, `${uid}.video.tmp`);
    const audioPath = path.join(WORK_DIR, `${uid}.audio.tmp`);
    tempFiles.push(videoPath, audioPath);

    const vTotal = Number(video.size || 0);
    const aTotal = Number(audio.size || 0);
    const grandTotal = vTotal + aTotal || 1;
    const speedo = makeSpeedo(grandTotal);
    let vDone = 0;
    let aDone = 0;
    const report = () => {
      const s = speedo(vDone + aDone);
      onProgress({
        progress: Math.min(99.9, Math.round(((vDone + aDone) / grandTotal) * 990) / 10),
        speed: s.speed,
        eta: s.eta,
      });
    };

    await Promise.all([
      downloadUrl(video.url, videoPath, (done) => {
        vDone = done;
        report();
      }),
      downloadUrl(audio.url, audioPath, (done) => {
        aDone = done;
        report();
      }),
    ]);

    onPhase("processing");
    const mergedExt =
      String(video.mime || "").includes("mp4") && String(audio.mime || "").includes("mp4")
        ? "mp4"
        : "mkv";
    const outPath = path.join(WORK_DIR, `${baseName}.${mergedExt}`);
    const args = ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy"];
    if (mergedExt === "mp4") args.push("-movflags", "+faststart");
    args.push(outPath);
    await runFFmpeg(args);
    return { title: media.title, filename: path.basename(outPath) };
  } finally {
    for (const file of tempFiles) removeQuiet(file);
  }
}

async function runJob(state, videoId, quality) {
  try {
    const { filename } = await processDownload(videoId, quality, {
      onTitle: (t) => {
        state.title = t;
      },
      onProgress: (u) => {
        if (u.progress != null) state.progress = u.progress;
        state.speed = u.speed;
        state.eta = u.eta;
      },
      onPhase: (phase) => {
        if (phase === "processing") {
          state.status = "processing";
          state.speed = null;
          state.eta = null;
        }
      },
    });
    state.filename = filename;
    state.status = "finished";
    state.progress = 100;
    state.error = null;
  } catch (err) {
    state.status = "error";
    state.speed = null;
    state.eta = null;
    state.error = cleanError(err);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/** download_id -> state */
const downloads = new Map();

function newState(id) {
  return {
    download_id: id,
    status: "downloading",
    progress: 0,
    speed: null,
    eta: null,
    title: null,
    filename: null,
    error: null,
  };
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/api/info", async (req, res) => {
  const url = String((req.body && req.body.url) || "").trim();
  if (!url) return res.status(400).json({ error: "Missing video URL." });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "That does not look like a YouTube URL." });
  try {
    const media = await fetchPlayer(videoId);
    res.json({
      id: media.id,
      title: media.title,
      uploader: media.uploader,
      duration: media.duration,
      thumbnail: media.thumbnail,
      qualities: buildQualities(media.formats),
      mode: IS_VERCEL ? "direct" : "job",
      signedIn: Boolean(process.env.YOUTUBE_COOKIE),
    });
  } catch (err) {
    return res.status(400).json({ error: cleanError(err) });
  }
});

app.post("/api/download", async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || "").trim();
  const quality = String(body.quality || "").trim().toLowerCase();

  if (!url) return res.status(400).json({ error: "Missing video URL." });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "That does not look like a YouTube URL." });

  const isMp3 = quality === "mp3";
  if (!isMp3 && !/^(\d+)p$/.exec(quality)) {
    return res.status(400).json({ error: `Unknown quality '${quality}'.` });
  }
  if (isMp3 && !HAS_FFMPEG) {
    return res.status(400).json({ error: "MP3 extraction requires ffmpeg on this machine." });
  }

  // Serverless mode has no background workers: process inline and stream the file back.
  if (IS_VERCEL) {
    try {
      const { filename } = await processDownload(videoId, quality);
      const filePath = path.join(WORK_DIR, filename);
      res.download(filePath, filename, () => removeQuiet(filePath));
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: cleanError(err) });
    }
    return;
  }

  const id = crypto.randomBytes(16).toString("hex");
  const state = newState(id);
  downloads.set(id, state);
  runJob(state, videoId, quality);
  res.json({ download_id: id, status: "started" });
});

app.get("/api/progress/:id", (req, res) => {
  const state = downloads.get(req.params.id);
  if (!state) return res.status(404).json({ error: "unknown download id" });
  res.json(state);
});

app.get("/api/file/:id", (req, res) => {
  const state = downloads.get(req.params.id);
  if (!state) return res.status(404).json({ error: "unknown download id" });
  if (state.status !== "finished") return res.status(409).json({ error: "not finished" });
  if (!state.filename) return res.status(409).json({ error: "file already delivered" });
  const filePath = path.join(WORK_DIR, state.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file missing" });
  // Stream once, straight to the requester; the server keeps no copy.
  res.download(filePath, state.filename, () => {
    removeQuiet(filePath);
    state.filename = null;
  });
});

// JSON error handler (bad request bodies etc.)
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err instanceof SyntaxError ? "Invalid JSON body." : "Request failed." });
});

function lanIp() {
  const candidates = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) candidates.push(net.address);
    }
  }
  // Skip VirtualBox host-only and link-local ranges so phones reach the app.
  const real = candidates.find(
    (ip) => !ip.startsWith("192.168.56.") && !ip.startsWith("169.254.")
  );
  return real || candidates[0] || "127.0.0.1";
}

if (!IS_VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`YT Downloader running (Node.js + youtubei.js, ${process.env.YOUTUBE_COOKIE ? "Android VR client, signed in" : "iOS client"}) (ffmpeg: ${HAS_FFMPEG ? "yes" : "no"})`);
    console.log(`  Local:   http://127.0.0.1:${PORT}`);
    console.log(`  Network: http://${lanIp()}:${PORT}`);
  });
}

module.exports = app;
