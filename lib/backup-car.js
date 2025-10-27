/**
 * CAR-based OrbitDB Backup with Timestamps
 * 
 * Alternative implementation using CAR (Content Addressable Archive) files
 * for efficient timestamped backups. Works in both Node.js and browser environments.
 * 
 * This is backward compatible with the existing individual block upload approach.
 * Use this when you want:
 * - Timestamped backups (multiple backup points)
 * - More efficient upload (fewer files)
 * - Better organization (grouped by timestamp)
 */

import { Readable } from 'stream'
import { CarWriter, CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'
import {
  generateBackupPrefix,
  getBackupFilenames,
  isValidMetadata,
  findLatestBackup
} from './backup-helpers.js'
import { 
  extractDatabaseBlocks,
  initializeStorachaClient,
  initializeStorachaClientWithUCAN
} from './orbitdb-storacha-bridge.js'
import logger from './logger.js'

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS = {
  timeout: 30000,
  gateway: 'https://w3s.link',
  storachaKey: undefined,
  storachaProof: undefined,
  fallbackDatabaseName: undefined,
  forceFallback: false
}

/**
 * Create a CAR file in memory from blocks
 * @param {Map} blocks - Map of blocks to include
 * @param {string} manifestCID - Root CID for the CAR file
 * @returns {Promise<Uint8Array>} CAR file as bytes
 */
export async function createCARFromBlocks(blocks, manifestCID) {
  logger.debug(`Creating CAR file with ${blocks.size} blocks`)
  
  // Parse the manifest CID as the root
  const rootCID = CID.parse(manifestCID)
  
  // Create an in-memory CAR writer
  const { writer, out } = CarWriter.create([rootCID])
  
  // Collect all output chunks
  const chunks = []
  const reader = Readable.from(out)
  
  reader.on('data', (chunk) => chunks.push(chunk))
  
  // Add all blocks to the CAR
  for (const [cidString, blockData] of blocks.entries()) {
    try {
      const cid = CID.parse(cidString)
      await writer.put({ cid, bytes: blockData.bytes })
    } catch (error) {
      logger.warn(`Failed to add block ${cidString} to CAR: ${error.message}`)
    }
  }
  
  await writer.close()
  
  // Wait for all data to be written
  await new Promise((resolve) => {
    reader.on('end', resolve)
  })
  
  // Concatenate all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const carBytes = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    carBytes.set(chunk, offset)
    offset += chunk.length
  }
  
  logger.info(`Created CAR file: ${carBytes.length} bytes`)
  return carBytes
}

/**
 * Read blocks from a CAR file
 * @param {Uint8Array|AsyncIterable} carData - CAR file data
 * @returns {Promise<Map>} Map of CID -> block data
 */
export async function readBlocksFromCAR(carData) {
  logger.debug('Reading blocks from CAR file')
  
  const blocks = new Map()
  
  // Convert Uint8Array to async iterable if needed
  const iterable = carData instanceof Uint8Array 
    ? (async function* () { yield carData })()
    : carData
  
  const reader = await CarReader.fromIterable(iterable)
  
  for await (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), { cid, bytes })
  }
  
  logger.info(`Read ${blocks.size} blocks from CAR file`)
  return blocks
}

/**
 * Backup an OrbitDB database using CAR format with timestamps
 * 
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - Backup options
 * @param {string} [options.spaceName='default'] - Storacha space name for organizing backups
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress
 * @returns {Promise<Object>} Backup result with file info
 */
