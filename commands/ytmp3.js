const axios = require('axios');
const fs = require('fs');
const yts = require('yt-search');
const { toAudio } = require('../lib/converter');
const ytdlp = require('../lib/ytdlp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const AXIOS_OPT = { timeout: 60000, headers: { 'User-Agent': UA, 'Accept': 'application/json, */*' } };
const DL_OPT = {
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' }
};
const MAX_DURATION_SECONDS = 45 * 60;

/* ── Helpers ── */
async function retry(fn, times = 2) {
    let last;
    for (let i = 0; i < times; i++) {
        try { return await fn(); } catch (e) { last = e; if (i < times - 1) await sleep(1200 * (i + 1)); }
    }
    throw last;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getMessageText(message) {
    return message.message?.conversation
        || message.message?.extendedTextMessage?.text
        || message.message?.imageMessage?.caption
        || message.message?.videoMessage?.caption
        || message.message?.documentMessage?.caption
        || '';
}

function isYtUrl(text) {
    return /(?:youtu\.be\/|youtube\.com\/(?:watch|shorts|embed|v\/))/i.test(text);
}

function isPlaylistUrl(text) {
    return /[?&]list=/i.test(text);
}

function parseDurationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return 0;

    const parts = value.split(':').map(part => Number(part));
    if (parts.some(part => Number.isNaN(part))) return 0;

    return parts.reduce((total, part) => (total * 60) + part, 0);
}

function sanitizeTitle(value, fallback) {
    const cleaned = String(value || fallback || 'audio').replace(/[\r\n]+/g, ' ').replace(/[*_~`]/g, '').trim();
    return cleaned || fallback || 'audio';
}

function pickVideoCandidate(videos = []) {
    return videos.find(video => {
        if (!video || video.live) return false;
        const seconds = Number(video.seconds) || parseDurationSeconds(video.timestamp);
        return !seconds || seconds <= MAX_DURATION_SECONDS;
    }) || null;
}

function validateVideoSelection(video) {
    if (!video) throw new Error('Unable to resolve that YouTube video.');
    if (video.live) throw new Error('Live streams are not supported for MP3 downloads.');

    const seconds = Number(video.seconds) || parseDurationSeconds(video.timestamp);
    if (seconds > MAX_DURATION_SECONDS) {
        throw new Error('Video is too long. Please choose one under 45 minutes.');
    }
}

/* ── Download-URL providers ── */
async function apiEliteProTech(url) {
    const r = await retry(() => axios.get(`https://eliteprotech-apis.zone.id/ytdown?url=${enc(url)}&format=mp3`, AXIOS_OPT));
    if (r?.data?.success && r.data.downloadURL) return { dl: r.data.downloadURL, title: r.data.title };
    throw new Error('EliteProTech: no link');
}

async function apiYupra(url) {
    const r = await retry(() => axios.get(`https://api.yupra.my.id/api/downloader/ytmp3?url=${enc(url)}`, AXIOS_OPT));
    if (r?.data?.success && r.data.data?.download_url) return { dl: r.data.data.download_url, title: r.data.data.title, thumb: r.data.data.thumbnail };
    throw new Error('Yupra: no link');
}

async function apiOkatsu(url) {
    const r = await retry(() => axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${enc(url)}`, AXIOS_OPT));
    if (r?.data?.dl) return { dl: r.data.dl, title: r.data.title, thumb: r.data.thumb };
    throw new Error('Okatsu: no link');
}

async function apiKeith(url) {
    const r = await retry(() => axios.get(`https://apis-keith.vercel.app/download/dlmp3?url=${enc(url)}`, AXIOS_OPT));
    if (r?.data?.status && r.data.result?.downloadUrl) return { dl: r.data.result.downloadUrl, title: r.data.result.title };
    throw new Error('Keith: no link');
}

async function apiAioo(url) {
    const r = await retry(() => axios.get(`https://api.aioo.my.id/download/ytmp3?url=${enc(url)}`, AXIOS_OPT));
    const d = r?.data?.data || r?.data;
    if (d?.download_url) return { dl: d.download_url, title: d.title };
    throw new Error('Aioo: no link');
}

async function apiY2Mate(url) {
    // Y2Mate v2 — two-step: analyze then convert
    const analyzeRes = await retry(() => axios.post('https://www.y2mate.com/mates/analyzeV2/ajax', new URLSearchParams({ k_query: url, k_page: 'home', hl: 'en', q_auto: 0 }), { ...AXIOS_OPT, headers: { ...AXIOS_OPT.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }));
    const vid = analyzeRes?.data?.vid;
    const k = analyzeRes?.data?.links?.mp3?.mp3128?.k;
    if (!vid || !k) throw new Error('Y2Mate: analyze failed');
    const convertRes = await retry(() => axios.post('https://www.y2mate.com/mates/convertV2/index', new URLSearchParams({ vid, k }), { ...AXIOS_OPT, headers: { ...AXIOS_OPT.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }));
    const dlUrl = convertRes?.data?.dlink;
    if (!dlUrl) throw new Error('Y2Mate: convert failed');
    return { dl: dlUrl, title: analyzeRes.data.title };
}

async function apiRapidYt(url) {
    const rapidKey = (global.APIKeys && global.APIKeys['rapidapi-ytmp3']) || process.env.RAPIDAPI_KEY || '';
    if (!rapidKey) throw new Error('RapidYt: no API key configured');
    const r = await retry(() => axios.get(`https://youtube-mp36.p.rapidapi.com/dl?id=${extractId(url)}`, { ...AXIOS_OPT, headers: { ...AXIOS_OPT.headers, 'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com', 'X-RapidAPI-Key': rapidKey } }));
    if (r?.data?.status === 'ok' && r.data.link) return { dl: r.data.link, title: r.data.title };
    throw new Error('RapidYt: no link');
}

function enc(u) { return encodeURIComponent(u); }
function extractId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : '';
}

const PROVIDERS = [
    { name: 'EliteProTech', fn: apiEliteProTech },
    { name: 'Yupra', fn: apiYupra },
    { name: 'Okatsu', fn: apiOkatsu },
    { name: 'Keith', fn: apiKeith },
    { name: 'Aioo', fn: apiAioo },
    { name: 'Y2Mate', fn: apiY2Mate },
    { name: 'RapidYt', fn: apiRapidYt }
];

/* ── Buffer downloader with stream fallback ── */
async function downloadBuffer(dlUrl) {
    try {
        const r = await axios.get(dlUrl, DL_OPT);
        const buf = Buffer.from(r.data);
        if (buf.length > 0) return buf;
        throw new Error('empty arraybuffer');
    } catch (e) {
        if (e.response?.status === 451) throw new Error('geo-blocked 451');
        // stream fallback
        const r2 = await axios.get(dlUrl, { ...DL_OPT, responseType: 'stream' });
        const chunks = [];
        await new Promise((res, rej) => {
            r2.data.on('data', c => chunks.push(c));
            r2.data.on('end', res);
            r2.data.on('error', rej);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) throw new Error('empty stream');
        return buf;
    }
}

/* ── Format detection & conversion ── */
function detectFormat(buf) {
    if (!buf || buf.length < 12) return { mime: 'audio/mpeg', ext: 'mp3' };
    const hex = buf.slice(0, 12).toString('hex');
    const ascii4 = buf.slice(4, 8).toString('ascii');
    if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0))
        return { mime: 'audio/mpeg', ext: 'mp3' };
    if (buf.toString('ascii', 0, 4) === 'OggS')
        return { mime: 'audio/ogg; codecs=opus', ext: 'ogg' };
    if (buf.toString('ascii', 0, 4) === 'RIFF')
        return { mime: 'audio/wav', ext: 'wav' };
    if (ascii4 === 'ftyp' || hex.startsWith('000000'))
        return { mime: 'audio/mp4', ext: 'm4a' };
    return { mime: 'audio/mp4', ext: 'm4a' };
}

async function ensureMp3(buf, ext) {
    if (ext === 'mp3') return buf;
    const converted = await toAudio(buf, ext);
    if (!converted || converted.length === 0) throw new Error('ffmpeg conversion returned empty buffer');
    return converted;
}

/* ── Main command ── */
async function ytmp3Command(sock, chatId, message) {
    try {
        const body = getMessageText(message);
        const args = body.replace(/^\.\w+\s*/i, '').trim();

        if (!args) {
            return await sock.sendMessage(chatId, {
                text: [
                    '🎵 *YouTube MP3 Downloader*',
                    '',
                    'Usage:',
                    '  *.ytmp3* <song name>',
                    '  *.ytmp3* <YouTube URL>',
                    '',
                    'Example:',
                    '  .ytmp3 shape of you',
                    '  .ytmp3 https://youtu.be/dQw4w9WgXcQ'
                ].join('\n')
            }, { quoted: message });
        }

        if (isPlaylistUrl(args)) {
            return await sock.sendMessage(chatId, {
                text: '❌ Playlist links are not supported. Send a single YouTube video URL or search term.'
            }, { quoted: message });
        }

        /* ── Search / resolve video info ── */
        let videoUrl, videoTitle, videoThumb, videoDuration, videoSeconds;

        if (isYtUrl(args)) {
            videoUrl = args;
            // fetch basic info via yts
            try {
                const info = await yts({ videoId: extractId(args) });
                validateVideoSelection(info);
                videoTitle = info.title || 'Unknown';
                videoThumb = info.thumbnail;
                videoDuration = info.timestamp;
                videoSeconds = Number(info.seconds) || parseDurationSeconds(info.timestamp);
            } catch (err) {
                if (err.message.includes('too long') || err.message.includes('Live streams')) throw err;
                videoTitle = 'Unknown';
            }
        } else {
            const search = await yts(args);
            const top = pickVideoCandidate(search?.videos || []);
            if (!top) {
                return await sock.sendMessage(chatId, { text: '❌ No results found. Try a different keyword.' }, { quoted: message });
            }
            validateVideoSelection(top);
            videoUrl = top.url;
            videoTitle = top.title;
            videoThumb = top.thumbnail;
            videoDuration = top.timestamp;
            videoSeconds = Number(top.seconds) || parseDurationSeconds(top.timestamp);
        }

        if (videoSeconds > MAX_DURATION_SECONDS) {
            return await sock.sendMessage(chatId, {
                text: '❌ Video is too long. Please choose one under 45 minutes.'
            }, { quoted: message });
        }

        /* ── Notify user ── */
        const cleanTitle = sanitizeTitle(videoTitle, 'Unknown');
        const waitMsg = [
            `🎵 *${cleanTitle}*`,
            videoDuration ? `⏱ ${videoDuration}` : '',
            '',
            '⏳ _Downloading audio, please wait..._'
        ].filter(Boolean).join('\n');

        if (videoThumb) {
            await sock.sendMessage(chatId, { image: { url: videoThumb }, caption: waitMsg }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, { text: waitMsg }, { quoted: message });
        }

        /* ── Try providers in sequence ── */
        let audioBuffer = null;
        let alreadyMp3 = false;

        /* Primary engine: yt-dlp (self-hosted, most reliable, best quality) */
        if (ytdlp.isAvailable()) {
            try {
                console.log('[YTMP3] Trying yt-dlp...');
                const res = await ytdlp.downloadAudio(videoUrl);
                const buf = fs.readFileSync(res.filePath);
                ytdlp.cleanup(res.dir);
                if (buf && buf.length > 1024) {
                    audioBuffer = buf;
                    alreadyMp3 = true;
                    console.log(`[YTMP3] Success via yt-dlp (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
                }
            } catch (err) {
                console.log(`[YTMP3] yt-dlp failed: ${err.message}`);
            }
        }

        /* Fallback: third-party API providers */
        if (!audioBuffer) {
            for (const provider of PROVIDERS) {
                try {
                    console.log(`[YTMP3] Trying ${provider.name}...`);
                    const data = await provider.fn(videoUrl);
                    if (!data?.dl) continue;

                    const buf = await downloadBuffer(data.dl);
                    if (buf && buf.length > 1024) {
                        audioBuffer = buf;
                        if (data.title && data.title !== 'Unknown') videoTitle = data.title;
                        console.log(`[YTMP3] Success via ${provider.name} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
                        break;
                    }
                } catch (err) {
                    console.log(`[YTMP3] ${provider.name} failed: ${err.message}`);
                }
            }
        }

        if (!audioBuffer) {
            return await sock.sendMessage(chatId, {
                text: '❌ All download sources failed. The video may be age-restricted, private, or geo-blocked.'
            }, { quoted: message });
        }

        /* ── Detect format & convert to MP3 if needed ── */
        let finalBuffer = audioBuffer;
        if (!alreadyMp3) {
            const { ext } = detectFormat(audioBuffer);
            try {
                finalBuffer = await ensureMp3(audioBuffer, ext);
            } catch (convErr) {
                console.log(`[YTMP3] Conversion failed (${ext}→mp3): ${convErr.message}. Sending original.`);
                finalBuffer = audioBuffer;
            }
        }

        const safeName = sanitizeTitle(videoTitle, 'audio').replace(/[^\w\s\-()]/g, '').trim() || 'audio';

        await sock.sendMessage(chatId, {
            audio: finalBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${safeName}.mp3`,
            ptt: false
        }, { quoted: message });

    } catch (err) {
        console.error('[YTMP3] Fatal error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to download: ${err.message.slice(0, 120)}`
        }, { quoted: message });
    }
}

module.exports = ytmp3Command;
