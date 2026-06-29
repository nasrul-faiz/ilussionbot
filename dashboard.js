const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const moment = require('moment-timezone')
const { isSuppressed, sanitizeLogText } = require('./lib/logFilter')
const {
    listAllSchedules,
    addDailySchedule,
    addOnceSchedule,
    updateScheduleById,
    deleteSchedule,
    formatDateTime,
} = require('./lib/scheduler')
const { refreshRuntimeSettings, getCurrentSettings } = require('./lib/runtimeSettings')

const app = express()
const PORT = process.env.PORT || 5000

const uploadsDir = path.join(__dirname, 'public', 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ''
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
    }
})
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } })

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// In-memory log buffer (shared with bot via global)
if (!global.dashboardLogs) global.dashboardLogs = []

// Intercept console.log/error for logs
const originalLog = console.log
const originalError = console.error
const originalStderrWrite = process.stderr.write.bind(process.stderr)
// Noise patterns to suppress from dashboard logs and (optionally) terminal.
// Set SUPPRESS_NOISY_SESSION_LOGS=0 to keep all raw session logs in terminal.
const SUPPRESS_NOISY_SESSION_LOGS = process.env.SUPPRESS_NOISY_SESSION_LOGS !== '0'

const LOG_FILE = path.join(__dirname, 'data', 'bot.log')

function addLog(level, args) {
    const raw = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    if (isSuppressed(raw)) return
    const msg = sanitizeLogText(raw)
    const entry = { time: Date.now(), level, msg }
    global.dashboardLogs.push(entry)
    if (global.dashboardLogs.length > 200) global.dashboardLogs.shift()
    // Also persist to file so background dashboard process can read it
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
        // Keep file under 500 lines
        const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
        if (lines.length > 500) fs.writeFileSync(LOG_FILE, lines.slice(-400).join('\n') + '\n')
    } catch (_) {}
}
function shouldPrintToTerminal(args) {
    if (!SUPPRESS_NOISY_SESSION_LOGS) return true
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    return !isSuppressed(msg)
}
const originalInfo = console.info
const originalWarn = console.warn
console.log = (...args) => {
    addLog('info', args)
    if (shouldPrintToTerminal(args)) originalLog(...args)
}
console.info = (...args) => {
    addLog('info', args)
    if (shouldPrintToTerminal(args)) originalInfo(...args)
}
console.warn = (...args) => {
    addLog('warn', args)
    if (shouldPrintToTerminal(args)) originalWarn(...args)
}
console.error = (...args) => {
    addLog('error', args)
    if (shouldPrintToTerminal(args)) originalError(...args)
}

process.stderr.write = function patchedStderrWrite(chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
    if (SUPPRESS_NOISY_SESSION_LOGS && isSuppressed(text)) {
        if (typeof callback === 'function') callback()
        return true
    }

    const sanitized = sanitizeLogText(text)
    return originalStderrWrite(sanitized, encoding, callback)
}

// ── Helper: safe JSON read ──────────────────────────────────────────────────
function readJSON(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return fallback
    }
}

const profilePicCache = {
    jid: null,
    url: null,
    fetchedAt: 0,
    ttlMs: 2 * 60 * 1000,
}

function resolveSelfJid(account, sockUser) {
    const raw = String(account?.id || sockUser?.id || '').trim()
    if (!raw) return null

    if (raw.includes(':')) {
        return `${raw.split(':')[0]}@s.whatsapp.net`
    }

    if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw
    if (/^\d+$/.test(raw)) return `${raw}@s.whatsapp.net`
    return raw
}

async function getLiveProfilePic(account) {
    const sock = global.botSocket
    if (!sock || typeof sock.profilePictureUrl !== 'function') return null

    const jid = resolveSelfJid(account, sock.user)
    if (!jid) return null

    const now = Date.now()
    if (
        profilePicCache.jid === jid &&
        profilePicCache.url &&
        now - profilePicCache.fetchedAt < profilePicCache.ttlMs
    ) {
        return profilePicCache.url
    }

    try {
        const url = await sock.profilePictureUrl(jid, 'image')
        if (url) {
            profilePicCache.jid = jid
            profilePicCache.url = url
            profilePicCache.fetchedAt = now
            return url
        }
    } catch (_) {}

    return null
}

