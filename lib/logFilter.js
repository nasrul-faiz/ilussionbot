const LOG_SUPPRESS = [
    /Failed to decrypt message/i,
    /Session error:Error: Bad MAC/i,
    /Bad MAC/i,
    /doDecryptWhisperMessage/i,
    /verifyMAC/i,
    /session_cipher/i,
    /Closing session/i,
    /Closing open session in favor of incoming prekey bundle/i,
    /Closing stale open session for new outgoing prekey bundle/i,
    /SessionEntry\s*\{/i,
    /_chains\s*:/i,
    /currentRatchet\s*:/i,
    /indexInfo\s*:/i,
    /remoteIdentityKey\s*:/i,
    /ephemeralKeyPair\s*:/i,
    /rootKey\s*:/i,
    /Removing old closed session/i,
    /pendingPreKey/i,
    /ephemeralKeyPair/i,
    /lastRemoteEphemeralKey/i,
    /registrationId/i,
    /baseKeyType/i,
]

function isSuppressed(msg) {
    return LOG_SUPPRESS.some(re => re.test(msg))
}

function installLogFilter() {
    const originalLog = console.log
    const originalError = console.error
    const originalStderrWrite = process.stderr.write.bind(process.stderr)

    const shouldPrintToTerminal = (args) => {
        const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
        return !isSuppressed(msg)
    }

    process.stderr.write = (chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (isSuppressed(text)) {
            if (typeof callback === 'function') callback()
            return true
        }

        return originalStderrWrite(chunk, encoding, callback)
    }

    console.log = (...args) => {
        if (shouldPrintToTerminal(args)) originalLog(...args)
    }
    console.error = (...args) => {
        if (shouldPrintToTerminal(args)) originalError(...args)
    }
}

module.exports = {
    installLogFilter,
    isSuppressed,
}