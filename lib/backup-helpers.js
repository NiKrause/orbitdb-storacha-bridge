/**
 * Helper functions for timestamped backup feature
 */

/**
 * Generate backup prefix with timestamp
 * 
 * @param {string} spaceName - Name of the Storacha space
 * @returns {string} - Backup prefix including timestamp
 */
export function generateBackupPrefix(spaceName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${spaceName}/backup-${timestamp}`
}

/**
 * Get metadata and blocks filenames for a backup prefix
 * 
 * @param {string} prefix - Backup prefix
 * @returns {{metadata: string, blocks: string}} - Filenames for metadata and blocks
 */
export function getBackupFilenames(prefix) {
  return {
    metadata: `${prefix}-metadata.json`,
    blocks: `${prefix}-blocks.car`
  }
}

/**
 * Validate backup metadata
 * 
 * @param {Object} metadata - Metadata object to validate
 * @returns {boolean} - True if valid
 */
export function isValidMetadata(metadata) {
  if (!metadata || typeof metadata.version !== 'string' || typeof metadata.timestamp !== 'number') {
    return false
  }
  
  if (!Array.isArray(metadata.databases)) {
    return false
  }
  
  // Support both old format (root/path) and new CAR format (address/manifestCID)
  return metadata.databases.every(db => {
    // Old format
    if (db.root && db.path) {
      return true
    }
    // New CAR format
    if (db.address && db.manifestCID) {
      return true
    }
    return false
  })
}

/**
 * Find the latest valid backup in a space
 * 
 * @param {Array} spaceFiles - List of files in the space
 * @param {Object} options - Options
 * @param {Function} options.onWarning - Warning callback
 * @returns {Object|null} - Latest valid backup or null
 */
export function findLatestBackup(spaceFiles, options = {}) {
  const { onWarning = console.warn } = options
  const filenames = spaceFiles.map(f => f.root.toString())
  
  // Group files by full backup path (preserving directory structure)
  const backupGroups = new Map()
  for (const file of filenames) {
    // Match pattern: (optional-prefix/)backup-(timestamp)-(metadata.json|blocks.car)
    const match = file.match(/^(.*)backup-(.*?)-(metadata\.json|blocks\.car)$/)
    if (match) {
      const [, prefix, timestamp, type] = match
      const backupKey = `${prefix}backup-${timestamp}`
      
      if (!backupGroups.has(backupKey)) {
        backupGroups.set(backupKey, { files: new Set(), timestamp, prefix })
      }
      backupGroups.get(backupKey).files.add(type)
    }
  }

  // Find complete and valid backups
  const completeBackups = Array.from(backupGroups.entries())
    .filter(([backupKey, { files }]) => {
      const isComplete = files.has('metadata.json') && files.has('blocks.car')
      if (!isComplete) {
        onWarning(`⚠️ Incomplete backup found: ${backupKey}-*`)
        files.forEach(file => {
          onWarning(`   Orphaned file: ${backupKey}-${file}`)
        })
      }
      return isComplete
    })
    .sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp)) // Sort descending by timestamp

  if (completeBackups.length === 0) {
    if (backupGroups.size > 0) {
      onWarning('⚠️ No complete backup sets found (missing metadata or blocks files)')
    }
    return null
  }

  const [backupKey, { timestamp }] = completeBackups[0]
  return {
    metadata: `${backupKey}-metadata.json`,
    blocks: `${backupKey}-blocks.car`,
    timestamp: timestamp
  }
}
