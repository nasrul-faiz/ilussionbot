/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 * 
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */
require('./settings')
require('./lib/logFilter').installLogFilter()
// Start the web dashboard inside the bot process so it shares logs/state.
// Required early so dashboard.js's console interception captures bot logs,
// and so /api/session/reset (process.exit) restarts the bot itself.
if (!process.env.SKIP_DASHBOARD) require('./dashboard')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const FileType = require('file-type')
const path = require('path')
const axios = require('axios')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif')
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
// Using a lightweight persisted store instead of makeInMemoryStore (compat across versions)
const pino = require("pino")
const readline = require("readline")
const { parsePhoneNumber } = require("libphonenumber-js")
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics')
const { rmSync, existsSync } = require('fs')
const { join } = require('path')
const QRCode = require('qrcode')
const { startScheduler } = require('./lib/scheduler')

// Import lightweight store
const store = require('./lib/lightweight_store')

// Initialize store
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

// Memory optimization - Force garbage collection if available
setInterval(() => {
    if (global.gc) {
        global.gc()
        console.log('🧹 Garbage collection completed')
    }
}, 60_000) // every 1 minute

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 400) {
        console.log('⚠️ RAM too high (>400MB), restarting bot...')
        process.exit(1) // Panel will auto-restart
    }
}, 30_000) // check every 30 seconds

let phoneNumber = ""
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

// Conflict backoff tracker — persisted in file across process restarts
function readConflictCount() {
    try { return JSON.parse(fs.readFileSync('./data/conflictState.json', 'utf8')).count || 0 } catch { return 0 }
}
function writeConflictCount(n) {
    try { fs.writeFileSync('./data/conflictState.json', JSON.stringify({ count: n, ts: Date.now() })) } catch {}
}
// Clear stale conflict counter (if last conflict was >10 min ago, reset)
try {
    const cs = JSON.parse(fs.readFileSync('./data/conflictState.json', 'utf8'))
    if (Date.now() - (cs.ts || 0) > 10 * 60 * 1000) writeConflictCount(0)
} catch {}

global.botname = "KNIGHT BOT"
global.themeemoji = "•"
global.phoneNumber = settings.ownerNumber || phoneNumber
// Use QR mode by default (more stable). Pairing code only if --pairing-code flag passed.
const pairingCode = process.argv.includes("--pairing-code")
const useMobile = process.argv.includes("--mobile")

// Only create readline interface if we're in an interactive environment
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
const question = (text) => {
    if (rl) {
        return new Promise((resolve) => rl.question(text, resolve))
    } else {
        // In non-interactive environment, use ownerNumber from settings
        return Promise.resolve(settings.ownerNumber || phoneNumber)
    }
}

// Prevent restart storms when multiple close events fire in quick succession.
let isSocketRestartScheduled = false

async function restartSocketInProcess(delayMs = 5000, reason = 'connection update') {
    if (isSocketRestartScheduled) {
        console.log(chalk.yellow(`Restart already scheduled, skip duplicate trigger (${reason}).`))
        return
    }

    isSocketRestartScheduled = true
    console.log(chalk.yellow(`Reconnecting in ${Math.floor(delayMs / 1000)}s... (${reason})`))

    try {
        await delay(delayMs)
        await startXeonBotInc()
    } catch (err) {
        console.error(chalk.red('Failed to restart socket in-process:'), err)
        process.exit(1)
    } finally {
        isSocketRestartScheduled = false
    }
}


