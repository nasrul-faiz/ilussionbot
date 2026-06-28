const {
    listSchedules,
    listAllSchedules,
    addDailySchedule,
    addOnceSchedule,
    deleteSchedule,
    clearSchedules,
    formatDateTime
} = require('../lib/scheduler');

function buildHelpText() {
    return [
        '⏰ *Schedule Command*',
        '',
        '• `.schedule daily HH:MM | mesej`',
        '• `.schedule once YYYY-MM-DD HH:MM | mesej`',
        '• `.schedule buat HH:MM | mesej`',
        '• `.schedule buat YYYY-MM-DD HH:MM | mesej`',
        '• `.schedule buat daily HH:MM | mesej`',
        '• `.schedule buat once YYYY-MM-DD HH:MM | mesej`',
        '• `.schedule list`',
        '• `.schedule delete <id>`',
        '• `.schedule clear`',
        '',
        'Contoh:',
        '`.schedule daily 08:30 | Selamat pagi semua`',
        '`.schedule buat 08:30 | Selamat pagi semua`',
        '`.schedule buat 2026-06-21 21:00 | Meeting malam ini`',
        '`.schedule buat daily 08:30 | Selamat pagi semua`',
        '`.schedule once 2026-06-21 21:00 | Meeting malam ini`'
    ].join('\n');
}

function normalizeScheduledText(text) {
    return String(text || '')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .trim();
}

function parseBuatAlias(inputText, sub) {
    const marker = `${sub}`;
    const markerIndex = inputText.toLowerCase().indexOf(marker);
    const tail = markerIndex >= 0
        ? inputText.slice(markerIndex + marker.length).trim()
        : '';

    if (!tail) {
        return { ok: false, error: 'Guna: `.schedule buat HH:MM | mesej` atau `.schedule buat YYYY-MM-DD HH:MM | mesej`' };
    }

    const [leftRaw, ...rest] = tail.split('|');
    const left = String(leftRaw || '').trim();
    const messageText = normalizeScheduledText(rest.join('|'));

    if (!messageText) {
        return { ok: false, error: 'Mesej jadual tak boleh kosong.' };
    }

    if (/^(daily|once)\b/i.test(left)) {
        return {
            ok: true,
            normalizedText: `.schedule ${left}${rest.length ? ` | ${rest.join('|').trim()}` : ''}`,
            sub: left.split(/\s+/)[0].toLowerCase(),
        };
    }

    if (/^([01]?\d|2[0-3]):([0-5]\d)$/.test(left)) {
        return {
            ok: true,
            normalizedText: `.schedule daily ${left} | ${messageText}`,
            sub: 'daily',
        };
    }

    if (/^\d{4}-\d{2}-\d{2}\s+([01]?\d|2[0-3]):([0-5]\d)$/.test(left)) {
        return {
            ok: true,
            normalizedText: `.schedule once ${left} | ${messageText}`,
            sub: 'once',
        };
    }

    return {
        ok: false,
        error: 'Format `buat` tak sah. Contoh: `.schedule buat 08:30 | Selamat pagi` atau `.schedule buat 2026-06-21 21:00 | Meeting`',
    };
}

async function getChatLabel(sock, chatId) {
    if (!chatId) return 'Unknown';
    if (!chatId.endsWith('@g.us')) return chatId;

    try {
        const meta = await sock.groupMetadata(chatId);
        const subject = (meta && meta.subject) ? String(meta.subject).trim() : '';
        return subject || chatId;
    } catch (_) {
        return chatId;
    }
}

