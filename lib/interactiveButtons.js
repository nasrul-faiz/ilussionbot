let baileysCache = null

function getBaileys() {
    if (!baileysCache) {
        baileysCache = require('@whiskeysockets/baileys')
    }
    return baileysCache
}

function getNativeButtonDedupKey(button) {
    if (!button || typeof button !== 'object') return ''

    const name = String(button.name || '').trim()
    const rawParams = button.buttonParamsJson
    let params = {}

    if (typeof rawParams === 'string') {
        try {
            params = JSON.parse(rawParams)
        } catch (_) {
            params = {}
        }
    } else if (rawParams && typeof rawParams === 'object') {
        params = rawParams
    }

    if (name === 'quick_reply') {
        return `quick_reply:${String(params.id || params.buttonId || '').trim()}:${String(params.display_text || params.displayText || '').trim()}`
    }

    if (name === 'cta_url') {
        return `cta_url:${String(params.url || params.link || params.merchant_url || '').trim()}:${String(params.display_text || params.displayText || '').trim()}`
    }

    if (name === 'cta_call') {
        return `cta_call:${String(params.phone_number || params.phoneNumber || '').trim()}:${String(params.display_text || params.displayText || '').trim()}`
    }

    return `${name}:${typeof rawParams === 'string' ? rawParams.trim() : JSON.stringify(rawParams || {})}`
}

function toNativeFlowButtons(buttons) {
    if (!Array.isArray(buttons)) return []

    const mapped = []
    const seen = new Set()
    const pushUnique = (button) => {
        const key = getNativeButtonDedupKey(button)
        if (!key || seen.has(key)) return
        seen.add(key)
        mapped.push(button)
    }

    for (const button of buttons) {
        if (!button || typeof button !== 'object') continue

        if (button.name && button.buttonParamsJson) {
            const allowedName = button.name === 'quick_reply' ? 'quick_reply' : button.name
            pushUnique({
                name: allowedName,
                buttonParamsJson: typeof button.buttonParamsJson === 'string'
                    ? button.buttonParamsJson
                    : JSON.stringify(button.buttonParamsJson)
            })
            continue
        }

        if (button.quickReplyButton?.id) {
            pushUnique({
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: button.quickReplyButton.displayText || 'Button',
                    id: button.quickReplyButton.id
                })
            })
            continue
        }

        if (button.urlButton?.url) {
            pushUnique({
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: button.urlButton.displayText || 'Open Link',
                    url: button.urlButton.url,
                    merchant_url: button.urlButton.url
                })
            })
            continue
        }

        if (button.callButton?.phoneNumber) {
            pushUnique({
                name: 'cta_call',
                buttonParamsJson: JSON.stringify({
                    display_text: button.callButton.displayText || 'Call',
                    phone_number: String(button.callButton.phoneNumber)
                })
            })
            continue
        }

        if (button.buttonId || button.buttonText?.displayText) {
            pushUnique({
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                    display_text: button.buttonText?.displayText || 'Button',
                    id: button.buttonId || button.buttonText?.displayText
                })
            })
        }
    }

    return mapped
}

function toLegacyButtons(buttons) {
    const nativeButtons = toNativeFlowButtons(buttons)
    const legacyButtons = nativeButtons
        .map((button, index) => {
            try {
                const params = JSON.parse(button.buttonParamsJson || '{}')
                const displayText = params.display_text || params.displayText || `Button ${index + 1}`
                const firstRowId = Array.isArray(params.sections)
                    ? params.sections.flatMap(section => Array.isArray(section?.rows) ? section.rows : []).find(row => row?.id)?.id
                    : ''
                const buttonId = params.id || params.buttonId || params.url || params.phone_number || params.copy_code || params.row_id || firstRowId || displayText
                return { buttonId: String(buttonId), buttonText: { displayText }, type: 1 }
            } catch (_) {
                return null
            }
        })
        .filter(Boolean)

    return legacyButtons
}

async function sendInteractiveButtons(sock, jid, payload, options = {}) {
    const bodyText = payload?.text || payload?.caption || ''
    const footerText = payload?.footer || ''
    const nativeButtons = toNativeFlowButtons(payload?.buttons || payload?.templateButtons || payload?.nativeButtons)

    if (!nativeButtons.length) {
        await sock.sendMessage(jid, { text: bodyText || ' ' }, options)
        return
    }

    try {
        const { generateWAMessageFromContent, proto } = getBaileys()
        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({
                            text: bodyText || ' '
                        }),
                        footer: proto.Message.InteractiveMessage.Footer.create({
                            text: footerText
                        }),
                        header: proto.Message.InteractiveMessage.Header.create({
                            hasMediaAttachment: false
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: nativeButtons
                        })
                    })
                }
            }
        }, {
            userJid: sock?.user?.id,
            quoted: options?.quoted
        })

        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return
    } catch (err) {
        const legacyButtons = nativeButtons
            .map((button, index) => {
                try {
                    const params = JSON.parse(button.buttonParamsJson || '{}')
                    const displayText = params.display_text || params.displayText || `Button ${index + 1}`
                    const buttonId = params.id || params.buttonId || params.url || params.phone_number || displayText
                    return { buttonId: String(buttonId), buttonText: { displayText }, type: 1 }
                } catch (_) {
                    return null
                }
            })
            .filter(Boolean)
            .slice(0, 3)

        if (legacyButtons.length) {
            await sock.sendMessage(jid, {
                text: bodyText || ' ',
                footer: footerText,
                buttons: legacyButtons,
                headerType: 1,
                viewOnce: true
            }, options)
            return
        }

        throw err
    }
}

function extractInteractiveResponseId(message) {
    const selectedLegacy = message?.message?.buttonsResponseMessage?.selectedButtonId
        || message?.message?.viewOnceMessage?.message?.buttonsResponseMessage?.selectedButtonId
    if (selectedLegacy) return selectedLegacy

    const paramsJson = message?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
        || message?.message?.viewOnceMessage?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    if (!paramsJson || typeof paramsJson !== 'string') return ''

    try {
        const parsed = JSON.parse(paramsJson)
        return (
            parsed.id
            || parsed.button_id
            || parsed.buttonId
            || parsed.selected_row_id
            || parsed.selectedRowId
            || parsed.row_id
            || parsed.rowId
            || parsed.selected_id
            || parsed.selectedId
            || ''
        )
    } catch (_) {
        return ''
    }
}

module.exports = {
    sendInteractiveButtons,
    toNativeFlowButtons,
    extractInteractiveResponseId
}
