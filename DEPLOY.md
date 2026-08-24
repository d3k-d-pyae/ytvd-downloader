# Deploying on Vercel

Read the limits below before deploying: this app was built as a long-running local service, and Vercel's serverless model only supports a reduced version of it. For the full experience (big files, live progress bars, saved history), host it on Render, Railway, Fly.io, or any VPS with `npm install` + `node server.js` - zero code changes required.

## What Works on Vercel

- Metadata lookup (`/api/info`)
- Synchronous downloads of files under ~4.5 MB (short MP3s, low-resolution clips)
- The web UI served from `public/`

## Hard Limits

| Constraint | Impact |
|---|---|
| 4.5 MB function response cap | Larger videos cannot be returned - HTTP 413 |
| Ephemeral filesystem | Only `/tmp` is writable; nothing persists between requests |
| No shared memory across instances | Background jobs + progress polling are unreliable |
| Datacenter IP | YouTube often serves bot checks / 403s to cloud IPs |
| Max duration | 300 s on Hobby, 800 s on Pro |

## Required Code Changes

1. Bundle ffmpeg: `npm install ffmpeg-static`, then resolve the binary with `require("ffmpeg-static") || "ffmpeg"` and use it in every spawn call.
2. Rename `static/` to `public/` - Vercel ignores `express.static()` and serves `public/**` from its CDN.
3. Make `/api/download` synchronous: run the whole job inside the request and return the file directly. Remove `/api/progress/:id` and the in-memory state map; show an indeterminate spinner in the frontend instead.
4. Create `vercel.json` in the project root:

```json
{
  "functions": {
    "server.js": {
      "maxDuration": 300,
      "includeFiles": "node_modules/ffmpeg-static/ffmpeg"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/server.js" }]
}
```

## Deploy Steps

1. Push the branch with the changes above to GitHub.
2. Open [vercel.com/new](https://vercel.com/new) and import the repository.
3. Vercel auto-detects the Express app from the root `server.js` (it accepts either a default export or an `app.listen()` call) - leave build settings empty.
4. Click Deploy. Your app goes live at `https://<project>.vercel.app`.

Or from the terminal:

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

## If Downloads Fail After Deploying

It is almost always YouTube blocking the datacenter IP, not your code. Options: attach cookies via an authenticated client context, route through a proxy with residential IPs, or move to a long-running host where a stable IP behaves better.
