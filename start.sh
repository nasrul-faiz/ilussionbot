#!/bin/bash
# Startup script for Knight Bot
# Works on Replit and Railway

# ── SESSION_ID: Load session from environment variable (for Railway/cloud) ──
# Set SESSION_ID in Railway env vars with the base64 value from dashboard Session tab
if [ -n "$SESSION_ID" ]; then
  echo "📦 SESSION_ID detected — restoring session from environment variable..."
  mkdir -p session
  echo "$SESSION_ID" | base64 -d > session/creds.json 2>/dev/null
  if [ $? -eq 0 ] && [ -s session/creds.json ]; then
    echo "✅ Session restored from SESSION_ID successfully."
  else
    echo "⚠️ SESSION_ID decode failed — will generate fresh QR."
    rm -f session/creds.json
  fi
fi

# Always recreate gtts stub (gtts not in package.json; this stub handles TTS gracefully)
mkdir -p node_modules/gtts
cat > node_modules/gtts/index.js << 'EOF'
'use strict';
class gTTS {
  constructor(text, lang) { this.text = text; this.lang = lang || 'en'; }
  save(path, callback) { callback(new Error('TTS unavailable: gtts not installed')); }
  stream() { const { Readable } = require('stream'); const r = new Readable(); r.push(null); return r; }
}
module.exports = gTTS;
EOF
echo '{"name":"gtts","version":"0.2.1","main":"index.js"}' > node_modules/gtts/package.json

# Cheerio compatibility shim: newer cheerio ships dist/ not lib/, but older bundled deps require lib/index.js
if [ -f "node_modules/cheerio/dist/commonjs/index.js" ]; then
  mkdir -p node_modules/cheerio/lib
  echo "module.exports = require('../dist/commonjs/index.js');" > node_modules/cheerio/lib/index.js
fi

# Always overwrite supports-color stub to avoid has-flag dependency issue
mkdir -p node_modules/supports-color
cat > node_modules/supports-color/index.js << 'EOF'
'use strict';
const {env} = process;
function translateLevel(level) {
  if (level === 0) return false;
  return { level, hasBasic: true, has256: level >= 2, has16m: level >= 3 };
}
function createSupportsColor(stream) {
  if ('FORCE_COLOR' in env) {
    const fc = env.FORCE_COLOR;
    if (fc === 'true') return translateLevel(1);
    if (fc === 'false') return translateLevel(0);
    const n = Math.min(Number.parseInt(fc, 10), 3);
    return translateLevel(isNaN(n) ? 1 : n);
  }
  if (!stream || !stream.isTTY) return translateLevel(0);
  if (env.COLORTERM === 'truecolor') return translateLevel(3);
  if (env.COLORTERM) return translateLevel(2);
  return translateLevel(1);
}
module.exports = {
  supportsColor: createSupportsColor,
  stdout: createSupportsColor({ isTTY: process.stdout && process.stdout.isTTY }),
  stderr: createSupportsColor({ isTTY: process.stderr && process.stderr.isTTY }),
};
EOF
echo '{"name":"supports-color","version":"7.2.0","main":"index.js"}' > node_modules/supports-color/package.json

# Rebuild sharp native module if missing
if [ ! -f "node_modules/sharp/build/Release/sharp-linux-x64.node" ]; then
  echo "🔧 Rebuilding sharp..."
  npm rebuild sharp --ignore-scripts=false 2>/dev/null || true
fi

# Ensure data directory and required JSON files exist
mkdir -p data
[ ! -f "data/customCommands.json" ] && echo '[]' > data/customCommands.json
[ ! -f "data/botInfo.json" ] && echo '{}' > data/botInfo.json
[ ! -f "data/banned.json" ] && echo '[]' > data/banned.json
[ ! -f "data/premium.json" ] && echo '[]' > data/premium.json
[ ! -f "data/warnings.json" ] && echo '{}' > data/warnings.json
[ ! -f "data/owner.json" ] && echo '["60162832841@s.whatsapp.net"]' > data/owner.json

# Ensure session and uploads directories exist
mkdir -p session
mkdir -p public/uploads
mkdir -p temp
mkdir -p tmp

# Start dashboard as persistent background process (stays alive even when bot crashes)
# Dashboard reads logs from data/bot.log so it works across bot restarts
node -e "require('./dashboard')" &
DASHBOARD_PID=$!
echo "🌐 Dashboard started as background process (PID $DASHBOARD_PID)"

# Keep restarting the bot if it exits — SKIP_DASHBOARD=1 prevents port conflict
while true; do
    SKIP_DASHBOARD=1 node index.js
    EXIT_CODE=$?
    echo "⚡ Bot exited (code $EXIT_CODE). Restarting in 3s..."
    sleep 3
done