async function scheduleCommand(sock, chatId, message, rawText, senderId) {
    const inputText = String(rawText || '').trim();
    const inputParts = inputText.split(/\s+/);
    let sub = (inputParts[1] || '').toLowerCase();
    let normalizedText = inputText;

    if (sub === 'buat' || sub === 'add') {
        const parsed = parseBuatAlias(inputText, sub);
        if (!parsed.ok) {
            await sock.sendMessage(chatId, { text: parsed.error }, { quoted: message });
            return;
        }

        normalizedText = parsed.normalizedText;
        sub = parsed.sub;
    }

    const parts = normalizedText.split(/\s+/);

    if (!sub) {
        await sock.sendMessage(chatId, { text: buildHelpText() }, { quoted: message });
        return;
    }

    if (sub === 'list') {
        if (chatId.endsWith('@g.us')) {
            const schedules = listSchedules(chatId);
            if (!schedules.length) {
                await sock.sendMessage(chatId, { text: 'Tiada scheduled chat untuk group ini.' }, { quoted: message });
                return;
            }

            const lines = ['📋 *Scheduled Chat List*', ''];
            for (const item of schedules) {
                const typeLabel = item.type === 'daily' ? 'daily' : 'once';
                const preview = item.message.length > 60 ? `${item.message.slice(0, 57)}...` : item.message;
                lines.push(`#${item.id} [${typeLabel}] ${formatDateTime(item.nextRunAt)}`);
                lines.push(`Pesan: ${preview}`);
                lines.push('');
            }

            await sock.sendMessage(chatId, { text: lines.join('\n').trim() }, { quoted: message });
            return;
        }

        const allSchedules = listAllSchedules();
        if (!allSchedules.length) {
            await sock.sendMessage(chatId, { text: 'Tiada scheduled chat lagi.' }, { quoted: message });
            return;
        }

        const grouped = allSchedules.reduce((acc, item) => {
            const key = item.chatId || 'unknown';
            if (!acc[key]) acc[key] = [];
            acc[key].push(item);
            return acc;
        }, {});

        const groupIds = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);
        const lines = ['📋 *Scheduled Chat List (By Group)*', ''];

        for (const groupId of groupIds) {
            const label = await getChatLabel(sock, groupId);
            lines.push(`👥 ${label}`);
            lines.push(`ID: ${groupId}`);

            for (const item of grouped[groupId]) {
                const typeLabel = item.type === 'daily' ? 'daily' : 'once';
                const preview = item.message.length > 60 ? `${item.message.slice(0, 57)}...` : item.message;
                lines.push(`- #${item.id} [${typeLabel}] ${formatDateTime(item.nextRunAt)}`);
                lines.push(`  Pesan: ${preview}`);
            }

            lines.push('');
        }

        await sock.sendMessage(chatId, { text: lines.join('\n').trim() }, { quoted: message });
        return;
    }

    if (sub === 'delete' || sub === 'del' || sub === 'remove') {
        const idArg = parts[2];
        if (!idArg) {
            await sock.sendMessage(chatId, { text: 'Guna: `.schedule delete <id>`' }, { quoted: message });
            return;
        }

        const result = deleteSchedule(chatId, idArg);
        if (!result.ok) {
            await sock.sendMessage(chatId, { text: `❌ ${result.error}` }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: `✅ Jadual #${result.removed.id} berjaya dipadam.` }, { quoted: message });
        return;
    }

    if (sub === 'clear') {
        const result = clearSchedules(chatId);
        if (!result.ok) {
            await sock.sendMessage(chatId, { text: `❌ ${result.error}` }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: `✅ ${result.removedCount} jadual dipadam untuk chat ini.` }, { quoted: message });
        return;
    }

    if (sub === 'daily') {
        const payload = normalizedText.slice(normalizedText.toLowerCase().indexOf('daily') + 5).trim();
        const [left, ...rest] = payload.split('|');
        const msgText = normalizeScheduledText(rest.join('|'));
        const time = (left || '').trim();

        if (!time || !msgText) {
            await sock.sendMessage(chatId, {
                text: 'Guna: `.schedule daily HH:MM | mesej`\nContoh: `.schedule daily 08:30 | Selamat pagi`'
            }, { quoted: message });
            return;
        }

        const result = addDailySchedule(chatId, msgText, time, senderId);
        if (!result.ok) {
            await sock.sendMessage(chatId, { text: `❌ ${result.error}` }, { quoted: message });
            return;
        }

        const item = result.schedule;
        await sock.sendMessage(chatId, {
            text: `✅ Jadual harian berjaya ditambah.\nID: #${item.id}\nSetiap hari: ${item.time}\nRun seterusnya: ${formatDateTime(item.nextRunAt)}`
        }, { quoted: message });
        return;
    }

    if (sub === 'once') {
        const payload = normalizedText.slice(normalizedText.toLowerCase().indexOf('once') + 4).trim();
        const [left, ...rest] = payload.split('|');
        const msgText = normalizeScheduledText(rest.join('|'));
        const timeParts = (left || '').trim().split(/\s+/);

        if (timeParts.length < 2 || !msgText) {
            await sock.sendMessage(chatId, {
                text: 'Guna: `.schedule once YYYY-MM-DD HH:MM | mesej`\nContoh: `.schedule once 2026-06-21 21:00 | Meeting malam ini`'
            }, { quoted: message });
            return;
        }

        const date = timeParts[0];
        const time = timeParts[1];
        const result = addOnceSchedule(chatId, msgText, date, time, senderId);

        if (!result.ok) {
            await sock.sendMessage(chatId, { text: `❌ ${result.error}` }, { quoted: message });
            return;
        }

        const item = result.schedule;
        await sock.sendMessage(chatId, {
            text: `✅ Jadual sekali berjaya ditambah.\nID: #${item.id}\nTarikh: ${item.date} ${item.time}\nRun: ${formatDateTime(item.nextRunAt)}`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { text: buildHelpText() }, { quoted: message });
}

module.exports = scheduleCommand;