async function startXeonBotInc() {
    try {
        let { version, isLatest } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMultiFileAuthState(`./session`)
        const msgRetryCounterCache = new NodeCache()

        const XeonBotInc = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid)
                let msg = await store.loadMessage(jid, key.id)
                return msg?.message || ""
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        })

        // Make current socket available to dashboard APIs running in the same process.
        global.botSocket = XeonBotInc

        // Start chat scheduler once the socket is ready to send messages
        startScheduler(XeonBotInc)

        // Save credentials when they update
        XeonBotInc.ev.on('creds.update', saveCreds)

    store.bind(XeonBotInc.ev)

    // Message handling
    XeonBotInc.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0]
            if (!mek.message) return
            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message
            if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                await handleStatus(XeonBotInc, chatUpdate);
                return;
            }
            // In private mode, only block non-group messages (allow groups for moderation)
            // Note: XeonBotInc.public is not synced, so we check mode in main.js instead
            // This check is kept for backward compatibility but mainly blocks DMs
            if (!XeonBotInc.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
                const isGroup = mek.key?.remoteJid?.endsWith('@g.us')
                if (!isGroup) return // Block DMs in private mode, but allow group messages
            }
            if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return

            // Clear message retry cache to prevent memory bloat
            if (XeonBotInc?.msgRetryCounterCache) {
                XeonBotInc.msgRetryCounterCache.clear()
            }

            try {
                await handleMessages(XeonBotInc, chatUpdate, true)
            } catch (err) {
                console.error("Error in handleMessages:", err)
                // Only try to send error message if we have a valid chatId
                if (mek.key && mek.key.remoteJid) {
                    await XeonBotInc.sendMessage(mek.key.remoteJid, {
                        text: '❌ An error occurred while processing your message.',
                        contextInfo: {
                            forwardingScore: 1,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363161513685998@newsletter',
                                newsletterName: 'KnightBot MD',
                                serverMessageId: -1
                            }
                        }
                    }).catch(console.error);
                }
            }
        } catch (err) {
            console.error("Error in messages.upsert:", err)
        }
    })

    // Add these event handlers for better functionality
    XeonBotInc.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server && decode.user + '@' + decode.server || jid
        } else return jid
    }

    XeonBotInc.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = XeonBotInc.decodeJid(contact.id)
            if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    XeonBotInc.getName = (jid, withoutContact = false) => {
        id = XeonBotInc.decodeJid(jid)
        withoutContact = XeonBotInc.withoutContact || withoutContact
        let v
        if (id.endsWith("@g.us")) return new Promise(async (resolve) => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = XeonBotInc.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net' ? {
            id,
            name: 'WhatsApp'
        } : id === XeonBotInc.decodeJid(XeonBotInc.user.id) ?
            XeonBotInc.user :
            (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    XeonBotInc.public = true

    XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store)

    // Handle pairing code
    if (pairingCode && !XeonBotInc.authState.creds.registered) {
        if (useMobile) throw new Error('Cannot use pairing code with mobile api')

        let phoneNumber
        if (!!global.phoneNumber) {
            phoneNumber = global.phoneNumber
        } else {
            phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number 😍\nFormat: 6281376552730 (without + or spaces) : `)))
        }

        // Clean the phone number - remove any non-digit characters
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

        // Validate the phone number using awesome-phonenumber
        const pn = require('awesome-phonenumber');
        if (!pn('+' + phoneNumber).isValid()) {
            console.log(chalk.red('Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, etc.) without + or spaces.'));
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                let code = await XeonBotInc.requestPairingCode(phoneNumber)
                code = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
                console.log(chalk.yellow(`\nPlease enter this code in your WhatsApp app:\n1. Open WhatsApp\n2. Go to Settings > Linked Devices\n3. Tap "Link a Device"\n4. Enter the code shown above`))
            } catch (error) {
                console.error('Error requesting pairing code:', error)
                console.log(chalk.red('Failed to get pairing code. Please check your phone number and try again.'))
            }
        }, 3000)
    }

    // Connection handling
    XeonBotInc.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect, qr } = s
        
        if (qr) {
            console.log(chalk.yellow('📱 QR Code generated. Please scan with WhatsApp.'))
            try {
                const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 256 })
                fs.writeFileSync('./data/qrState.json', JSON.stringify({ status: 'pending', qr: qrDataUrl, timestamp: Date.now() }))
            } catch (e) { console.error('Error saving QR state:', e.message) }
        }
        
        if (connection === 'connecting') {
            console.log(chalk.yellow('🔄 Connecting to WhatsApp...'))
            try { fs.writeFileSync('./data/qrState.json', JSON.stringify({ status: 'connecting', timestamp: Date.now() })) } catch {}
        }
        
        if (connection == "open") {
            try { fs.writeFileSync('./data/qrState.json', JSON.stringify({ status: 'connected', timestamp: Date.now() })) } catch {}
            console.log(chalk.magenta(` `))
            console.log(chalk.yellow(`🌿Connected to => ` + JSON.stringify(XeonBotInc.user, null, 2)))

            try {
                const selfJid = XeonBotInc.decodeJid(XeonBotInc.user?.id || '')
                let profilePic = null
                try {
                    if (selfJid) profilePic = await XeonBotInc.profilePictureUrl(selfJid, 'image')
                } catch (_) {}

                const botInfo = {
                    id: XeonBotInc.user?.id || null,
                    name: XeonBotInc.user?.name || null,
                    profilePic: profilePic || null,
                    updatedAt: Date.now(),
                }
                fs.writeFileSync('./data/botInfo.json', JSON.stringify(botInfo, null, 2))
            } catch (e) {
                console.error('Error refreshing botInfo profile data:', e.message)
            }

            try {
                const botNumber = XeonBotInc.user.id.split(':')[0] + '@s.whatsapp.net';
                await XeonBotInc.sendMessage(botNumber, {
                    text: `🤖 Bot Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online and Ready!\n\n✅Make sure to join below channel`,
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: '120363161513685998@newsletter',
                            newsletterName: 'KnightBot MD',
                            serverMessageId: -1
                        }
                    }
                });
            } catch (error) {
                console.error('Error sending connection message:', error.message)
            }

            await delay(1999)
            console.log(chalk.yellow(`\n\n                  ${chalk.bold.blue(`[ ${global.botname || 'KNIGHT BOT'} ]`)}\n\n`))
            console.log(chalk.cyan(`< ================================================== >`))
            console.log(chalk.magenta(`\n${global.themeemoji || '•'} YT CHANNEL: MR UNIQUE HACKER`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} GITHUB: mrunqiuehacker`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} WA NUMBER: ${owner}`))
            console.log(chalk.magenta(`${global.themeemoji || '•'} CREDIT: MR UNIQUE HACKER`))
            console.log(chalk.green(`${global.themeemoji || '•'} 🤖 Bot Connected Successfully! ✅`))
            console.log(chalk.blue(`Bot Version: ${settings.version}`))
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            console.log(chalk.red(`Connection closed due to ${lastDisconnect?.error}, status: ${statusCode}`))
            try { fs.writeFileSync('./data/qrState.json', JSON.stringify({ status: 'disconnected', timestamp: Date.now() })) } catch {}
            global.botSocket = null

            // Conflict (409/440) = same session active elsewhere (WhatsApp Web, other bot instance, etc.)
            if (statusCode === DisconnectReason.conflict || statusCode === 440 || statusCode === 409) {
                const count = readConflictCount() + 1
                writeConflictCount(count)
                const backoff = Math.min(count * 20000, 120000) // 20s, 40s, 60s ... max 2min

                console.log(chalk.red(`⚠️ Session conflict detected (attempt ${count}). Another device is using this session.`))

                // After 5 consecutive conflicts → clear session so bot re-pairs fresh
                if (count >= 5) {
                    console.log(chalk.red('❌ Too many conflicts. Clearing session — bot will request a new pairing code.'))
                    try {
                        const sessionDir = join(__dirname, 'session')
                        if (existsSync(sessionDir)) {
                            fs.readdirSync(sessionDir).forEach(f => {
                                try { fs.unlinkSync(join(sessionDir, f)) } catch (_) {}
                            })
                        }
                    } catch (e) { console.error('Error clearing session:', e.message) }
                    writeConflictCount(0)
                    console.log(chalk.yellow('Session cleared. Restarting to re-pair in 5s...'))
                    await restartSocketInProcess(5000, 'conflict threshold reached')
                    return
                }

                console.log(chalk.yellow(`Waiting ${backoff / 1000}s before retrying to let other session close...`))
                await restartSocketInProcess(backoff, 'session conflict')
                return
            }

            // Logged out (401) must clear ALL session files before restart.
            // 408 (QR refs attempts ended) is recoverable: restart socket without clearing creds.
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                try {
                    rmSync('./session', { recursive: true, force: true })
                    fs.mkdirSync('./session', { recursive: true })
                    console.log(chalk.yellow('Session cleared. Will generate fresh QR on restart.'))
                } catch (error) {
                    console.error('Error clearing session:', error)
                }
                if (statusCode === 401) {
                    console.log(chalk.red('Logged out by WhatsApp. Waiting 10s before restart...'))
                    await restartSocketInProcess(10000, 'logged out (401)')
                } else {
                    await restartSocketInProcess(5000, 'logged out')
                }
                return
            }

            if (statusCode === 408) {
                // QR refs attempts ended: just regenerate QR by restarting socket.
                await restartSocketInProcess(3000, 'qr refs ended (408)')
                return
            }

            // Reset conflict counter on clean reconnect
            writeConflictCount(0)

            // Any other recoverable error: reconnect in-process to avoid restart churn.
            await restartSocketInProcess(5000, `disconnect status ${statusCode || 'unknown'}`)
        }
    })

    // Track recently-notified callers to avoid spamming messages
    const antiCallNotified = new Set();

    // Anticall handler: block callers when enabled
    XeonBotInc.ev.on('call', async (calls) => {
        try {
            const { readState: readAnticallState } = require('./commands/anticall');
            const state = readAnticallState();
            if (!state.enabled) return;
            for (const call of calls) {
                const callerJid = call.from || call.peerJid || call.chatId;
                if (!callerJid) continue;
                try {
                    // First: attempt to reject the call if supported
                    try {
                        if (typeof XeonBotInc.rejectCall === 'function' && call.id) {
                            await XeonBotInc.rejectCall(call.id, callerJid);
                        } else if (typeof XeonBotInc.sendCallOfferAck === 'function' && call.id) {
                            await XeonBotInc.sendCallOfferAck(call.id, callerJid, 'reject');
                        }
                    } catch {}

                    // Notify the caller only once within a short window
                    if (!antiCallNotified.has(callerJid)) {
                        antiCallNotified.add(callerJid);
                        setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                        await XeonBotInc.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.' });
                    }
                } catch {}
                // Then: block after a short delay to ensure rejection and message are processed
                setTimeout(async () => {
                    try { await XeonBotInc.updateBlockStatus(callerJid, 'block'); } catch {}
                }, 800);
            }
        } catch (e) {
            // ignore
        }
    });

    XeonBotInc.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(XeonBotInc, update);
    });

    XeonBotInc.ev.on('messages.upsert', async (m) => {
        if (m.messages[0].key && m.messages[0].key.remoteJid === 'status@broadcast') {
            await handleStatus(XeonBotInc, m);
        }
    });

    XeonBotInc.ev.on('status.update', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    XeonBotInc.ev.on('messages.reaction', async (status) => {
        await handleStatus(XeonBotInc, status);
    });

    return XeonBotInc
    } catch (error) {
        console.error('Error in startXeonBotInc:', error)
        await delay(5000)
        startXeonBotInc()
    }
}


// Start the bot with error handling
startXeonBotInc().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
})
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err)
})

let file = require.resolve(__filename)
fs.watchFile(file, () => {
    fs.unwatchFile(file)
    console.log(chalk.redBright(`Update ${__filename}`))
    delete require.cache[file]
    require(file)
})