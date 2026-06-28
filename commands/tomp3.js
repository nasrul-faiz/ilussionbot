const { toAudio } = require('../lib/converter');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

async function toMp3Command(sock, chatId, message) {
    try {
        const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const videoMsg = quoted?.videoMessage;

        if (!videoMsg) {
            return await sock.sendMessage(chatId, {
                text: '📹 *Reply to a video message* with *.tomp3* to convert it to MP3 audio.'
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            text: '⏳ _Converting video to MP3, please wait..._'
        }, { quoted: message });

        const quotedMsg = {
            key: {
                remoteJid: chatId,
                id: message.message.extendedTextMessage.contextInfo.stanzaId,
                fromMe: message.message.extendedTextMessage.contextInfo.participant === sock.user?.id
            },
            message: quoted
        };

        const stream = await downloadContentFromMessage(videoMsg, 'video');
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const videoBuffer = Buffer.concat(chunks);

        if (!videoBuffer || videoBuffer.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to download the video. Please try again.'
            }, { quoted: message });
        }

        const mp3Buffer = await toAudio(videoBuffer, 'mp4');

        if (!mp3Buffer || mp3Buffer.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '❌ Conversion failed. Make sure ffmpeg is available.'
            }, { quoted: message });
        }

        const caption = videoMsg.caption ? videoMsg.caption.slice(0, 60) : 'video';
        const fileName = caption.replace(/[^\w\s-]/g, '').trim() || 'audio';

        await sock.sendMessage(chatId, {
            audio: mp3Buffer,
            mimetype: 'audio/mpeg',
            fileName: `${fileName}.mp3`,
            ptt: false
        }, { quoted: message });

    } catch (error) {
        console.error('[TOMP3] Error:', error.message);
        await sock.sendMessage(chatId, {
            text: '❌ Conversion failed. Please try again later.'
        }, { quoted: message });
    }
}

module.exports = toMp3Command;
