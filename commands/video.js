const axios = require('axios');
const yts = require('yt-search');
const ytdl = require('ytdl-core');

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

        // Send video directly using the download URL
        await sock.sendMessage(chatId, {
            video: { url: videoData.download || videoData.dl || videoData.url },
            mimetype: 'video/mp4',
            fileName: `${sanitizeTitle(videoData.title || videoTitle || 'video').replace(/[^\w\s-]/g, '').trim() || 'video'}.mp4`,
            caption: [
                `*${sanitizeTitle(videoData.title || videoTitle || 'Video')}*`,
                videoDuration ? `⏱ ${videoDuration}` : '',
                '',
                '> *_Downloaded by Knight Bot MD_*'
            ].filter(Boolean).join('\n')
        }, { quoted: message });


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