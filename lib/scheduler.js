const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const scheduleFile = path.join(__dirname, '../data/schedules.json');

let schedulerInterval = null;
let activeSock = null;
let isTickRunning = false;

function getSchedulerTimeZone() {
    delete require.cache[require.resolve('../settings')];
    const settings = require('../settings');
    const configured = (settings.timeZone || '').trim();
    if (configured && moment.tz.zone(configured)) return configured;
    return 'UTC';
}

function ensureScheduleFile() {
    if (!fs.existsSync(scheduleFile)) {
        fs.writeFileSync(scheduleFile, JSON.stringify([], null, 2));
    }
}

function readSchedules() {
    try {
        ensureScheduleFile();
        const raw = fs.readFileSync(scheduleFile, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Failed to read schedules:', error.message);
        return [];
    }
}

function writeSchedules(schedules) {
    try {
        fs.writeFileSync(scheduleFile, JSON.stringify(schedules, null, 2));
        return true;
    } catch (error) {
        console.error('Failed to save schedules:', error.message);
        return false;
    }
}

function normalizeHHMM(value) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value || '').trim());
    if (!match) return null;
    const hour = String(Number(match[1])).padStart(2, '0');
    const minute = match[2];
    return `${hour}:${minute}`;
}

function parseDateString(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;

    const [year, month, day] = value.split('-').map(Number);
    if (
        date.getFullYear() !== year ||
        date.getMonth() + 1 !== month ||
        date.getDate() !== day
    ) {
        return null;
    }

    return value;
}

function formatDateTime(timestamp) {
    return moment(timestamp).tz(getSchedulerTimeZone()).format('YYYY-MM-DD HH:mm');
}

function computeNextDailyRun(time, now = new Date()) {
    const [hours, minutes] = time.split(':').map(Number);
    const zone = getSchedulerTimeZone();
    const current = moment(typeof now === 'number' ? now : now.getTime()).tz(zone);
    const next = current.clone().hour(hours).minute(minutes).second(0).millisecond(0);

    if (next.valueOf() <= current.valueOf()) {
        next.add(1, 'day');
    }

    return next.valueOf();
}

function computeOnceRun(date, time) {
    const runAt = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', true, getSchedulerTimeZone());
    if (!runAt.isValid()) return null;
    return runAt.valueOf();
}

function buildScheduleId(existing) {
    let id = 1;
    const used = new Set(existing.map((item) => Number(item.id)).filter((n) => !Number.isNaN(n)));
    while (used.has(id)) id += 1;
    return id;
}

function addDailySchedule(chatId, messageText, time, createdBy) {
    const normalizedTime = normalizeHHMM(time);
    if (!normalizedTime) {
        return { ok: false, error: 'Format masa tak sah. Guna HH:MM, contoh 08:30.' };
    }

    const schedules = readSchedules();
    const id = buildScheduleId(schedules);
    const now = Date.now();

    const schedule = {
        id,
        chatId,
        message: messageText,
        type: 'daily',
        time: normalizedTime,
        nextRunAt: computeNextDailyRun(normalizedTime),
        createdBy,
        createdAt: now
    };

    schedules.push(schedule);
    if (!writeSchedules(schedules)) {
        return { ok: false, error: 'Gagal simpan jadual.' };
    }

    return { ok: true, schedule };
}

function addOnceSchedule(chatId, messageText, date, time, createdBy) {
    const normalizedDate = parseDateString(date);
    if (!normalizedDate) {
        return { ok: false, error: 'Format tarikh tak sah. Guna YYYY-MM-DD.' };
    }

    const normalizedTime = normalizeHHMM(time);
    if (!normalizedTime) {
        return { ok: false, error: 'Format masa tak sah. Guna HH:MM, contoh 21:45.' };
    }

    const runAt = computeOnceRun(normalizedDate, normalizedTime);
    if (!runAt) {
        return { ok: false, error: 'Tarikh/massa tak sah.' };
    }

    if (runAt <= Date.now()) {
        return { ok: false, error: 'Masa jadual mesti pada masa depan.' };
    }

    const schedules = readSchedules();
    const id = buildScheduleId(schedules);
    const now = Date.now();

    const schedule = {
        id,
        chatId,
        message: messageText,
        type: 'once',
        date: normalizedDate,
        time: normalizedTime,
        nextRunAt: runAt,
        createdBy,
        createdAt: now
    };

    schedules.push(schedule);
    if (!writeSchedules(schedules)) {
        return { ok: false, error: 'Gagal simpan jadual.' };
    }

    return { ok: true, schedule };
}

function deleteSchedule(chatId, id) {
    const scheduleId = Number(id);
    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
        return { ok: false, error: 'ID jadual tak sah.' };
    }

    const schedules = readSchedules();
    const index = schedules.findIndex((item) => Number(item.id) === scheduleId && item.chatId === chatId);
    if (index === -1) {
        return { ok: false, error: 'Jadual tak dijumpai untuk chat ini.' };
    }

    const [removed] = schedules.splice(index, 1);
    if (!writeSchedules(schedules)) {
        return { ok: false, error: 'Gagal padam jadual.' };
    }

    return { ok: true, removed };
}

