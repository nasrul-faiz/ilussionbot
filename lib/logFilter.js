'use strict'

// Filter noisy low-value logs so dashboard and terminal remain readable.
const SUPPRESSED_PATTERNS = [
  /Closing stale open session for new outgoing prekey bundle/i,
  /Closing open session in favor of incoming prekey bundle/i,
  /Closing session:\s*SessionEntry/i,
  /\bSessionEntry\s*\{/i,
  /^\s*(_chains|indexInfo|currentRatchet|pendingPreKey)\s*:\s*\{?\s*$/i,
  /^\s*(baseKey|baseKeyType|closed|used|created|registrationId|preKeyId|signedKeyId|previousCounter)\s*:/i,
  /\b(rootKey|privKey|pubKey|remoteIdentityKey|lastRemoteEphemeralKey|ephemeralKeyPair|baseKey)\s*:\s*<Buffer/i,
  /Failed to decrypt message with any known session/i,
  /Session error:\s*Error:\s*Bad MAC/i,
  /Bad MAC Error:\s*Bad MAC/i,
  /TypeError:\s*Cannot use 'in' operator to search for 'stream'/i,
  /NodeCache.*deprecated|DEP00\d+/i,
  /ExperimentalWarning/i,
]

function isSuppressed(message) {
  const text = String(message || '')
  return SUPPRESSED_PATTERNS.some((pattern) => pattern.test(text))
}

function sanitizeLogText(message) {
  const text = String(message || '')

  // Protect against accidental key material leakage in logs.
  return text
    .replace(/(rootKey|privKey|pubKey|remoteIdentityKey|lastRemoteEphemeralKey|ephemeralKeyPair|baseKey)\s*:\s*<Buffer[^>]*>/gi, '$1: [REDACTED]')
    .replace(/\b(SessionEntry|pendingPreKey|currentRatchet|indexInfo|_chains)\s*:\s*\{/gi, '$1: [REDACTED]')
}

module.exports = {
  isSuppressed,
  sanitizeLogText,
}
