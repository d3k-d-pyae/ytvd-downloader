import math
import os
import shutil
import tempfile

import streamlit as st
import yt_dlp

from app import base_opts, build_qualities

st.set_page_config(page_title="YT Downloader", page_icon=None)


def human_size(n):
    if not n:
        return ""
    units = ["B", "KB", "MB", "GB"]
    i = 0
    val = float(n)
    while val >= 1024 and i < len(units) - 1:
        val /= 1024
        i += 1
    return f"{val:.1f} {units[i]}"


def human_time(s):
    if s is None:
        return ""
    s = int(s)
    return f"{s // 60}:{s % 60:02d}"


def run_download(url, quality, workdir, bar):
    opts = base_opts()
    opts["outtmpl"] = os.path.join(workdir, "%(title).180B.%(ext)s")

    state = {"phase": 0}

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            frac = (d.get("downloaded_bytes") or 0) / total if total else 0
            pct = int((frac * 0.9 + state["phase"] * 0.05) * 100)
            bar.progress(min(pct, 99), text=f"Downloading... {pct}%")
        elif d["status"] == "finished":
            state["phase"] += 1
            bar.progress(95, text="Processing with ffmpeg...")

    opts["progress_hooks"] = [hook]

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
    return final


st.title("YT Downloader")
st.caption("Paste a link, pick a quality, keep the video.")

url = st.text_input(
    "YouTube URL",
    placeholder="https://www.youtube.com/watch?v=...",
    label_visibility="collapsed",
)

if url:
    key = f"info:{url}"
    if key not in st.session_state:
        try:
            with yt_dlp.YoutubeDL(base_opts()) as ydl:
                st.session_state[key] = ydl.extract_info(url, download=False)
        except Exception as err:
            st.error(str(err).splitlines()[0])
            st.stop()

    info = st.session_state[key]
    left, right = st.columns([1, 2])
    with left:
        if info.get("thumbnail"):
            st.image(info["thumbnail"])
    with right:
        st.subheader(info.get("title") or info.get("id"))
        st.write(info.get("uploader") or info.get("channel"))
        duration = info.get("duration")
        if duration:
            st.write(f"Duration: {human_time(duration)}")

    qualities = build_qualities(info)
    labels = [
        f"{q['label']}" + (f" ({human_size(q['filesize'])})" if q.get("filesize") else "")
        for q in qualities
    ]
    picked = st.radio("Choose quality", labels, horizontal=True)
    quality = qualities[labels.index(picked)]["label"]

    if st.button("Download", type="primary"):
        workdir = tempfile.mkdtemp(prefix="ytdl-job-")
        bar = st.progress(0, text="Starting...")
        try:
            filename = run_download(url, quality, workdir, bar)
            path = os.path.join(workdir, filename)
            size = os.path.getsize(path)
            if size > 450 * 1024 * 1024:
                bar.empty()
                st.error("Result exceeds ~450 MB, too large for in-app delivery.")
            else:
                with open(path, "rb") as fh:
                    data = fh.read()
                bar.progress(100, text="Done!")
                st.download_button(
                    f"Save {filename} ({human_size(size)})",
                    data=data,
                    file_name=filename,
                    type="primary",
                )
        except Exception as err:
            bar.empty()
            st.error(str(err).splitlines()[0])
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
