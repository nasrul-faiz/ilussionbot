---
name: Dependency install quirks (Knight Bot)
description: Non-obvious blockers when installing this project's npm deps on Replit and how to get the app running.
---

# Getting deps installed & app running

## Security-firewall-blocked transitive packages
The `package-firewall.replit.local` blocks specific vulnerable versions (HTTP 403 "Blocked by Security Policy"). Two transitive deps in this project are blocked and must be forced to safe versions via `overrides` in `package.json`:
- `protobufjs@6.8.8` — hard-pinned by `libsignal@2.0.1`. Fixed with a nested override `libsignal.protobufjs -> ^8.6.5`. A plain top-level `protobufjs` override conflicts with the direct `protobufjs@^8.6.5` dependency (EOVERRIDE), so it MUST be nested under `libsignal`.
- `jsonpath-plus@5.0.7` — pulled by the deprecated `youtube-yts@2.0.0` (used in `lib/ytdl2.js`). Fixed with a top-level override `jsonpath-plus -> ^10.3.0`.

**Why:** these versions have critical CVEs and cannot be downloaded at all; the app cannot start without substituting safe versions.
**How to apply:** if a fresh install 403s on a transitive pkg, regenerate the lockfile offline with `npm install --package-lock-only --legacy-peer-deps`, find the dependent via the lockfile, then add an override. Repeat until the offline resolve is clean before doing the real install.

## protobufjs override compatibility
Forcing libsignal onto protobufjs 8.x (instead of its pinned 6.8.8) is a known accepted risk — the `.load`/reflection API is stable 6→8 and the app connects/generates QR fine. There is no alternative because 6.8.8 is firewall-blocked.

## zod missing
`@jimp/types` requires `zod` but it is not pulled in automatically — install `zod` explicitly or the bot crashes at startup (dashboard still starts, bot does not).

## Manual `npm install` gets killed → corrupts packages
A plain `npm install` in the bash tool can be killed by the sandbox before finishing, leaving packages half-extracted (e.g. `fluent-ffmpeg` missing its `lib/` and `index.js`, leaving only `package.json`+`OLD/`). Subsequent installs then think the pkg is present and skip it, so the corruption persists. Fix: `rm -rf node_modules` then reinstall via the package-management tool (`installLanguagePackages`), whose npm run completes quickly and reliably.