export async function backupDatabaseCAR(orbitdb, databaseAddress, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const spaceName = config.spaceName || 'default'
  const eventEmitter = options.eventEmitter

  logger.info('🚀 Starting CAR-based OrbitDB Backup')
  logger.info(`📍 Database: ${databaseAddress}`)
  logger.info(`🗂️  Space: ${spaceName}`)

  try {
    // Initialize Storacha client
    let client
    if (config.ucanClient) {
      logger.info('🔐 Using UCAN authentication...')
      client = await initializeStorachaClientWithUCAN({
        client: config.ucanClient,
        spaceDID: config.spaceDID
      })
    } else {
      const storachaKey = config.storachaKey || 
        (typeof process !== 'undefined' ? process.env?.STORACHA_KEY : undefined)
      const storachaProof = config.storachaProof || 
        (typeof process !== 'undefined' ? process.env?.STORACHA_PROOF : undefined)

      if (!storachaKey || !storachaProof) {
        throw new Error('Storacha authentication required: provide storachaKey + storachaProof OR ucanClient')
      }

      client = await initializeStorachaClient(storachaKey, storachaProof)
    }

    // Step 1: Extract database blocks
    logger.info('📦 Step 1: Extracting database blocks...')
    const database = await orbitdb.open(databaseAddress, config.dbConfig)
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(
      database,
      { logEntriesOnly: false }
    )

    logger.info(`   ✅ Extracted ${blocks.size} blocks`)

    // Step 2: Generate timestamped filenames
    const backupPrefix = generateBackupPrefix(spaceName)
    const backupFiles = getBackupFilenames(backupPrefix)

    logger.info(`📝 Step 2: Creating timestamped backup files...`)
    logger.info(`   Metadata: ${backupFiles.metadata}`)
    logger.info(`   Blocks: ${backupFiles.blocks}`)

    // Step 3: Create metadata
    const metadata = {
      version: '1.0',
      timestamp: Date.now(),
      databaseCount: 1,
      totalBlocks: blocks.size,
      manifestCID: manifestCID,
      databases: [{
        address: database.address,
        name: database.name,
        type: database.type,
        manifestCID: manifestCID
      }],
      blockSummary: Object.fromEntries(
        Array.from(new Set(blockSources.values())).map(type => 
          [type, Array.from(blockSources.values()).filter(t => t === type).length]
        )
      )
    }

    // Validate metadata
    if (!isValidMetadata(metadata)) {
      throw new Error('Invalid metadata structure')
    }

    // Step 4: Create CAR file in memory
    logger.info('🗜️  Step 3: Creating CAR archive...')
    
    if (eventEmitter) {
      eventEmitter.emit('backupProgress', {
        type: 'car-creation',
        status: 'creating',
        totalBlocks: blocks.size
      })
    }

    const carBytes = await createCARFromBlocks(blocks, manifestCID)
    
    logger.info(`   ✅ Created CAR file: ${carBytes.length} bytes (${blocks.size} blocks)`)

    // Step 5: Upload metadata and CAR file to Storacha
    logger.info('📤 Step 4: Uploading to Storacha...')

    // Upload metadata JSON
    const metadataBlob = new Blob(
      [JSON.stringify(metadata, null, 2)], 
      { type: 'application/json' }
    )
    const metadataFile = new File([metadataBlob], backupFiles.metadata, {
      type: 'application/json'
    })

    if (eventEmitter) {
      eventEmitter.emit('backupProgress', {
        type: 'upload',
        status: 'uploading-metadata'
      })
    }

    const metadataResult = await client.uploadFile(metadataFile)
    logger.info(`   ✅ Metadata uploaded: ${metadataResult.toString()}`)

    // Upload CAR file
    const carBlob = new Blob([carBytes], { type: 'application/vnd.ipld.car' })
    const carFile = new File([carBlob], backupFiles.blocks, {
      type: 'application/vnd.ipld.car'
    })

    if (eventEmitter) {
      eventEmitter.emit('backupProgress', {
        type: 'upload',
        status: 'uploading-blocks',
        size: carBytes.length
      })
    }

    const carResult = await client.uploadFile(carFile)
    logger.info(`   ✅ CAR file uploaded: ${carResult.toString()}`)

    if (eventEmitter) {
      eventEmitter.emit('backupProgress', {
        type: 'upload',
        status: 'completed',
        metadataCID: metadataResult.toString(),
        carCID: carResult.toString()
      })
    }

    // Close database
    await database.close()

    logger.info('✅ CAR-based backup completed successfully!')

    return {
      success: true,
      method: 'car-timestamped',
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      carFileSize: carBytes.length,
      blockSummary: metadata.blockSummary,
      backupFiles: {
        metadata: backupFiles.metadata,
        blocks: backupFiles.blocks,
        metadataCID: metadataResult.toString(),
        carCID: carResult.toString()
      },
      timestamp: metadata.timestamp
    }
  } catch (error) {
    logger.error(`❌ CAR-based backup failed: ${error.message}`)
    
    if (eventEmitter) {
      eventEmitter.emit('backupProgress', {
        type: 'upload',
        status: 'error',
        error: error.message
      })
    }

    return {
      success: false,
      method: 'car-timestamped',
      error: error.message
    }
  }
}

