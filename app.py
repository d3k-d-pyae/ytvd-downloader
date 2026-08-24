import io
import math
import os
import re
import secrets
import shutil
import tempfile
import threading

from flask import Flask, jsonify, request, send_file, send_from_directory
import yt_dlp
from waitress import serve

PORT = int(os.environ.get("PORT", "5000"))
JOBS = {}
JOBS_LOCK = threading.Lock()

app = Flask(__name__, static_folder="public", static_url_path="")


def cookie_file():
    candidates = [
        os.environ.get("COOKIES_FILE"),
        "/etc/secrets/cookies.txt",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt"),
    ]
    src = next((p for p in candidates if p and os.path.isfile(p)), None)
    if not src:
        return None
    target = os.path.join(tempfile.gettempdir(), "ytvd-cookies.txt")
    shutil.copyfile(src, target)
    return target


def base_opts():
    opts = {
        "quiet": True,
        "no_warnings": False,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "js_runtimes": {"node": {}},
    }
    cookies = cookie_file()
    if cookies:
        opts["cookiefile"] = cookies
    return opts


def clean_error(err):
    return str(err).splitlines()[0].strip()


def format_size(fmt, duration):
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    if not size:
        rate = fmt.get("tbr") or fmt.get("abr")
        if rate and duration:
            size = math.ceil(rate * 1000 * duration / 8)
    return size


def build_qualities(info):
    duration = info.get("duration")
    best_by_height = {}
    for fmt in info.get("formats") or []:
        if fmt.get("vcodec") == "none" or not fmt.get("height"):
            continue
        current = best_by_height.get(fmt["height"])
        if not current or (format_size(fmt, duration) or 0) > (format_size(current, duration) or 0):
            best_by_height[fmt["height"]] = fmt
    qualities = [
        {
            "label": f"{height}p",
            "height": height,
            "filesize": format_size(fmt, duration),
        }
        for height, fmt in sorted(best_by_height.items(), reverse=True)
    ]
    audios = [f for f in info.get("formats") or [] if f.get("acodec") != "none" and f.get("vcodec") == "none"]
    if not audios:
        audios = [f for f in info.get("formats") or [] if f.get("acodec") != "none"]
    if audios:
        best_audio = max(audios, key=lambda f: f.get("abr") or f.get("tbr") or 0)
        qualities.append(
            {"label": "mp3", "height": None, "filesize": format_size(best_audio, duration)}
        )
    return qualities


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/info")
def api_info():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "A YouTube URL is required."}), 400
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as err:
        return jsonify({"error": clean_error(err)}), 400
    return jsonify(
        {
            "id": info.get("id"),
            "title": info.get("title"),
            "uploader": info.get("uploader") or info.get("channel"),
            "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail"),
            "qualities": build_qualities(info),
            "mode": "job",
        }
    )


def set_job(job_id, **fields):
    with JOBS_LOCK:
        JOBS[job_id].update(fields)


def make_progress_hook(job_id):
    state = {"stream": 0}

    def hook(d):
        if d["status"] == "downloading":
            bands = [(0, 70), (70, 95)]
            lo, hi = bands[min(state["stream"], len(bands) - 1)]
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            frac = (d.get("downloaded_bytes") or 0) / total if total else 0
            set_job(
                job_id,
                status="downloading",
                progress=round(lo + (hi - lo) * frac, 1),
                speed=d.get("speed"),
                eta=d.get("eta"),
            )
        elif d["status"] == "finished":
            state["stream"] += 1
            set_job(job_id, status="processing", progress=96)

    return hook


def run_job(job_id, url, quality):
    workdir = tempfile.mkdtemp(prefix="ytdl-job-")
    try:
        opts = base_opts()
        opts.update(
            {
                "outtmpl": os.path.join(workdir, "%(title).180B.%(ext)s"),
                "progress_hooks": [make_progress_hook(job_id)],
            }
        )
        if quality == "mp3":
            opts["format"] = "bestaudio/best"
            opts["postprocessors"] = [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}
            ]
        else:
            height = int(quality.rstrip("p"))
            opts["format"] = (
                f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={height}]+bestaudio/"
                f"best[height<={height}]/best"
            )
            opts["merge_output_format"] = "mp4/mkv"

        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])

        files = [
            f for f in os.listdir(workdir)
            if not f.endswith((".part", ".ytdl", ".temp", ".tmp"))
        ]
        if not files:
            raise RuntimeError("Download produced no file.")
        final = max(files, key=lambda f: os.path.getsize(os.path.join(workdir, f)))
        set_job(
            job_id,
            status="finished",
            progress=100,
            speed=None,
            eta=None,
            filename=final,
            path=os.path.join(workdir, final),
            workdir=workdir,
        )
    except Exception as err:
        shutil.rmtree(workdir, ignore_errors=True)
        set_job(job_id, status="error", error=clean_error(err))


@app.post("/api/download")
def api_download():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url") or "").strip()
    quality = str(body.get("quality") or "").strip().lower()
    if not url:
        return jsonify({"error": "A YouTube URL is required."}), 400
    if quality != "mp3" and not re.fullmatch(r"\d+p", quality):
        return jsonify({"error": f"Unsupported quality: {quality or '(empty)'}"}), 400
    job_id = secrets.token_hex(16)
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "starting",
            "progress": 0,
            "speed": None,
            "eta": None,
            "filename": None,
            "path": None,
            "workdir": None,
            "delivered": False,
        }
    threading.Thread(target=run_job, args=(job_id, url, quality), daemon=True).start()
    return jsonify({"download_id": job_id, "status": "started"})


@app.get("/api/progress/<job_id>")
def api_progress(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        snapshot = dict(job) if job else None
    if not snapshot:
        return jsonify({"error": "Unknown download id."}), 404
    snapshot.pop("path", None)
    snapshot.pop("workdir", None)
    return jsonify(snapshot)


@app.get("/api/file/<job_id>")
def api_file(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        snapshot = dict(job) if job else None
    if not snapshot:
        return jsonify({"error": "Unknown download id."}), 404
    if snapshot.get("delivered"):
        return jsonify({"error": "file already delivered"}), 409
    if snapshot["status"] != "finished":
        return jsonify({"error": "File is not ready yet."}), 404

    def stream_once():
        try:
            with open(snapshot["path"], "rb") as fh:
                while True:
                    chunk = fh.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
        finally:
            shutil.rmtree(snapshot["workdir"], ignore_errors=True)
            with JOBS_LOCK:
                entry = JOBS.get(job_id)
                if entry:
                    entry["delivered"] = True
                    entry["path"] = None
                    entry["workdir"] = None

    response = send_file(
        io.BytesIO(b""),
        as_attachment=True,
        download_name=snapshot["filename"],
        mimetype="application/octet-stream",
    )
    response.headers["Content-Length"] = str(os.path.getsize(snapshot["path"]))
    response.response = stream_once()
    return response


if not shutil.which("ffmpeg"):
    print("WARNING: ffmpeg not found on PATH; merging and MP3 extraction will fail.")

if __name__ == "__main__":
    print(f"YT Downloader running (Python + yt-dlp) (ffmpeg: {'yes' if shutil.which('ffmpeg') else 'NO'})")
    print(f"  Local:   http://127.0.0.1:{PORT}")
    serve(app, host="0.0.0.0", port=PORT, threads=12)
