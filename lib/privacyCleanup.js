const fs = require('fs');
const path = require('path');

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJSON(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function removePathForce(targetPath) {
    try {
        fs.rmSync(targetPath, { recursive: true, force: true });
        return true;
    } catch (_) {
        return false;
    }
}

function clearSensitiveData(options = {}) {
    const steps = [];
    const errors = [];

    try {
        const {
            rootDir = path.join(__dirname, '..'),
            wipeSession = true,
            clearLogs = true,
        } = options || {};

        const dataDir = path.join(rootDir, 'data');
        const sessionDir = path.join(rootDir, 'session');

        try {
            fs.mkdirSync(dataDir, { recursive: true });
        } catch (e) {
            errors.push(`mkdir data failed: ${e.message}`);
        }

        try {
            const messageCountPath = path.join(dataDir, 'messageCount.json');
            const current = readJSON(messageCountPath, {});
            const isPublic = typeof current?.isPublic === 'boolean' ? current.isPublic : true;
            writeJSON(messageCountPath, { isPublic, messageCount: {} });
            steps.push('messageCount cleared');
        } catch (e) {
            errors.push(`messageCount clear failed: ${e.message}`);
        }

        try {
            writeJSON(path.join(dataDir, 'botInfo.json'), {});
            steps.push('botInfo cleared');
        } catch (e) {
            errors.push(`botInfo clear failed: ${e.message}`);
        }

        try {
            writeJSON(path.join(dataDir, 'userGroupData.json'), {});
            steps.push('userGroupData cleared');
        } catch (e) {
            errors.push(`userGroupData clear failed: ${e.message}`);
        }

        try {
            writeJSON(path.join(rootDir, 'baileys_store.json'), {
                chats: {},
                contacts: {},
                messages: {},
                groupMetadata: {}
            });
            steps.push('baileys_store cleared');
        } catch (e) {
            errors.push(`baileys_store clear failed: ${e.message}`);
        }

        try {
            writeJSON(path.join(dataDir, 'qrState.json'), {
                status: 'disconnected',
                timestamp: Date.now(),
            });
            steps.push('qrState updated');
        } catch (e) {
            errors.push(`qrState update failed: ${e.message}`);
        }

        if (clearLogs) {
            try {
                fs.writeFileSync(path.join(dataDir, 'bot.log'), '');
                if (Array.isArray(global.dashboardLogs)) global.dashboardLogs.length = 0;
                steps.push('logs cleared');
            } catch (e) {
                errors.push(`log clear failed: ${e.message}`);
            }
        }

        if (wipeSession) {
            try {
                removePathForce(sessionDir);
                fs.mkdirSync(sessionDir, { recursive: true });
                steps.push('session files cleared');
            } catch (e) {
                errors.push(`session clear failed: ${e.message}`);
            }
        }
    } catch (e) {
        errors.push(`cleanup fatal: ${e.message}`);
    }

    return {
        ok: errors.length === 0,
        steps,
        errors,
    };
}

module.exports = { clearSensitiveData };
