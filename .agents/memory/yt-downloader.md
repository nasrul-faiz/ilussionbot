---
name: YouTube downloader engine
description: How .ytmp3 / .ytmp4 download media and why yt-dlp is primary
---

# YouTube download architecture

`.ytmp3` (commands/ytmp3.js) and `.ytmp4` (commands/video.js) both try **yt-dlp first**, then fall back to the existing third-party API providers. Shared wrapper: `lib/ytdlp.js` (spawns the `yt-dlp` binary, downloads to unique `temp/ytx_*` dirs, returns a file path).

**Why:** the third-party APIs are flaky/dead and `.ytmp4` used to just hand a short-lived remote URL to WhatsApp (unreliable). yt-dlp is self-hosted, current, and handles formats/quality. It is verified to work from this server's datacenter IP (YouTube does NOT block it here) — this is the non-obvious part; if a future change assumes yt-dlp is blocked, re-test before ripping it out.

**How to apply:**
- yt-dlp requires `ffmpeg` (present in the Nix runtime) for audio extraction/merge.
- yt-dlp is installed as a system dependency (not npm). If downloads suddenly fail with extraction errors, first try bumping the yt-dlp system package — YouTube breaks old versions periodically.
- Media is sent from disk (Baileys accepts a local path in `{ video: { url } }`), not buffered remote URLs. Files >100MB are sent as documents.
- All temp dirs are per-download and cleaned up in normal + error paths; `lib/tempCleanup.js` also sweeps stale `temp/*` files AND dirs older than 3h.
