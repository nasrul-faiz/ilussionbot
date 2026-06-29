const fs = require('fs')
const path = require('path')

const sessionDir = path.join(__dirname, 'session')
const stateFiles = [
  path.join(__dirname, 'data', 'qrState.json'),
  path.join(__dirname, 'data', 'conflictState.json'),
]

try {
  fs.rmSync(sessionDir, { recursive: true, force: true })
  fs.mkdirSync(sessionDir, { recursive: true })

  for (const filePath of stateFiles) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {}
  }

  console.log('Session reset successfully.')
} catch (error) {
  console.error('Reset session failed:', error)
  process.exitCode = 1
}