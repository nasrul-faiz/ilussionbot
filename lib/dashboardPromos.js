const fs = require('fs')
const path = require('path')
const { sendInteractiveButtons } = require('./interactiveButtons')

function renderTemplate(text = '', replacements = {}) {
    let output = String(text || '')
    for (const [key, value] of Object.entries(replacements)) {
        const pattern = new RegExp(`\\{${key}\\}`, 'gi')
        output = output.replace(pattern, String(value))
    }
    return output
}

function parseButtons(rawButtons) {
    if (rawButtons == null || rawButtons === '') return []

    let parsed = rawButtons
    if (typeof parsed === 'string') {
        const raw = parsed.trim()
        if (!raw) return []
        try {
            parsed = JSON.parse(raw)
        } catch (err) {
            console.error('Invalid dashboard buttons JSON:', err.message)
            return []
        }
    }

    if (!Array.isArray(parsed)) return []
    return parsed.filter((button) => button && typeof button === 'object')
}

function resolveMediaSource(mediaValue, fallbackPath = '') {
    const raw = String(mediaValue || '').trim()
    if (!raw && !fallbackPath) return null

    if (raw) {
        if (/^https?:\/\//i.test(raw)) return { url: raw }

        const normalized = raw.startsWith('/') ? raw.slice(1) : raw
        if (normalized.startsWith('uploads/')) {
            const uploadCandidates = [
                path.resolve(__dirname, '..', 'public', normalized),
                path.resolve(process.cwd(), 'public', normalized),
            ]

            for (const candidate of uploadCandidates) {
                if (fs.existsSync(candidate)) return { url: candidate }
            }
        }

        const candidates = [
            path.resolve(process.cwd(), normalized),
            path.resolve(__dirname, '..', normalized),
        ]

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return { url: candidate }
        }
    }

    const fallbackResolved = fallbackPath
        ? path.resolve(__dirname, '..', fallbackPath)
        : ''
    if (fallbackResolved && fs.existsSync(fallbackResolved)) {
        return { url: fallbackResolved }
    }

    return null
}

const DEFAULT_PROMO_CONTEXT_INFO = {
    forwardingScore: 1,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: '120363161513685998@newsletter',
        newsletterName: 'KnightBot MD',
        serverMessageId: -1,
    },
}

async function sendConfiguredPromoMessage(sock, chatId, settings, config = {}) {
    const {
        textKey,
        mediaKey,
        buttonsKey,
        footer,
        fallbackText,
        fallbackImagePath = '',
        replacements = {},
        quoted,
        contextInfo = DEFAULT_PROMO_CONTEXT_INFO,
    } = config

    const configuredText = String(settings?.[textKey] || '').trim()
    const text = configuredText
        ? renderTemplate(configuredText, replacements)
        : String(fallbackText || '')
    const buttons = parseButtons(settings?.[buttonsKey])
    const image = resolveMediaSource(settings?.[mediaKey], fallbackImagePath)

    if (image || buttons.length) {
        await sendInteractiveButtons(sock, chatId, {
            image,
            text,
            caption: text,
            footer: footer || '',
            nativeButtons: buttons,
        }, { quoted, contextInfo })
        return
    }

    await sock.sendMessage(chatId, { text, contextInfo }, { quoted })
}

module.exports = {
    renderTemplate,
    parseButtons,
    resolveMediaSource,
    sendConfiguredPromoMessage,
}