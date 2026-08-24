# YTVdDownloader

A lightweight, self-hosted web app for downloading YouTube videos and audio. Paste a link, pick a quality, and grab an MP4/MKV or extract MP3 audio, all through a simple browser interface that also works from phones on your local network.

## Features

- Paste any YouTube URL (watch pages, youtu.be, shorts, embed, live)
- Video metadata preview: title, uploader, duration, thumbnail
- Per-quality selection for every resolution YouTube serves
- MP3 extraction at highest VBR quality
- Live progress bar with speed and ETA
- Video and audio streams download in parallel, then merge losslessly via ffmpeg
- LAN friendly: start it once and download from any device on your network

## Tech Stack

- **Backend:** Node.js, Express
- **YouTube extraction:** [youtubei.js](https://github.com/LuanRT/YouTube.js) (InnerTube iOS client, raw `/player` responses)
- **Media processing:** ffmpeg

## Prerequisites

- Node.js 18 or newer
- ffmpeg available on PATH ([download](https://ffmpeg.org/download.html))

## Getting Started

```bash
npm install
node server.js
```

Then open:

```
Local:   http://127.0.0.1:5000
Network: http://<your-lan-ip>:5000   (printed at startup)
```

Finished files land in the `downloads/` folder inside the project directory.

## How It Works

1. The server requests YouTube's InnerTube player response using the iOS client context, which still returns direct stream URLs.
2. `/api/info` lists every available video height plus an MP3 option with expected file sizes.
3. On download, the selected video track and best audio track are fetched concurrently with weighted progress tracking, then combined with `ffmpeg -c copy` (MP4 when both tracks are MP4-family, otherwise MKV).
4. MP3 jobs transcode the best audio-only stream with libmp3lame at VBR quality 0.

## API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Web UI |
| POST | `/api/info` | Body `{ "url": "..." }`, returns metadata plus available qualities |
| POST | `/api/download` | Body `{ "url": "...", "quality": "720p" }` or `"mp3"`, returns a `download_id` |
| GET | `/api/progress/:id` | Live job state: progress %, speed, ETA, status, filename |
| GET | `/api/file/:id` | Serves the finished file as an attachment |

## Project Structure

```
server.js     Express server and download pipeline
static/       Frontend (vanilla HTML/CSS/JS)
downloads/    Finished files (created automatically)
```

## Notes

- YouTube changes its internals regularly; if downloads break, updating `youtubei.js` usually fixes it.
- Only download content you have the rights to; this tool is for personal use.
