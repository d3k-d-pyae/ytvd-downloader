# YTVdDownloader

A lightweight YouTube downloader with a simple browser UI. Paste a link, pick a quality, and grab an MP4/MKV or extract MP3 audio. Runs anywhere Streamlit runs - including a free [Streamlit Community Cloud](https://share.streamlit.io) deployment.

## Features

- Paste any YouTube URL (watch pages, youtu.be, shorts, embed, live)
- Video metadata preview: title, uploader, duration, thumbnail
- Per-quality selection for every resolution YouTube serves
- MP3 extraction at highest VBR quality
- Live progress bar during download and processing
- Files are named after the video title when saved by your browser
- Nothing is kept on the server: each download is temporary and cleaned up immediately

## Tech Stack

- **UI + server:** Streamlit
- **YouTube extraction:** [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Media processing:** ffmpeg (system package)

## Deploy on Streamlit Community Cloud

1. Fork or push this repo to GitHub.
2. At [share.streamlit.io](https://share.streamlit.io), click **New app**, pick the repo and branch.
3. Set **Main file path** to `app.py` and click **Deploy**.

That's it - `requirements.txt` installs the Python dependencies, and `packages.txt` tells the cloud to apt-install `ffmpeg` and `nodejs` (both required by yt-dlp).

## Run locally

Requires Python 3.10+. ffmpeg and node are needed on your PATH (on Windows: `winget install Gyan.FFmpeg Node.js`).

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt   # Windows
.venv/bin/python -m pip install -r requirements.txt       # macOS/Linux
.venv\Scripts\python -m streamlit run app.py    # or .venv/bin/python ...
```

Then open http://localhost:8501. To reach the app from other devices on your network:

```bash
.venv\Scripts\python -m streamlit run app.py --server.address 0.0.0.0
```

## How It Works

1. Pasting a URL asks yt-dlp for the format list; every available video height plus an MP3 option is shown with expected sizes (bitrate-estimated where YouTube omits exact sizes).
2. Downloading grabs the best video track up to the chosen height plus best audio, merging them with ffmpeg (MP4 preferred, MKV fallback). MP3 jobs transcode the best audio stream at VBR quality 0.
3. The finished file is offered through the browser's save dialog; the temporary copy is deleted the moment it is delivered.

## Project Structure

```
app.py  The whole app: yt-dlp pipeline + Streamlit UI
requirements.txt  Python dependencies
packages.txt      apt packages for Streamlit Cloud (ffmpeg, nodejs)
```

## Notes

- Keep downloads under ~450 MB; larger results exceed what the app can hand through the browser session.
- YouTube changes its internals regularly; keeping `yt-dlp` updated (`pip install -U yt-dlp`) fixes most breakages.
- Cloud providers' IPs sometimes get bot-checked by YouTube regardless of this app; running locally is always the most reliable option.
- Only download content you have the rights to; this tool is for personal use.
