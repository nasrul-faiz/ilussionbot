const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const isOwnerOrSudo = require('../lib/isOwner');
const { refreshRuntimeSettings, getCurrentSettings } = require('../lib/runtimeSettings');

function replaceStringSetting(content, key, value) {
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const pattern = new RegExp(`(${key}\\s*:\\s*)('(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\")`);
    if (!pattern.test(content)) {
        throw new Error(`Tetapan ${key} tidak dijumpai dalam settings.js.`);
    }

    return content.replace(pattern, `$1'${escaped}'`);
}

module.exports = async function setTimezoneCommand(sock, chatId, message, rawText) {
    try {
        const senderId = message.key.participant || message.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

        if (!message.key.fromMe && !isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Command ini hanya untuk owner/sudo.' }, { quoted: message });
            return;
        }

        const input = String(rawText || '').trim();
        const parts = input.split(/\s+/);
        const requestedZone = (parts[1] || '').trim();

        const currentSettings = getCurrentSettings('../settings');
        const currentZone = (currentSettings.timeZone || 'UTC').trim();

        if (!requestedZone) {
            await sock.sendMessage(chatId, {
                text: [
                    '🕒 *Timezone Bot*',
                    `Current: ${currentZone}`,
                    '',
                    'Guna:',
                    '• `.settimezone Asia/Kuala_Lumpur`',
                    '• `.timezone Asia/Jakarta`',
                    '',
                    'Tip: guna format IANA timezone (cth: Asia/Singapore, Europe/London).'
                ].join('\n')
            }, { quoted: message });
            return;
        }

        if (!moment.tz.zone(requestedZone)) {
            await sock.sendMessage(chatId, {
                text: `❌ Timezone tak sah: ${requestedZone}\nContoh sah: Asia/Kuala_Lumpur, Asia/Jakarta, UTC`
            }, { quoted: message });
            return;
        }

        const settingsPath = path.join(__dirname, '..', 'settings.js');
        let content = fs.readFileSync(settingsPath, 'utf8');
        content = replaceStringSetting(content, 'timeZone', requestedZone);
        fs.writeFileSync(settingsPath, content, 'utf8');

        refreshRuntimeSettings('../settings');

        await sock.sendMessage(chatId, {
            text: `✅ Timezone berjaya ditukar\nDari: ${currentZone}\nKe: ${requestedZone}`
        }, { quoted: message });
    } catch (error) {
        console.error('settimezone command error:', error);
        await sock.sendMessage(chatId, { text: `❌ Gagal kemas kini timezone: ${error.message}` }, { quoted: message });
    }
};