/**
 * List all available backups in a space
 * 
 * @param {Object} options - Options
 * @param {string} [options.spaceName='default'] - Storacha space name
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @returns {Promise<Array>} List of available backups sorted by timestamp (newest first)
 */
export async function listAvailableBackups(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }

  // Initialize Storacha client
  let client
  if (config.ucanClient) {
    client = await initializeStorachaClientWithUCAN({
      client: config.ucanClient,
      spaceDID: config.spaceDID
    })
  } else {
    const storachaKey = config.storachaKey || 
      (typeof process !== 'undefined' ? process.env?.STORACHA_KEY : undefined)
    const storachaProof = config.storachaProof || 
      (typeof process !== 'undefined' ? process.env?.STORACHA_PROOF : undefined)

    if (!storachaKey || !storachaProof) {
      throw new Error('Storacha authentication required')
    }

    client = await initializeStorachaClient(storachaKey, storachaProof)
  }

  // List all files
  const result = await client.capability.upload.list({ size: 1000000 })
  const spaceFiles = result.results.map(upload => ({
    root: upload.root
  }))

  // Group by timestamp and find complete backups
  const filenames = spaceFiles.map(f => f.root.toString())
  const backupGroups = new Map()
  
  for (const file of filenames) {
    const match = file.match(/backup-(.*?)-(metadata\.json|blocks\.car)$/)
    if (match) {
      const [, timestamp, type] = match
      if (!backupGroups.has(timestamp)) {
        backupGroups.set(timestamp, new Set())
      }
      backupGroups.get(timestamp).add(type)
    }
  }

  // Get complete backups and sort by timestamp (newest first)
  const completeBackups = Array.from(backupGroups.entries())
    .filter(([, files]) => files.has('metadata.json') && files.has('blocks.car'))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([timestamp]) => ({
      timestamp,
      metadata: `backup-${timestamp}-metadata.json`,
      blocks: `backup-${timestamp}-blocks.car`,
      date: new Date(timestamp.replace(/-(\d{3})Z$/, '.$1Z').replace(/-/g, ':')).toISOString()
    }))

  return completeBackups
}

/**
 * Restore from a CAR-based backup in a space
 * 
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Object} options - Restore options
 * @param {string} [options.spaceName='default'] - Storacha space name
 * @param {string} [options.timestamp] - Specific backup timestamp to restore (e.g., '2025-10-27T14-30-00-123Z')
 *                                        If not provided, restores from latest backup
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress
 * @returns {Promise<Object>} Restore result
 */
