const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_ROOT = path.join(__dirname, '../temp');
let _available = null;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isAvailable() {
    if (_available !== null) return _available;
    try {
        execSync('yt-dlp --version', { stdio: 'ignore', timeout: 8000 });
        _available = true;
    } catch (_) {
        _available = false;
    }
    return _available;
}

function makeWorkDir() {
    ensureDir(TEMP_ROOT);
    const dir = path.join(TEMP_ROOT, 'ytx_' + crypto.randomBytes(6).toString('hex'));
    ensureDir(dir);
    return dir;
}

function findOutput(dir) {
    const files = fs.readdirSync(dir).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp'));
    let best = null;
    let bestSize = -1;
    for (const f of files) {
        const p = path.join(dir, f);
        try {
            const size = fs.statSync(p).size;
            if (size > bestSize) { bestSize = size; best = p; }
        } catch (_) {}
    }
    return best;
}

function runYtDlp(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', args, { windowsHide: true });
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.stdout.on('data', () => {});
        proc.on('error', err => { clearTimeout(timer); reject(err); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error('yt-dlp timed out'));
            if (code === 0) return resolve({ stderr });
            const lastLine = stderr.split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0] || `yt-dlp exited with code ${code}`;
            reject(new Error(lastLine.replace(/^ERROR:\s*/i, '')));
        });
    });
}

const COMMON_ARGS = [
    '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
    '--geo-bypass', '--retries', '3', '--fragment-retries', '3',
    '--socket-timeout', '30',
];

async function downloadAudio(url, { timeoutMs = 180000 } = {}) {
    if (!isAvailable()) throw new Error('yt-dlp not available');
    const dir = makeWorkDir();
    const out = path.join(dir, 'out.%(ext)s');
    try {
        await runYtDlp([
            ...COMMON_ARGS,
            '-f', 'bestaudio/best',
            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
            '-o', out, url,
        ], timeoutMs);
        const file = findOutput(dir);
        if (!file) throw new Error('yt-dlp produced no audio file');
        return { filePath: file, dir };
    } catch (e) {
        cleanup(dir);
        throw e;
    }
}

async function downloadVideo(url, { maxHeight = 720, timeoutMs = 300000 } = {}) {
    if (!isAvailable()) throw new Error('yt-dlp not available');
    const dir = makeWorkDir();
    const out = path.join(dir, 'out.%(ext)s');
    const fmt = `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${maxHeight}][ext=mp4]/b[height<=${maxHeight}]/bv*+ba/b`;
    try {
        await runYtDlp([
            ...COMMON_ARGS,
            '-f', fmt,
            '-S', `res:${maxHeight},ext:mp4:m4a,size`,
            '--merge-output-format', 'mp4',
            '-o', out, url,
        ], timeoutMs);
        const file = findOutput(dir);
        if (!file) throw new Error('yt-dlp produced no video file');
        return { filePath: file, dir };
    } catch (e) {
        cleanup(dir);
        throw e;
    }
}

function cleanup(dir) {
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { isAvailable, downloadAudio, downloadVideo, cleanup };