function getTotalMessagesForChat(messageCount, chatId) {
    if (!messageCount || !chatId) return 0

    const direct = messageCount[chatId]
    if (typeof direct === 'number') return direct
    if (direct && typeof direct === 'object') {
        return Object.values(direct).reduce((sum, val) => sum + (typeof val === 'number' ? val : 0), 0)
    }

    const nested = messageCount.messageCount && messageCount.messageCount[chatId]
    if (typeof nested === 'number') return nested
    if (nested && typeof nested === 'object') {
        return Object.values(nested).reduce((sum, val) => sum + (typeof val === 'number' ? val : 0), 0)
    }

    return 0
}

function normalizeCommandCategory(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'General';
    return raw.slice(0, 32);
}

function getGroupNamesFromStore() {
    const map = new Map()
    try {
        const store = readJSON('./baileys_store.json', {})
        const chats = store && store.chats ? store.chats : {}

        if (Array.isArray(chats)) {
            for (const item of chats) {
                const id = String(item?.id || item?.jid || '').trim()
                if (!id.endsWith('@g.us')) continue
                const subject = (item?.subject || item?.name || item?.groupName || '').toString().trim()
                if (subject) map.set(id, subject)
            }
        } else if (chats && typeof chats === 'object') {
            for (const [id, data] of Object.entries(chats)) {
                if (!id.endsWith('@g.us')) continue
                const subject = (data && (data.subject || data.name || data.groupName) || '').toString().trim()
                if (subject) map.set(id, subject)
            }
        }
    } catch (_) {}
    return map
}

function getGroupIdsFromStore() {
    const ids = new Set()
    try {
        const store = readJSON('./baileys_store.json', {})

        const chats = store && store.chats ? store.chats : {}
        if (Array.isArray(chats)) {
            for (const item of chats) {
                const id = String(item?.id || item?.jid || '').trim()
                if (id.endsWith('@g.us')) ids.add(id)
            }
        } else if (chats && typeof chats === 'object') {
            for (const id of Object.keys(chats)) {
                if (String(id).endsWith('@g.us')) ids.add(String(id))
            }
        }

        const messages = store && store.messages && typeof store.messages === 'object' ? store.messages : {}
        for (const key of Object.keys(messages)) {
            if (String(key).endsWith('@g.us')) ids.add(String(key))
        }
    } catch (_) {}
    return ids
}

function getGroupIdsFromMessageCount(messageCount) {
    const ids = new Set()
    if (!messageCount || typeof messageCount !== 'object') return ids

    for (const key of Object.keys(messageCount)) {
        if (typeof key === 'string' && key.endsWith('@g.us')) ids.add(key)
    }

    const nested = messageCount.messageCount
    if (nested && typeof nested === 'object') {
        for (const key of Object.keys(nested)) {
            if (typeof key === 'string' && key.endsWith('@g.us')) ids.add(key)
        }
    }

    return ids
}

