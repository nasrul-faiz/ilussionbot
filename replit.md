# Knight Bot (Knightbot-MD)

A multi-device WhatsApp automation bot built using the Baileys library. Designed for group management, entertainment, and utility automation on WhatsApp.

## Features

- **Group Management**: Auto-kick, promotion/demotion, muting, tagging all members
- **Moderation**: Anti-link, anti-badword, anti-call, anti-delete
- **Utility**: Sticker creation, YouTube downloading, language translation, TTS
- **Entertainment**: AI chat, Tic-Tac-Toe, Hangman, Trivia, meme generators
- **Web Dashboard**: Live dashboard on port 5000 — status, logs, settings, features, banned users, custom commands, session management

## Setup

1. Start the bot — it will display a pairing code
2. Open WhatsApp on your phone
3. Go to Settings > Linked Devices > Link a Device
4. Enter the pairing code shown in the console

## Configuration

Edit `settings.js` to configure:
- `ownerNumber`: Your WhatsApp number (with country code, no +)
- `botName`: The bot's display name
- `commandMode`: "public" or "private"

Edit `config.js` to configure API keys for external services.

## Architecture

- `index.js` — Main entry point, WhatsApp connection & auth; loads dashboard first
- `main.js` — Message handler and command router (includes custom command support)
- `dashboard.js` — Express web dashboard (port 5000), loaded by index.js
- `public/index.html` — Dashboard UI (dark-themed, single-page app)
- `commands/` — Individual command modules
- `lib/` — Utility/helper functions
- `data/` — JSON persistence files (incl. customCommands.json, botInfo.json)
- `data/customCommands.json` — Custom commands created via dashboard
- `session/` — WhatsApp auth credentials
- `public/uploads/` — Media uploaded via dashboard for custom commands

## Runtime Notes

- Node.js 20+ required (Baileys v7 dependency)
- `gtts` package is stubbed (blocked by security policy; TTS commands return an error)
- `sharp` native module is rebuilt at startup if needed
- `express` and `multer` required for dashboard (installed in node_modules)
- The `start.sh` script ensures all stub modules and data files are in place before launch
- Dashboard intercepts console.log/error to capture bot logs in the Logs tab

## User Preferences

- Keep changes minimal and follow existing project structure
