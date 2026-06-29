'use strict'

// Filter noisy low-value logs so dashboard and terminal remain readable.
const SUPPRESSED_PATTERNS = [
  /Closing stale open session for new outgoing prekey bundle/i,
  /Closing open session in favor of incoming prekey bundle/i,
  /Closing session:\s*SessionEntry/i,
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

module.exports = {
  isSuppressed,
}
