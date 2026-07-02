const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yts = require('yt-search');
const ytdl = require('ytdl-core');
const ytdlp = require('../lib/ytdlp');

const TEMP_DIR = path.join(__dirname, '../temp');
const MAX_INLINE_VIDEO_MB = 100;

function assertSafeRemoteUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('invalid download URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported URL scheme');
    }
    const host = parsed.hostname.toLowerCase();
    const isPrivate =
        host === 'localhost' ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host.endsWith('.local') ||
        host.endsWith('.internal');
    if (isPrivate) throw new Error('blocked private/internal host');
}

async function fetchToFile(url) {
    assertSafeRemoteUrl(url);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const dir = path.join(TEMP_DIR, 'vid_' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'out.mp4');
    try {
        const res = await axios.get(url, {
            responseType: 'stream',
            timeout: 180000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: AXIOS_DEFAULTS.headers
        });
        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(filePath);
            res.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            res.data.on('error', reject);
        });
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1024) {
            throw new Error('downloaded file is empty');
        }
        return { filePath, dir };
    } catch (e) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        throw e;
    }
}

const AXIOS_DEFAULTS = {
    timeout: 60000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    }
};
const MAX_DURATION_SECONDS = 45 * 60;

async function tryRequest(getter, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await getter();
        } catch (err) {
            lastError = err;
            if (attempt < attempts) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }
    throw lastError;
}

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

function extractId(url) {
    const match = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
}

function parseDurationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return 0;

    const parts = value.split(':').map(part => Number(part));
    if (parts.some(part => Number.isNaN(part))) return 0;

    return parts.reduce((total, part) => (total * 60) + part, 0);
}