export async function restoreFromSpaceCAR(orbitdb, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const spaceName = config.spaceName || 'default'
  const eventEmitter = options.eventEmitter

  logger.info('🔄 Starting CAR-based OrbitDB Restore')
  logger.info(`🗂️  Space: ${spaceName}`)

  try {
    // Initialize Storacha client
    let client
    if (config.ucanClient) {
      logger.info('🔐 Using UCAN authentication...')
      client = await initializeStorachaClientWithUCAN({
        client: config.ucanClient,
        spaceDID: config.spaceDID
      })
    } else {
      const storachaKey = config.storachaKey || 
        (typeof process !== 'undefined' ? process.env?.STORACHA_KEY : undefined)
      const storachaProof = config.storachaProof || 
        (typeof process !== 'undefined' ? process.env?.STORACHA_PROOF : undefined)

      if (!storachaKey || !storachaProof) {
        throw new Error('Storacha authentication required')
      }

      client = await initializeStorachaClient(storachaKey, storachaProof)
    }

    // Step 1: Find backup (specific timestamp or latest)
    let backupToRestore
    
    if (options.timestamp) {
      // Restore from specific timestamp
      logger.info(`📋 Step 1: Finding backup with timestamp: ${options.timestamp}...`)
      
      backupToRestore = {
        metadata: `backup-${options.timestamp}-metadata.json`,
        blocks: `backup-${options.timestamp}-blocks.car`,
        timestamp: options.timestamp
      }
      
      logger.info(`   ✅ Restoring from specific backup: ${options.timestamp}`)
    } else {
      // Find latest backup
      logger.info('📋 Step 1: Finding latest backup...')
      
      const result = await client.capability.upload.list({ size: 1000000 })
      const spaceFiles = result.results.map(upload => ({
        root: upload.root
      }))

      backupToRestore = findLatestBackup(spaceFiles, {
        onWarning: (msg) => logger.warn(msg)
      })

      if (!backupToRestore) {
        throw new Error('No valid CAR backup found in space')
      }

      logger.info(`   ✅ Found latest backup: ${backupToRestore.timestamp}`)
    }

    if (eventEmitter) {
      eventEmitter.emit('restoreProgress', {
        type: 'discovery',
        status: 'found',
        backup: backupToRestore
      })
    }

    // Step 2: Download metadata
    logger.info('📥 Step 2: Downloading metadata...')
    
    // Use direct CID if provided, otherwise use the backup filename
    const metadataCID = options.metadataCID || backupToRestore.metadata
    const metadataUrl = `${config.gateway}/ipfs/${metadataCID}`
    const metadataResponse = await fetch(metadataUrl)
    
    if (!metadataResponse.ok) {
      throw new Error(`Failed to download metadata: ${metadataResponse.statusText}`)
    }

    const metadata = await metadataResponse.json()

    if (!isValidMetadata(metadata)) {
      throw new Error('Invalid backup metadata')
    }

    logger.info(`   ✅ Metadata validated: ${metadata.totalBlocks} blocks, ${new Date(metadata.timestamp).toISOString()}`)

    // Step 3: Download CAR file
    logger.info('📥 Step 3: Downloading CAR file...')
    
    if (eventEmitter) {
      eventEmitter.emit('restoreProgress', {
        type: 'download',
        status: 'downloading-blocks'
      })
    }

    // Use direct CID if provided, otherwise use the backup filename
    const carCID = options.carCID || backupToRestore.blocks
    const carUrl = `${config.gateway}/ipfs/${carCID}`
    const carResponse = await fetch(carUrl)
    
    if (!carResponse.ok) {
      throw new Error(`Failed to download CAR file: ${carResponse.statusText}`)
    }

    const carBytes = new Uint8Array(await carResponse.arrayBuffer())
    logger.info(`   ✅ Downloaded CAR file: ${carBytes.length} bytes`)

    // Step 4: Extract blocks from CAR
    logger.info('📦 Step 4: Extracting blocks from CAR...')
    
    const blocks = await readBlocksFromCAR(carBytes)
    logger.info(`   ✅ Extracted ${blocks.size} blocks`)

    // Step 5: Restore blocks to OrbitDB
    logger.info('💾 Step 5: Restoring blocks to OrbitDB...')
    
    if (eventEmitter) {
      eventEmitter.emit('restoreProgress', {
        type: 'restore',
        status: 'restoring-blocks',
        total: blocks.size
      })
    }

    let restoredCount = 0
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString)
        await orbitdb.ipfs.blockstore.put(cid, blockData.bytes)
        restoredCount++
      } catch (error) {
        logger.warn(`Failed to restore block ${cidString}: ${error.message}`)
      }
    }

    logger.info(`   ✅ Restored ${restoredCount}/${blocks.size} blocks`)

    // Step 6: Open database
    logger.info('🔓 Step 6: Opening database...')
    
    const dbInfo = metadata.databases[0]
    const databaseAddress = dbInfo.address
    const database = await orbitdb.open(databaseAddress, { type: dbInfo.type })

    // Wait for entries to load
    await new Promise((resolve) => setTimeout(resolve, config.timeout / 10))

    const entries = await database.all()
    const entriesCount = Array.isArray(entries) ? entries.length : Object.keys(entries).length

    logger.info(`   ✅ Database opened: ${entriesCount} entries`)

    if (eventEmitter) {
      eventEmitter.emit('restoreProgress', {
        type: 'restore',
        status: 'completed',
        entriesRecovered: entriesCount
      })
    }

    logger.info('✅ CAR-based restore completed successfully!')

    return {
      success: true,
      method: 'car-timestamped',
      database,
      databaseAddress,
      name: database.name,
      type: database.type,
      entriesRecovered: entriesCount,
      blocksRestored: restoredCount,
      backupTimestamp: metadata.timestamp,
      backupUsed: backupToRestore
    }
  } catch (error) {
    logger.error(`❌ CAR-based restore failed: ${error.message}`)
    
    if (eventEmitter) {
      eventEmitter.emit('restoreProgress', {
        type: 'restore',
        status: 'error',
        error: error.message
      })
    }

    return {
      success: false,
      method: 'car-timestamped',
      error: error.message
    }
  }
}

export default {
  backupDatabaseCAR,
  restoreFromSpaceCAR,
  listAvailableBackups,
  createCARFromBlocks,
  readBlocksFromCAR
}