// ── API: Bot status ─────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
    const creds = readJSON('./session/creds.json')
    const settings = readJSON('./settings.json') || require('./settings')
    const banned = readJSON('./data/banned.json', [])
    const premium = readJSON('./data/premium.json', [])
    const warnings = readJSON('./data/warnings.json', {})
    const messageCount = readJSON('./data/messageCount.json', {})
    const qrState = readJSON('./data/qrState.json', {})
    const connected = !!(creds && creds.me && creds.registered) || qrState.status === 'connected'
    const account = creds?.me || null
    const botInfo = readJSON('./data/botInfo.json', {})

    const totalMessages = Object.values(messageCount).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
    const warningCount = Object.keys(warnings).length

    // Session file age
    let sessionMtime = null
    try {
        const credsPath = path.join(__dirname, 'session', 'creds.json')
        if (fs.existsSync(credsPath)) sessionMtime = fs.statSync(credsPath).mtimeMs
    } catch (_) {}

    // Platform detection
    let platform = 'Local'
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) platform = 'Railway'
    else if (process.env.REPL_ID || process.env.REPLIT_DB_URL) platform = 'Replit'

    let liveProfilePic = null
    try {
        liveProfilePic = await getLiveProfilePic(account)
    } catch (_) {}

    const profilePic = liveProfilePic || botInfo.profilePic || null
    if (liveProfilePic && liveProfilePic !== botInfo.profilePic) {
        try {
            const nextBotInfo = { ...botInfo, profilePic: liveProfilePic, updatedAt: Date.now() }
            fs.writeFileSync('./data/botInfo.json', JSON.stringify(nextBotInfo, null, 2))
        } catch (_) {}
    }

    res.json({
        connected,
        account,
        profilePic,
        uptime: process.uptime(),
        version: settings.version || '3.0.7',
        botName: settings.botName || 'Knight Bot',
        commandMode: settings.commandMode || 'public',
        ownerNumber: settings.ownerNumber || '',
        sessionMtime,
        hasSessionEnv: !!process.env.SESSION_ID,
        platform,
        qrStatus: qrState.status || 'unknown',
        stats: {
            banned: Array.isArray(banned) ? banned.length : Object.keys(banned).length,
            premium: Array.isArray(premium) ? premium.length : Object.keys(premium).length,
            warnings: warningCount,
            messages: totalMessages,
        }
    })
})

// ── API: Logs ───────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
    // Use in-memory logs if available, else read from file (background process mode)
    if (global.dashboardLogs && global.dashboardLogs.length > 0) {
        return res.json(global.dashboardLogs.slice(-100).reverse())
    }
    try {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
        const logs = lines.slice(-100).map(l => { try { return JSON.parse(l) } catch(_) { return null } }).filter(Boolean).reverse()
        return res.json(logs)
    } catch (_) {
        return res.json([])
    }
})

// ── API: Settings GET ───────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
    const settings = getCurrentSettings('../settings')
    res.json({
        botName: settings.botName,
        botOwner: settings.botOwner,
        ownerNumber: settings.ownerNumber,
        commandMode: settings.commandMode,
        timeZone: settings.timeZone,
        packname: settings.packname,
        author: settings.author,
        description: settings.description,
        aliveMessage: settings.aliveMessage,
        aliveMediaUrl: settings.aliveMediaUrl,
        aliveButtons: settings.aliveButtons,
        menuMessage: settings.menuMessage,
        menuMediaUrl: settings.menuMediaUrl,
        menuButtons: settings.menuButtons,
        commandReplyAsNormalMessage: settings.commandReplyAsNormalMessage !== false,
        version: settings.version,
    })
})