function clearSchedules(chatId) {
    const schedules = readSchedules();
    const remaining = schedules.filter((item) => item.chatId !== chatId);
    const removedCount = schedules.length - remaining.length;

    if (!writeSchedules(remaining)) {
        return { ok: false, error: 'Gagal kosongkan jadual.' };
    }

    return { ok: true, removedCount };
}

function listSchedules(chatId) {
    return readSchedules()
        .filter((item) => item.chatId === chatId)
        .sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt));
}

function listAllSchedules() {
    return readSchedules().sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt));
}

function updateScheduleById(id, updates = {}) {
    const scheduleId = Number(id);
    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
        return { ok: false, error: 'ID jadual tak sah.' };
    }

    const schedules = readSchedules();
    const index = schedules.findIndex((item) => Number(item.id) === scheduleId);
    if (index === -1) {
        return { ok: false, error: 'Jadual tak dijumpai.' };
    }

    const current = schedules[index];
    const next = { ...current };

    if (typeof updates.chatId === 'string' && updates.chatId.trim()) {
        next.chatId = updates.chatId.trim();
    }

    if (typeof updates.message === 'string') {
        const cleanedMessage = updates.message.trim();
        if (!cleanedMessage) return { ok: false, error: 'Mesej jadual tak boleh kosong.' };
        next.message = cleanedMessage;
    }

    const requestedType = typeof updates.type === 'string' ? updates.type.trim().toLowerCase() : next.type;
    if (requestedType !== 'daily' && requestedType !== 'once') {
        return { ok: false, error: 'Jenis jadual tak sah. Guna daily atau once.' };
    }
    next.type = requestedType;

    if (next.type === 'daily') {
        const normalizedTime = normalizeHHMM(typeof updates.time === 'string' ? updates.time : next.time);
        if (!normalizedTime) {
            return { ok: false, error: 'Format masa tak sah. Guna HH:MM.' };
        }
        next.time = normalizedTime;
        delete next.date;
        next.nextRunAt = computeNextDailyRun(normalizedTime);
    } else {
        const normalizedDate = parseDateString(typeof updates.date === 'string' ? updates.date : next.date);
        if (!normalizedDate) {
            return { ok: false, error: 'Format tarikh tak sah. Guna YYYY-MM-DD.' };
        }

        const normalizedTime = normalizeHHMM(typeof updates.time === 'string' ? updates.time : next.time);
        if (!normalizedTime) {
            return { ok: false, error: 'Format masa tak sah. Guna HH:MM.' };
        }

        const runAt = computeOnceRun(normalizedDate, normalizedTime);
        if (!runAt || runAt <= Date.now()) {
            return { ok: false, error: 'Masa jadual sekali mesti pada masa depan.' };
        }

        next.date = normalizedDate;
        next.time = normalizedTime;
        next.nextRunAt = runAt;
    }

    schedules[index] = next;
    if (!writeSchedules(schedules)) {
        return { ok: false, error: 'Gagal kemas kini jadual.' };
    }

    return { ok: true, schedule: next };
}

async function runSchedule(sock, schedule) {
    try {
        if (!sock || !sock.user) {
            console.warn(`⏰ Skipping scheduled message ${schedule.id}: bot not connected yet`);
            return false;
        }
        await sock.sendMessage(schedule.chatId, {
            text: `⏰ *Scheduled Message*\n\n${schedule.message}`
        });
    } catch (error) {
        console.error(`Failed to send scheduled message ${schedule.id}:`, error.message);
        return false;
    }
    return true;
}

async function tickScheduler() {
    if (!activeSock || isTickRunning) return;
    isTickRunning = true;

    try {
        const schedules = readSchedules();
        if (!schedules.length) return;

        const now = Date.now();
        let changed = false;
        const nextSchedules = [];

        for (const schedule of schedules) {
            if (!schedule || !schedule.chatId || !schedule.message || !schedule.nextRunAt) {
                changed = true;
                continue;
            }

            if (Number(schedule.nextRunAt) <= now) {
                await runSchedule(activeSock, schedule);

                if (schedule.type === 'daily') {
                    schedule.nextRunAt = computeNextDailyRun(schedule.time, new Date(now + 1000));
                    changed = true;
                    nextSchedules.push(schedule);
                } else {
                    changed = true;
                }
            } else {
                nextSchedules.push(schedule);
            }
        }

        if (changed || nextSchedules.length !== schedules.length) {
            writeSchedules(nextSchedules);
        }
    } catch (error) {
        console.error('Scheduler tick error:', error.message);
    } finally {
        isTickRunning = false;
    }
}

function startScheduler(sock) {
    activeSock = sock;

    if (schedulerInterval) return;

    ensureScheduleFile();
    schedulerInterval = setInterval(() => {
        tickScheduler();
    }, 30 * 1000);

    tickScheduler();
    console.log('⏰ Scheduler started');
}

module.exports = {
    startScheduler,
    listSchedules,
    listAllSchedules,
    addDailySchedule,
    addOnceSchedule,
    updateScheduleById,
    deleteSchedule,
    clearSchedules,
    formatDateTime
};
