const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_ROOT = path.join(__dirname, '../temp');
const BIN_DIR = path.join(__dirname, '../bin');
const LOCAL_YTDLP = path.join(BIN_DIR, 'yt-dlp');
let _available = null;
let _runner = null;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function verifyRunner(cmd, baseArgs = []) {
    try {
        execSync([cmd, ...baseArgs, '--version'].join(' '), { stdio: 'ignore', timeout: 10000 });
        return { cmd, baseArgs };
    } catch (_) {
        return null;
    }
}

function bootstrapLocalBinary() {
    try {
        ensureDir(BIN_DIR);
        if (!fs.existsSync(LOCAL_YTDLP)) {
            execSync(`curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${LOCAL_YTDLP}"`, {
                stdio: 'ignore', timeout: 120000,
            });
            execSync(`chmod +x "${LOCAL_YTDLP}"`, { stdio: 'ignore', timeout: 10000 });
        }
        return verifyRunner(LOCAL_YTDLP, []);
    } catch (_) {
        return null;
    }
}

function detectRunner() {
    const envBin = process.env.YTDLP_BIN ? verifyRunner(process.env.YTDLP_BIN, []) : null;
    if (envBin) return envBin;

    const native = verifyRunner('yt-dlp', []);
    if (native) return native;

    const pyModule = verifyRunner('python3', ['-m', 'yt_dlp']);
    if (pyModule) return pyModule;

    return bootstrapLocalBinary();
}

function isAvailable() {
    if (_available !== null) return _available;
    _runner = detectRunner();
    _available = Boolean(_runner);
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
    if (!_runner) throw new Error('yt-dlp runner not available');
    return new Promise((resolve, reject) => {
        const proc = spawn(_runner.cmd, [...(_runner.baseArgs || []), ...args], { windowsHide: true });
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
    '--extractor-args', 'youtube:player_client=android,web',
];

function withCookieArgs(args) {
    const cookieFile = process.env.YTDLP_COOKIES || '';
    if (cookieFile && fs.existsSync(cookieFile)) {
        return [...args, '--cookies', cookieFile];
    }
    return args;
}

async function downloadAudio(url, { timeoutMs = 180000 } = {}) {
    if (!isAvailable()) throw new Error('yt-dlp not available');
    const dir = makeWorkDir();
    const out = path.join(dir, 'out.%(ext)s');
    try {
        await runYtDlp([
            ...withCookieArgs(COMMON_ARGS),
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
            ...withCookieArgs(COMMON_ARGS),
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