// ── API: Settings POST ──────────────────────────────────────────────────────
app.post('/api/settings', (req, res) => {
    try {
        const {
            botName,
            botOwner,
            ownerNumber,
            commandMode,
            commandReplyAsNormalMessage,
            timeZone,
            packname,
            description,
            aliveMessage,
            aliveMediaUrl,
            aliveButtons,
            menuMessage,
            menuMediaUrl,
            menuButtons,
        } = req.body
        const settingsPath = path.join(__dirname, 'settings.js')
        let content = fs.readFileSync(settingsPath, 'utf8')

        const replace = (key, value) => {
            const escaped = String(value)
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
            content = content.replace(
                new RegExp(`(${key}\\s*:\\s*)('(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\")`),
                `$1'${escaped}'`
            )
        }

        const replaceBoolean = (key, value) => {
            const normalized = !!value
            content = content.replace(
                new RegExp(`(${key}\\s*:\\s*)(true|false)`),
                `$1${normalized}`
            )
        }

        if (timeZone !== undefined) {
            const tz = String(timeZone).trim()
            if (!moment.tz.zone(tz)) {
                return res.status(400).json({ success: false, error: 'Timezone tidak sah. Guna format IANA seperti Asia/Kuala_Lumpur.' })
            }
        }

        if (botName !== undefined) replace('botName', botName)
        if (botOwner !== undefined) replace('botOwner', botOwner)
        if (ownerNumber !== undefined) replace('ownerNumber', ownerNumber)
        if (commandMode !== undefined) replace('commandMode', commandMode)
        if (commandReplyAsNormalMessage !== undefined) replaceBoolean('commandReplyAsNormalMessage', commandReplyAsNormalMessage)
        if (timeZone !== undefined) replace('timeZone', String(timeZone).trim())
        if (packname !== undefined) replace('packname', packname)
        if (description !== undefined) replace('description', description)
        if (aliveMessage !== undefined) replace('aliveMessage', aliveMessage)
        if (aliveMediaUrl !== undefined) replace('aliveMediaUrl', aliveMediaUrl)
        if (aliveButtons !== undefined) replace('aliveButtons', aliveButtons)
        if (menuMessage !== undefined) replace('menuMessage', menuMessage)
        if (menuMediaUrl !== undefined) replace('menuMediaUrl', menuMediaUrl)
        if (menuButtons !== undefined) replace('menuButtons', menuButtons)

        fs.writeFileSync(settingsPath, content, 'utf8')

        refreshRuntimeSettings('../settings')

        res.json({ success: true, message: 'Settings saved and applied instantly.', restarting: false })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Features state ─────────────────────────────────────────────────────
app.get('/api/features', (req, res) => {
    const autoStatus = readJSON('./data/autoStatus.json', { enabled: false })
    const autoRead = readJSON('./data/autoread.json', { enabled: false })
    const autoTyping = readJSON('./data/autotyping.json', { enabled: false })
    const antiDelete = readJSON('./data/antidelete.json', { enabled: false })

    res.json({
        autoStatus: autoStatus.enabled || false,
        autoRead: autoRead.enabled || false,
        autoTyping: autoTyping.enabled || false,
        antiDelete: antiDelete.enabled || false,
    })
})

// ── API: Features toggle ─────────────────────────────────────────────────────
app.post('/api/features/toggle', (req, res) => {
    const featureMap = {
        autoStatus: './data/autoStatus.json',
        autoRead:   './data/autoread.json',
        autoTyping: './data/autotyping.json',
        antiDelete: './data/antidelete.json',
    }
    const { key, enabled } = req.body
    if (!featureMap[key]) return res.status(400).json({ success: false, error: 'Unknown feature key.' })
    try {
        const current = readJSON(featureMap[key], { enabled: false })
        current.enabled = !!enabled
        fs.writeFileSync(featureMap[key], JSON.stringify(current, null, 2))
        res.json({ success: true, key, enabled: current.enabled })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Banned users ───────────────────────────────────────────────────────
app.get('/api/banned', (req, res) => {
    const banned = readJSON('./data/banned.json', [])
    res.json(Array.isArray(banned) ? banned : Object.keys(banned))
})

// ── API: QR Code state ──────────────────────────────────────────────────────
app.get('/api/session/qr', (req, res) => {
    const qrState = readJSON('./data/qrState.json', { status: 'unknown' })
    res.json(qrState)
})

// ── API: Session export (base64 encode creds.json for Railway SESSION_ID) ────
app.get('/api/session/export', (req, res) => {
    try {
        const credsPath = path.join(__dirname, 'session', 'creds.json')
        if (!fs.existsSync(credsPath)) {
            return res.status(404).json({ success: false, error: 'No active session. Connect bot first.' })
        }
        const creds = fs.readFileSync(credsPath)
        const b64 = creds.toString('base64')
        res.json({ success: true, sessionId: b64 })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Session reset (delete session → bot will regenerate QR) ────────────
app.post('/api/session/reset', (req, res) => {
    try {
        const sessionDir = path.join(__dirname, 'session')
        if (fs.existsSync(sessionDir)) {
            fs.readdirSync(sessionDir).forEach(f => {
                try { fs.unlinkSync(path.join(sessionDir, f)) } catch (_) {}
            })
        }
        try { fs.writeFileSync('./data/qrState.json', JSON.stringify({ status: 'resetting', timestamp: Date.now() })) } catch (_) {}
        try { fs.writeFileSync('./data/botInfo.json', JSON.stringify({})) } catch (_) {}
        res.json({ success: true, message: 'Session cleared. Bot will show QR code shortly.' })
        setTimeout(() => process.exit(1), 500)
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Media upload ────────────────────────────────────────────────────────
app.post('/api/upload-media', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' })
        const url = `/uploads/${req.file.filename}`
        res.json({ success: true, url, originalName: req.file.originalname, size: req.file.size })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Custom Commands GET ─────────────────────────────────────────────────
app.get('/api/custom-commands', (req, res) => {
    const cmds = readJSON('./data/customCommands.json', [])
    if (!Array.isArray(cmds)) return res.json([])

    const normalized = cmds.map((cmd) => ({
        ...cmd,
        category: normalizeCommandCategory(cmd.category)
    }))
    res.json(normalized)
})

function parseCustomCommandButtons(buttons) {
    if (buttons == null || buttons === '') return undefined

    let parsed = buttons
    if (typeof parsed === 'string') {
        const raw = parsed.trim()
        if (!raw) return undefined
        try {
            parsed = JSON.parse(raw)
        } catch (err) {
            throw new Error('Buttons must be valid JSON.')
        }
    }

    if (!Array.isArray(parsed)) {
        throw new Error('Buttons must be a JSON array.')
    }

    return parsed
}

// ── API: Custom Commands POST (add) ──────────────────────────────────────────
app.post('/api/custom-commands', (req, res) => {
    try {
        const { trigger, response, description, category, mediaUrl, mediaType, fileName, buttons } = req.body
        if (!trigger) return res.status(400).json({ success: false, error: 'Trigger is required.' })
        if (!response && !mediaUrl) return res.status(400).json({ success: false, error: 'At least a response text or media URL is required.' })

        const clean = trigger.trim().toLowerCase().replace(/\s+/g, '')
        if (!clean.startsWith('.')) return res.status(400).json({ success: false, error: 'Trigger must start with a dot (e.g. .hello)' })

        const parsedButtons = parseCustomCommandButtons(buttons)
        const cmds = readJSON('./data/customCommands.json', [])
        if (cmds.find(c => c.trigger === clean)) return res.status(409).json({ success: false, error: `Command ${clean} already exists.` })

        const entry = {
            trigger: clean,
            response: (response || '').trim(),
            description: (description || '').trim(),
            category: normalizeCommandCategory(category)
        }
        if (mediaUrl && mediaUrl.trim()) { entry.mediaUrl = mediaUrl.trim(); entry.mediaType = (mediaType || 'image').trim() }
        if (fileName && fileName.trim()) entry.fileName = fileName.trim()
        if (parsedButtons?.length) entry.buttons = parsedButtons
        cmds.push(entry)
        fs.writeFileSync('./data/customCommands.json', JSON.stringify(cmds, null, 2))
        res.json({ success: true, message: `Command ${clean} added!` })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Custom Commands PUT (edit) ──────────────────────────────────────────
app.put('/api/custom-commands/:trigger', (req, res) => {
    try {
        const key = decodeURIComponent(req.params.trigger).toLowerCase()
        const { response, description, category, mediaUrl, mediaType, fileName, buttons } = req.body
        if (!response && !mediaUrl) return res.status(400).json({ success: false, error: 'At least a response text or media URL is required.' })

        const parsedButtons = parseCustomCommandButtons(buttons)
        const cmds = readJSON('./data/customCommands.json', [])
        const idx = cmds.findIndex(c => c.trigger === key)
        if (idx === -1) return res.status(404).json({ success: false, error: 'Command not found.' })

        cmds[idx].response = (response || '').trim()
        cmds[idx].description = (description || '').trim()
        cmds[idx].category = normalizeCommandCategory(category)
        if (mediaUrl && mediaUrl.trim()) { cmds[idx].mediaUrl = mediaUrl.trim(); cmds[idx].mediaType = (mediaType || 'image').trim() }
        else { delete cmds[idx].mediaUrl; delete cmds[idx].mediaType }
        if (fileName && fileName.trim()) cmds[idx].fileName = fileName.trim()
        else delete cmds[idx].fileName
        if (parsedButtons?.length) cmds[idx].buttons = parsedButtons
        else delete cmds[idx].buttons
        fs.writeFileSync('./data/customCommands.json', JSON.stringify(cmds, null, 2))
        res.json({ success: true, message: `Command ${key} updated!` })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Custom Commands DELETE ───────────────────────────────────────────────
app.delete('/api/custom-commands/:trigger', (req, res) => {
    try {
        const key = decodeURIComponent(req.params.trigger).toLowerCase()
        let cmds = readJSON('./data/customCommands.json', [])
        const before = cmds.length
        cmds = cmds.filter(c => c.trigger !== key)
        if (cmds.length === before) return res.status(404).json({ success: false, error: 'Command not found.' })
        fs.writeFileSync('./data/customCommands.json', JSON.stringify(cmds, null, 2))
        res.json({ success: true, message: `Command ${key} deleted.` })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Analytics ─────────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
    try {
        const messageCount = readJSON('./data/messageCount.json', {})
        const userGroupData = readJSON('./data/userGroupData.json', {})
        const premium = readJSON('./data/premium.json', [])
        const warnings = readJSON('./data/warnings.json', {})
        
        // Calculate top users by message count
        const topUsers = Object.entries(messageCount)
            .map(([id, count]) => ({ id, count: typeof count === 'number' ? count : 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
        
        // Get group stats
        const groups = Object.entries(userGroupData)
            .filter(([id]) => id.endsWith('@g.us'))
            .map(([id, data]) => ({
                id,
                name: data.groupName || 'Unknown',
                members: data.members ? Object.keys(data.members).length : 0,
                messages: messageCount[id] || 0
            }))
            .sort((a, b) => b.messages - a.messages)
            .slice(0, 10)
        
        const premiumCount = Array.isArray(premium) ? premium.length : Object.keys(premium).length
        const totalMessages = Object.values(messageCount).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
        
        res.json({
            totalMessages,
            premiumUsers: premiumCount,
            totalWarnings: Object.keys(warnings).length,
            topUsers,
            topGroups: groups,
            stats: {
                avgMessagesPerUser: topUsers.length > 0 ? Math.round(totalMessages / topUsers.length) : 0,
                activeGroups: groups.length
            }
        })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Premium Users ──────────────────────────────────────────────────────────
app.get('/api/premium-users', (req, res) => {
    try {
        const premium = readJSON('./data/premium.json', [])
        const userData = readJSON('./data/userGroupData.json', {})
        
        const users = (Array.isArray(premium) ? premium : Object.keys(premium)).map(id => ({
            id,
            addedDate: userData[id]?.premiumDate || null,
            name: userData[id]?.name || 'Unknown'
        }))
        
        res.json(users)
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Premium Users POST (add/remove) ────────────────────────────────────────
app.post('/api/premium-users', (req, res) => {
    try {
        const { action, userId } = req.body
        if (!action || !userId) return res.status(400).json({ success: false, error: 'Action and userId required.' })
        
        let premium = readJSON('./data/premium.json', [])
        let userData = readJSON('./data/userGroupData.json', {})
        
        if (action === 'add') {
            if (!Array.isArray(premium)) premium = Object.keys(premium)
            if (!premium.includes(userId)) {
                premium.push(userId)
                userData[userId] = { ...userData[userId], premiumDate: new Date().toISOString() }
            } else {
                return res.status(409).json({ success: false, error: 'User already premium.' })
            }
        } else if (action === 'remove') {
            if (Array.isArray(premium)) {
                premium = premium.filter(id => id !== userId)
            } else {
                delete premium[userId]
            }
        } else {
            return res.status(400).json({ success: false, error: 'Invalid action.' })
        }
        
        fs.writeFileSync('./data/premium.json', JSON.stringify(premium, null, 2))
        fs.writeFileSync('./data/userGroupData.json', JSON.stringify(userData, null, 2))
        res.json({ success: true, message: `User ${action === 'add' ? 'added to' : 'removed from'} premium.` })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Groups Info ────────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
    try {
        const userGroupData = readJSON('./data/userGroupData.json', {})
        const messageCount = readJSON('./data/messageCount.json', {})
        const storeGroupNames = getGroupNamesFromStore()
        const storeGroupIds = getGroupIdsFromStore()

        const map = new Map()

        const entryObjects = Object.entries(userGroupData || {})
            .filter(([id]) => id.endsWith('@g.us'))
            .map(([id, data]) => ({ id, ...(data || {}) }))

        const legacyGroups = Array.isArray(userGroupData?.groups)
            ? userGroupData.groups
                .map((g) => ({
                    id: g?.id || g?.jid || g?.groupId || '',
                    groupName: g?.groupName || g?.name || 'Unknown',
                    members: g?.members || {},
                    admin: !!g?.admin,
                    joinDate: g?.joinDate || g?.joinedDate || null,
                }))
                .filter((g) => typeof g.id === 'string' && g.id.endsWith('@g.us'))
            : []

        const messageCountGroups = Array.from(getGroupIdsFromMessageCount(messageCount))
            .map((id) => ({ id, groupName: 'Unknown', members: {}, admin: false, joinDate: null }))

        for (const data of [...entryObjects, ...legacyGroups, ...messageCountGroups]) {
            if (!data.id) continue
            const existing = map.get(data.id) || {
                id: data.id,
                name: 'Unknown',
                members: 0,
                messages: 0,
                admin: false,
                joinedDate: null,
            }

            const memberCount = data.members
                ? (Array.isArray(data.members) ? data.members.length : Object.keys(data.members).length)
                : existing.members

            map.set(data.id, {
                id: data.id,
                name: data.groupName || data.name || storeGroupNames.get(data.id) || existing.name,
                members: memberCount || 0,
                messages: getTotalMessagesForChat(messageCount, data.id),
                admin: typeof data.admin === 'boolean' ? data.admin : existing.admin,
                joinedDate: data.joinDate || data.joinedDate || existing.joinedDate,
            })
        }

        for (const [id, groupName] of storeGroupNames.entries()) {
            if (!map.has(id)) {
                map.set(id, {
                    id,
                    name: groupName || 'Unknown',
                    members: 0,
                    messages: getTotalMessagesForChat(messageCount, id),
                    admin: false,
                    joinedDate: null,
                })
            }
        }

        for (const id of storeGroupIds) {
            if (!map.has(id)) {
                map.set(id, {
                    id,
                    name: storeGroupNames.get(id) || 'Unknown',
                    members: 0,
                    messages: getTotalMessagesForChat(messageCount, id),
                    admin: false,
                    joinedDate: null,
                })
            }
        }

        const groups = Array.from(map.values()).sort((a, b) => b.messages - a.messages)
        
        res.json(groups)
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Chat Schedules ───────────────────────────────────────────────────────
app.get('/api/schedules', (req, res) => {
    try {
        const chatId = (req.query.chatId || '').trim()
        const schedules = listAllSchedules()
            .filter((item) => !chatId || item.chatId === chatId)
            .map((item) => ({
                ...item,
                nextRunText: formatDateTime(item.nextRunAt),
            }))

        res.json(schedules)
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

app.post('/api/schedules', (req, res) => {
    try {
        const { chatId, type, date, time, message, createdBy } = req.body
        if (!chatId || !type || !time || !message) {
            return res.status(400).json({ success: false, error: 'chatId, type, time, message diperlukan.' })
        }

        let result
        if (type === 'daily') {
            result = addDailySchedule(chatId, String(message).trim(), String(time).trim(), createdBy || 'dashboard')
        } else if (type === 'once') {
            if (!date) return res.status(400).json({ success: false, error: 'date diperlukan untuk type once.' })
            result = addOnceSchedule(chatId, String(message).trim(), String(date).trim(), String(time).trim(), createdBy || 'dashboard')
        } else {
            return res.status(400).json({ success: false, error: 'type mesti daily atau once.' })
        }

        if (!result.ok) return res.status(400).json({ success: false, error: result.error })
        res.json({ success: true, schedule: { ...result.schedule, nextRunText: formatDateTime(result.schedule.nextRunAt) } })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

app.put('/api/schedules/:id', (req, res) => {
    try {
        const id = Number(req.params.id)
        const { chatId, type, date, time, message } = req.body

        const result = updateScheduleById(id, {
            chatId,
            type,
            date,
            time,
            message,
        })

        if (!result.ok) return res.status(400).json({ success: false, error: result.error })
        res.json({ success: true, schedule: { ...result.schedule, nextRunText: formatDateTime(result.schedule.nextRunAt) } })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

app.delete('/api/schedules/:id', (req, res) => {
    try {
        const id = Number(req.params.id)
        const all = listAllSchedules()
        const target = all.find((item) => Number(item.id) === id)
        if (!target) return res.status(404).json({ success: false, error: 'Schedule tidak dijumpai.' })

        const result = deleteSchedule(target.chatId, id)
        if (!result.ok) return res.status(400).json({ success: false, error: result.error })
        res.json({ success: true, message: `Schedule #${id} dipadam.` })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Advanced Settings GET ──────────────────────────────────────────────────
app.get('/api/advanced-settings', (req, res) => {
    try {
        const settings = getCurrentSettings('../settings')
        res.json({
            prefix: settings.prefix || '.',
            autoTyping: settings.autoTyping !== false,
            autoRead: settings.autoRead !== false,
            antiDelete: settings.antiDelete !== false,
            autoStatus: settings.autoStatus !== false,
            logChat: settings.logChat !== false,
            alwaysOnline: settings.alwaysOnline || false,
            readReceipts: settings.readReceipts !== false,
            botLanguage: settings.botLanguage || 'en'
        })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── API: Advanced Settings POST ────────────────────────────────────────────────
app.post('/api/advanced-settings', (req, res) => {
    try {
        const { key, value } = req.body
        if (!key) return res.status(400).json({ success: false, error: 'Key required.' })
        
        const settingsPath = path.join(__dirname, 'settings.js')
        let content = fs.readFileSync(settingsPath, 'utf8')
        
        // Simple key-value replacement for boolean/string settings
        const valueStr = typeof value === 'boolean' ? String(value) : `'${String(value).replace(/'/g, "\\'")}'`
        content = content.replace(
            new RegExp(`(${key}\\s*:\\s*)([^,}]+)`, 'g'),
            `$1${valueStr}`
        )
        
        fs.writeFileSync(settingsPath, content, 'utf8')
        refreshRuntimeSettings('../settings')
        
        res.json({ success: true, message: 'Setting updated and applied instantly.', restarting: false })
    } catch (err) {
        res.status(500).json({ success: false, error: err.message })
    }
})

// ── Serve dashboard ──────────────────────────────────────────────────────────
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard running on port ${PORT}`)
})
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        originalLog(`🌐 Dashboard port ${PORT} already in use — skipping bind`)
    } else {
        throw err
    }
})

module.exports = app
