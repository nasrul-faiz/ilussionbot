const { cleanupTempFiles } = require('./lib/tempCleanup')

try {
  cleanupTempFiles()
  console.log('Temporary files cleaned.')
} catch (error) {
  console.error('Cleanup failed:', error)
  process.exitCode = 1
}