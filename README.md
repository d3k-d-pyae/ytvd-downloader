# YTVdDownloader

A lightweight, self-hosted web app for downloading YouTube videos and audio. Paste a link, pick a quality, and grab an MP4/MKV or extract MP3 audio, all through a simple browser interface that also works from phones on your local network.

## Features

- Paste any YouTube URL (watch pages, youtu.be, shorts, embed, live)
- Video metadata preview: title, uploader, duration, thumbnail
- Per-quality selection for every resolution YouTube serves
- MP3 extraction at highest VBR quality
- Live progress bar with speed and ETA
- Files are named after the video title when saved by your browser
- Stream-once delivery: nothing is kept on the server after you download it
- LAN friendly: start it once and download from any device on your network

## Tech Stack

- **Backend:** Python 3.12, Flask, waitress
- **YouTube extraction:** [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Media processing:** ffmpeg (system binary)
- **Deployment:** Docker

## Getting Started (native)

Requires Python 3.10+ and ffmpeg on your PATH.

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt   # Windows
.venv/bin/python -m pip install -r requirements.txt       # macOS/Linux
.venv\Scripts\python app.py                               # or .venv/bin/python app.py
```

Then open:

```
Local:   http://127.0.0.1:5000
Network: http://<your-lan-ip>:5000
```

## Running with Docker

```bash
docker build -t ytvd-downloader .
docker run -d --name ytvd -p 5000:5000 ytvd-downloader
```

The image bundles ffmpeg and a JavaScript runtime (required by recent yt-dlp for YouTube extraction), so no host dependencies are needed. Set `-e PORT=8080` and `-p 8080:8080` to change the port.

Processed files are streamed straight to your browser as a download; the server keeps no copy. Where they land is up to your browser settings - enable "Ask where to save each file" in Chrome (or the equivalent elsewhere) to pick a folder every time.

## How It Works

1. `/api/info` asks yt-dlp for the format list and shows every available video height plus an MP3 option with expected sizes (bitrate-estimated where YouTube omits exact sizes).
2. On download, yt-dlp grabs the best video track up to the chosen height plus best audio, merging them with ffmpeg (MP4 preferred, MKV fallback). MP3 jobs transcode the best audio stream at VBR quality 0.
3. Progress is reported live through `/api/progress/:id`; the finished file streams once through `/api/file/:id` and is deleted from the server the moment delivery completes.

## API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Web UI |
| POST | `/api/info` | Body `{ "url": "..." }`, returns metadata plus available qualities |
| POST | `/api/download` | Body `{ "url": "...", "quality": "720p" }` or `"mp3"`, returns a `download_id` |
| GET | `/api/progress/:id` | Live job state: progress %, speed, ETA, status, filename |
| GET | `/api/file/:id` | Streams the finished file as an attachment; single-use (409 afterwards) |

## Project Structure

```
app.py            Flask server and download pipeline
public/           Frontend (vanilla HTML/CSS/JS)
requirements.txt  Python dependencies
Dockerfile        Container image (ffmpeg + JS runtime included)
```

## Notes

- YouTube changes its internals regularly; keeping `yt-dlp` updated (`pip install -U yt-dlp`) fixes most breakages.
- Only download content you have the rights to; this tool is for personal use.