function sanitizeTitle(value, fallback = 'video') {
    const cleaned = String(value || fallback).replace(/[\r\n]+/g, ' ').replace(/[*_~`]/g, '').trim();
    return cleaned || fallback;
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
    if (video.live) throw new Error('Live streams are not supported for MP4 downloads.');

    const seconds = Number(video.seconds) || parseDurationSeconds(video.timestamp);
    if (seconds > MAX_DURATION_SECONDS) {
        throw new Error('Video is too long. Please choose one under 45 minutes.');
    }
}

// EliteProTech API - Primary
async function getEliteProTechVideoByUrl(youtubeUrl) {
    const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp4`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    if (res?.data?.success && res?.data?.downloadURL) {
        return { download: res.data.downloadURL, title: res.data.title };
    }
    throw new Error('EliteProTech ytdown returned no download');
}

async function getAiooVideoByUrl(youtubeUrl) {
    const apiUrl = `https://api.aioo.my.id/download/ytmp4?url=${encodeURIComponent(youtubeUrl)}`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    if (res?.data?.data?.download_url || res?.data?.download_url) {
        return {
            download: res.data.data?.download_url || res.data.download_url,
            title: res.data.data?.title || res.data.title
        };
    }
    throw new Error('Aioo API returned no download');
}

async function getYupraVideoByUrl(youtubeUrl) {
    const apiUrl = `https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    if (res?.data?.success && res?.data?.data?.download_url) {
        return {
            download: res.data.data.download_url,
            title: res.data.data.title,
            thumbnail: res.data.data.thumbnail
        };
    }
    throw new Error('Yupra returned no download');
}

async function getOkatsuVideoByUrl(youtubeUrl) {
    const apiUrl = `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    // shape: { status, creator, url, result: { status, title, mp4 } }
    if (res?.data?.result?.mp4) {
        return { download: res.data.result.mp4, title: res.data.result.title };
    }
    throw new Error('Okatsu ytmp4 returned no mp4');
}

async function getDirectVideoByUrl(youtubeUrl) {
    const info = await tryRequest(() => ytdl.getInfo(youtubeUrl), 2);
    const mp4Formats = info.formats
        .filter(format => format.hasVideo && format.hasAudio && format.container === 'mp4' && format.url)
        .sort((left, right) => (Number(right.height) || 0) - (Number(left.height) || 0));

    if (!mp4Formats.length) {
        throw new Error('Direct downloader found no MP4 format');
    }

    const preferred = mp4Formats.find(format => !format.isHLS) || mp4Formats[0];
    return {
        download: preferred.url,
        title: info.videoDetails?.title,
        thumbnail: info.videoDetails?.thumbnails?.slice(-1)[0]?.url
    };
}

async function videoCommand(sock, chatId, message) {
    try {
        const text = getMessageText(message);
        const searchQuery = text.replace(/^\.\w+\s*/i, '').trim();
        
        if (!searchQuery) {
            return await sock.sendMessage(chatId, {
                text: [
                    '🎬 *YouTube MP4 Downloader*',
                    '',
                    'Usage:',
                    '  *.ytmp4* <video name>',
                    '  *.ytmp4* <YouTube URL>',
                    '  *.video* <video name>',
                    '',
                    'Example:',
                    '  .ytmp4 never gonna give you up',
                    '  .ytmp4 https://youtu.be/dQw4w9WgXcQ'
                ].join('\n')
            }, { quoted: message });
        }

        if (isPlaylistUrl(searchQuery)) {
            return await sock.sendMessage(chatId, {
                text: '❌ Playlist links are not supported. Send a single YouTube video URL or search term.'
            }, { quoted: message });
        }

        // Determine if input is a YouTube link
        let videoUrl = '';
        let videoTitle = '';
        let videoThumbnail = '';
        let videoDuration = '';
        let selectedVideo = null;

        if (isYtUrl(searchQuery)) {
            videoUrl = searchQuery;
            const videoId = extractId(searchQuery);
            if (!videoId) {
                return await sock.sendMessage(chatId, { text: '❌ This is not a valid YouTube link.' }, { quoted: message });
            }

            try {
                selectedVideo = await yts({ videoId });
                validateVideoSelection(selectedVideo);
                videoTitle = selectedVideo.title || '';
                videoThumbnail = selectedVideo.thumbnail || '';
                videoDuration = selectedVideo.timestamp || '';
            } catch (err) {
                if (err.message.includes('too long') || err.message.includes('Live streams')) {
                    throw err;
                }
            }
        } else {
            // Search YouTube for the video
            const { videos } = await yts(searchQuery);
            selectedVideo = pickVideoCandidate(videos || []);
            if (!selectedVideo) {
                return await sock.sendMessage(chatId, {
                    text: '❌ No suitable videos found. Try another keyword or a shorter non-live video.'
                }, { quoted: message });
            }
            validateVideoSelection(selectedVideo);
            videoUrl = selectedVideo.url;
            videoTitle = selectedVideo.title;
            videoThumbnail = selectedVideo.thumbnail;
            videoDuration = selectedVideo.timestamp || '';
        }

        // Send thumbnail immediately
        try {
            const ytId = extractId(videoUrl);
            const thumb = videoThumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` : undefined);
            const captionTitle = sanitizeTitle(videoTitle || searchQuery, 'Video');
            if (thumb) {
                await sock.sendMessage(chatId, {
                    image: { url: thumb },
                    caption: [
                        `*${captionTitle}*`,
                        videoDuration ? `⏱ ${videoDuration}` : '',
                        '⏳ Downloading video...'
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            } else {
                await sock.sendMessage(chatId, {
                    text: [
                        `🎬 *${captionTitle}*`,
                        videoDuration ? `⏱ ${videoDuration}` : '',
                        '',
                        '⏳ Downloading video...'
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            }
        } catch (e) { console.error('[VIDEO] thumb error:', e?.message || e); }

        if (!isYtUrl(videoUrl) || !extractId(videoUrl)) {
            return await sock.sendMessage(chatId, { text: '❌ This is not a valid YouTube link.' }, { quoted: message });
        }

        const buildCaption = (title) => [
            `*${sanitizeTitle(title || videoTitle || 'Video')}*`,
            videoDuration ? `⏱ ${videoDuration}` : '',
            '',
            '> *_Downloaded by Knight Bot MD_*'
        ].filter(Boolean).join('\n');
        const buildFileName = (title) => `${sanitizeTitle(title || videoTitle || 'video').replace(/[^\w\s-]/g, '').trim() || 'video'}.mp4`;

        // Send a local file as video (or document if large), then clean up.
        const sendLocalVideo = async (filePath, title) => {
            const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
            const payload = sizeMB > MAX_INLINE_VIDEO_MB
                ? { document: { url: filePath }, mimetype: 'video/mp4', fileName: buildFileName(title), caption: buildCaption(title) }
                : { video: { url: filePath }, mimetype: 'video/mp4', fileName: buildFileName(title), caption: buildCaption(title) };
            await sock.sendMessage(chatId, payload, { quoted: message });
        };

        // Primary engine: yt-dlp (self-hosted, most reliable, best quality)
        if (ytdlp.isAvailable()) {
            let dir = null;
            try {
                console.log('[VIDEO] Trying yt-dlp...');
                const res = await ytdlp.downloadVideo(videoUrl, { maxHeight: 720 });
                dir = res.dir;
                await sendLocalVideo(res.filePath, videoTitle);
                ytdlp.cleanup(dir);
                console.log('[VIDEO] Success via yt-dlp');
                return;
            } catch (err) {
                console.log('[VIDEO] yt-dlp failed:', err.message);
                if (dir) ytdlp.cleanup(dir);
            }
        }

        // Try multiple APIs with fallback chain, then fall back to direct extraction.
        let videoData;
        let downloadSuccess = false;

        // List of API methods to try
        const apiMethods = [
            { name: 'EliteProTech', method: () => getEliteProTechVideoByUrl(videoUrl) },
            { name: 'Yupra', method: () => getYupraVideoByUrl(videoUrl) },
            { name: 'Okatsu', method: () => getOkatsuVideoByUrl(videoUrl) },
            { name: 'Aioo', method: () => getAiooVideoByUrl(videoUrl) },
            { name: 'Direct', method: () => getDirectVideoByUrl(videoUrl) }
        ];

        // Try each API until we successfully get video data
        for (const apiMethod of apiMethods) {
            try {
                videoData = await apiMethod.method();
                const videoUrl_check = videoData.download || videoData.dl || videoData.url;

                if (!videoUrl_check) {
                    console.log(`${apiMethod.name} returned no download URL, trying next API...`);
                    continue; // Try next API
                }

                downloadSuccess = true;
                break; // Success! Exit the loop
            } catch (apiErr) {
                // API call failed, try next API
                console.log(`${apiMethod.name} API failed:`, apiErr.message);
                continue;
            }
        }
        
        // If all APIs failed, throw error
        if (!downloadSuccess || !videoData) {
            throw new Error('All download sources failed. The content may be unavailable or blocked in your region.');
        }

        const remoteUrl = videoData.download || videoData.dl || videoData.url;

        // Buffer the provider's URL to disk first (far more reliable than making
        // WhatsApp fetch a short-lived remote URL). Fall back to the raw URL only
        // if the download itself fails.
        let dlDir = null;
        try {
            const dl = await fetchToFile(remoteUrl);
            dlDir = dl.dir;
            await sendLocalVideo(dl.filePath, videoData.title);
        } catch (dlErr) {
            console.log('[VIDEO] File buffering failed, sending remote URL:', dlErr.message);
            await sock.sendMessage(chatId, {
                video: { url: remoteUrl },
                mimetype: 'video/mp4',
                fileName: buildFileName(videoData.title),
                caption: buildCaption(videoData.title)
            }, { quoted: message });
        } finally {
            if (dlDir) { try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (_) {} }
        }


    } catch (error) {
        console.error('[VIDEO] Command Error:', error?.message || error);
        
        // Provide more specific error messages
        let errorMessage = '❌ Failed to download video.';
        if (error.message && error.message.includes('blocked')) {
            errorMessage = '❌ Download blocked. The content may be unavailable in your region or due to legal restrictions.';
        } else if (error.response?.status === 451 || error.status === 451) {
            errorMessage = '❌ Content unavailable (451). This may be due to legal restrictions or regional blocking.';
        } else if (error.message && error.message.includes('All download sources failed')) {
            errorMessage = '❌ All download sources failed. The content may be unavailable or blocked.';
        } else if (error.message && error.message.includes('too long')) {
            errorMessage = '❌ Video is too long. Please choose one under 45 minutes.';
        } else if (error.message && error.message.includes('Live streams')) {
            errorMessage = '❌ Live streams are not supported for MP4 downloads.';
        } else if (error.message) {
            errorMessage = '❌ Download failed: ' + error.message;
        }
        
        await sock.sendMessage(chatId, { 
            text: errorMessage 
        }, { quoted: message });
    }
}

module.exports = videoCommand; 