const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const { toAudio } = require('../lib/converter');
const ytdlDownloader = require('../lib/ytdl2');

const AXIOS_DEFAULTS = {
        timeout: 60000,
        headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*'
        }
};

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

// EliteProTech API - Primary
async function getEliteProTechDownloadByUrl(youtubeUrl) {
        const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp3`;
        const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
        if (res?.data?.success && res?.data?.downloadURL) {
                return {
                        download: res.data.downloadURL,
                        title: res.data.title
                };
        }
        throw new Error('EliteProTech ytdown returned no download');
}

async function getKeithDownloadByUrl(youtubeUrl) {
        const apiUrl = `https://apis-keith.vercel.app/download/dlmp3?url=${encodeURIComponent(youtubeUrl)}`;
        const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
        if (res?.data?.status && res?.data?.result?.downloadUrl) {
                return {
                        download: res.data.result.downloadUrl,
                        title: res.data.result.title
                };
        }
        throw new Error('Keith API returned no download');
}

async function getAiooDownloadByUrl(youtubeUrl) {
        const apiUrl = `https://api.aioo.my.id/download/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
        const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
        if (res?.data?.data?.download_url || res?.data?.download_url) {
                return {
                        download: res.data.data?.download_url || res.data.download_url,
                        title: res.data.data?.title || res.data.title
                };
        }
        throw new Error('Aioo API returned no download');
}

async function getYupraDownloadByUrl(youtubeUrl) {
        const apiUrl = `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
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

async function getOkatsuDownloadByUrl(youtubeUrl) {
        const apiUrl = `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
        const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
        // Okatsu response shape: { status, creator, title, format, thumb, duration, cached, dl }
        if (res?.data?.dl) {
                return {
                        download: res.data.dl,
                        title: res.data.title,
                        thumbnail: res.data.thumb
                };
        }
        throw new Error('Okatsu ytmp3 returned no download');
}

async function getLocalDownloadByUrl(youtubeUrl) {
        const result = await ytdlDownloader.mp3(youtubeUrl);
        if (!result?.path) {
                throw new Error('Local YouTube downloader returned no file path');
        }

        const audioBuffer = await fs.promises.readFile(result.path);
        try {
                await fs.promises.unlink(result.path);
        } catch (_) {
                // Ignore cleanup errors for temporary local downloads.
        }

        if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error('Local YouTube downloader returned an empty file');
        }

        return {
                buffer: audioBuffer,
                title: result?.meta?.title || 'YouTube Audio',
                thumbnail: result?.meta?.image || result?.meta?.thumbnail
        };
}

function extractYouTubeId(input = '') {
        return (input.match(/(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)?)([a-zA-Z0-9_-]{11})/) || [])[1] || '';
}

function formatDuration(seconds) {
        const total = Number(seconds);
        if (!Number.isFinite(total) || total < 0) return '';

        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);

        if (h > 0) {
                return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
        }
        return [m, s].map(n => String(n).padStart(2, '0')).join(':');
}

async function resolveVideoFromInput(query) {
        if (query.includes('youtube.com') || query.includes('youtu.be')) {
                const matchedUrl = query.match(/https?:\/\/[^\s]+/i);
                const ytUrl = matchedUrl ? matchedUrl[0] : query;
                const ytId = extractYouTubeId(ytUrl);
                const fallbackThumb = ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : undefined;

                let metadata = null;
                try {
                        const searchByUrl = await yts(ytUrl);
                        const videos = searchByUrl?.videos || [];
                        metadata = ytId
                                ? videos.find(v => extractYouTubeId(v.url || '') === ytId) || videos[0] || null
                                : videos[0] || null;
                } catch (_) {
                        metadata = null;
                }

                return {
                        url: ytUrl,
                        title: metadata?.title || 'YouTube Audio',
                        timestamp: metadata?.timestamp || formatDuration(metadata?.seconds),
                        thumbnail: metadata?.thumbnail || fallbackThumb
                };
        }

        const search = await yts(query);
        if (!search || !search.videos.length) return null;
        return search.videos[0];
}

async function songCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const query = text.split(' ').slice(1).join(' ').trim();

        if (!query) {
            await sock.sendMessage(chatId, { text: 'Usage: .song <song name or YouTube link>' }, { quoted: message });
            return;
        }

        const video = await resolveVideoFromInput(query);
        if (!video) {
                await sock.sendMessage(chatId, { text: 'No results found.' }, { quoted: message });
                return;
        }

        // Inform user
        if (video.thumbnail) {
                await sock.sendMessage(chatId, {
                        image: { url: video.thumbnail },
                        caption: `🎵 Downloading: *${video.title || 'Audio'}*\n⏱ Duration: ${video.timestamp || '-'}`
                }, { quoted: message });
        } else {
                await sock.sendMessage(chatId, {
                        text: `🎵 Downloading: *${video.title || 'Audio'}*\n⏱ Duration: ${video.timestamp || '-'}`
                }, { quoted: message });
        }

                // Try multiple APIs with fallback chain: EliteProTech -> Yupra -> Okatsu
                let audioData;
                let audioBuffer;
                let downloadSuccess = false;
                
                // List of API methods to try
                const apiMethods = [
                        { name: 'EliteProTech', method: () => getEliteProTechDownloadByUrl(video.url) },
                        { name: 'Yupra', method: () => getYupraDownloadByUrl(video.url) },
                        { name: 'Okatsu', method: () => getOkatsuDownloadByUrl(video.url) },
                        { name: 'Keith', method: () => getKeithDownloadByUrl(video.url) },
                        { name: 'Aioo', method: () => getAiooDownloadByUrl(video.url) }
                ];
                
                // Try each API until we successfully download audio
                for (const apiMethod of apiMethods) {
                        try {
                                audioData = await apiMethod.method();
                                const audioUrl = audioData.download || audioData.dl || audioData.url;
                                
                                if (!audioUrl) {
                                        console.log(`${apiMethod.name} returned no download URL, trying next API...`);
                                        continue; // Try next API
                                }
                                
                                // Try to download the audio file - arraybuffer first
                                try {
                                        const audioResponse = await axios.get(audioUrl, {
                                                responseType: 'arraybuffer',
                                                timeout: 90000,
                                                maxContentLength: Infinity,
                                                maxBodyLength: Infinity,
                                                decompress: true,
                                                validateStatus: s => s >= 200 && s < 400,
                                                headers: {
                                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                                        'Accept': '*/*',
                                                        'Accept-Encoding': 'identity'
                                                }
                                        });
                                        audioBuffer = Buffer.from(audioResponse.data);
                                        
                                        // Validate buffer
                                        if (audioBuffer && audioBuffer.length > 0) {
                                                downloadSuccess = true;
                                                break; // Success! Exit the loop
                                        }
                                } catch (downloadErr) {
                                        // Check if it's a 451 error or other client/server error
                                        const statusCode = downloadErr.response?.status || downloadErr.status;
                                        if (statusCode === 451) {
                                                console.log(`Download blocked (451) from ${apiMethod.name}, trying next API...`);
                                                continue; // Try next API
                                        }
                                        
                                        // Try stream mode as fallback for this URL
                                        try {
                                                const audioResponse = await axios.get(audioUrl, {
                                                        responseType: 'stream',
                                                        timeout: 90000,
                                                        maxContentLength: Infinity,
                                                        maxBodyLength: Infinity,
                                                        validateStatus: s => s >= 200 && s < 400,
                                                        headers: {
                                                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                                                'Accept': '*/*',
                                                                'Accept-Encoding': 'identity'
                                                        }
                                                });
                                                const chunks = [];
                                                await new Promise((resolve, reject) => {
                                                        audioResponse.data.on('data', c => chunks.push(c));
                                                        audioResponse.data.on('end', resolve);
                                                        audioResponse.data.on('error', reject);
                                                });
                                                audioBuffer = Buffer.concat(chunks);
                                                
                                                if (audioBuffer && audioBuffer.length > 0) {
                                                        downloadSuccess = true;
                                                        break; // Success! Exit the loop
                                                }
                                        } catch (streamErr) {
                                                // Stream mode also failed, try next API
                                                const streamStatusCode = streamErr.response?.status || streamErr.status;
                                                if (streamStatusCode === 451) {
                                                        console.log(`Stream download blocked (451) from ${apiMethod.name}, trying next API...`);
                                                } else {
                                                        console.log(`Stream download failed from ${apiMethod.name}:`, streamErr.message);
                                                }
                                                continue; // Try next API
                                        }
                                }
                        } catch (apiErr) {
                                // API call failed, try next API
                                console.log(`${apiMethod.name} API failed:`, apiErr.message);
                                continue;
                        }
                }
                
                // If all APIs failed, fall back to the local YouTube downloader.
                if (!downloadSuccess || !audioBuffer) {
                        try {
                                const localDownload = await getLocalDownloadByUrl(video.url);
                                audioBuffer = localDownload.buffer;
                                audioData = {
                                        title: localDownload.title || audioData?.title || video.title
                                };
                                downloadSuccess = true;
                        } catch (localErr) {
                                console.log('Local YouTube download failed:', localErr.message);
                                throw new Error('All download sources failed. The content may be unavailable or blocked in your region.');
                        }
                }

                // Validate buffer
                if (!audioBuffer || audioBuffer.length === 0) {
                        throw new Error('Downloaded audio buffer is empty');
                }

                // Detect actual file format from signature
                const firstBytes = audioBuffer.slice(0, 12);
                const hexSignature = firstBytes.toString('hex');
                const asciiSignature = firstBytes.toString('ascii', 4, 8);

                let actualMimetype = 'audio/mpeg';
                let fileExtension = 'mp3';
                let detectedFormat = 'unknown';

                // Check for MP4/M4A (ftyp box)
                if (asciiSignature === 'ftyp' || hexSignature.startsWith('000000')) {
                        // Check if it's M4A (audio/mp4)
                        const ftypBox = audioBuffer.slice(4, 8).toString('ascii');
                        if (ftypBox === 'ftyp') {
                                detectedFormat = 'M4A/MP4';
                                actualMimetype = 'audio/mp4';
                                fileExtension = 'm4a';
                        }
                }
                // Check for MP3 (ID3 tag or MPEG frame sync)
                else if (audioBuffer.toString('ascii', 0, 3) === 'ID3' || 
                         (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)) {
                        detectedFormat = 'MP3';
                        actualMimetype = 'audio/mpeg';
                        fileExtension = 'mp3';
                }
                // Check for OGG/Opus
                else if (audioBuffer.toString('ascii', 0, 4) === 'OggS') {
                        detectedFormat = 'OGG/Opus';
                        actualMimetype = 'audio/ogg; codecs=opus';
                        fileExtension = 'ogg';
                }
                // Check for WAV
                else if (audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
                        detectedFormat = 'WAV';
                        actualMimetype = 'audio/wav';
                        fileExtension = 'wav';
                }
                else {
                        // Default to M4A since that's what the signature often suggests
                        actualMimetype = 'audio/mp4';
                        fileExtension = 'm4a';
                        detectedFormat = 'Unknown (defaulting to M4A)';
                }

                // Convert to MP3 if not already MP3
                let finalBuffer = audioBuffer;
                let finalMimetype = 'audio/mpeg';
                let finalExtension = 'mp3';

                if (fileExtension !== 'mp3') {
                        try {
                                finalBuffer = await toAudio(audioBuffer, fileExtension);
                                if (!finalBuffer || finalBuffer.length === 0) {
                                        throw new Error('Conversion returned empty buffer');
                                }
                                finalMimetype = 'audio/mpeg';
                                finalExtension = 'mp3';
                        } catch (convErr) {
                                throw new Error(`Failed to convert ${detectedFormat} to MP3: ${convErr.message}`);
                        }
                }

                // Send buffer as MP3
                await sock.sendMessage(chatId, {
                        audio: finalBuffer,
                        mimetype: finalMimetype,
                        fileName: `${(audioData.title || video.title || 'song').replace(/[^\w\s-]/g, '')}.${finalExtension}`,
                        ptt: false
                }, { quoted: message });

                // Cleanup: Delete temp files created during conversion
                try {
                        const tempDir = path.join(__dirname, '../temp');
                        if (fs.existsSync(tempDir)) {
                                const files = fs.readdirSync(tempDir);
                                const now = Date.now();
                                files.forEach(file => {
                                        const filePath = path.join(tempDir, file);
                                        try {
                                                const stats = fs.statSync(filePath);
                                                // Delete temp files older than 10 seconds (conversion temp files)
                                                if (now - stats.mtimeMs > 10000) {
                                                        // Check if it's a temp audio file (mp3, m4a, or numeric timestamp files from converter)
                                                        if (file.endsWith('.mp3') || file.endsWith('.m4a') || /^\d+\.(mp3|m4a)$/.test(file)) {
                                                                fs.unlinkSync(filePath);
                                                        }
                                                }
                                        } catch (e) {
                                                // Ignore individual file errors
                                        }
                                });
                        }
                } catch (cleanupErr) {
                        // Ignore cleanup errors
                }

    } catch (err) {
        console.error('Song command error:', err);
        
        // Provide more specific error messages
        let errorMessage = '❌ Failed to download song.';
        if (err.message && err.message.includes('blocked')) {
            errorMessage = '❌ Download blocked. The content may be unavailable in your region or due to legal restrictions.';
        } else if (err.response?.status === 451 || err.status === 451) {
            errorMessage = '❌ Content unavailable (451). This may be due to legal restrictions or regional blocking.';
        } else if (err.message && err.message.includes('All download sources failed')) {
            errorMessage = '❌ All download sources failed. The content may be unavailable or blocked.';
        }
        
        await sock.sendMessage(chatId, { 
            text: errorMessage 
        }, { quoted: message });
    }
}

module.exports = songCommand;