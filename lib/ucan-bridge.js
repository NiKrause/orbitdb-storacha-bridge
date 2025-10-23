/**
 * OrbitDB Storacha Bridge - UCAN Edition
 * 
 * Enhanced version that supports UCAN-based authentication for Storacha,
 * eliminating the need for traditional storachaKey/storachaProof credentials.
 */

import * as Client from '@web3-storage/w3up-client'
import { StoreMemory } from '@web3-storage/w3up-client/stores/memory'
import { Signer } from '@web3-storage/w3up-client/principal/ed25519'
import * as Delegation from '@ucanto/core/delegation'
import * as Proof from '@web3-storage/w3up-client/proof'
import { CID } from 'multiformats/cid'
import { promises as fs } from 'fs'
import { EventEmitter } from 'events'

// Import existing functions from the main bridge
import {
  extractDatabaseBlocks,
  convertStorachaCIDToOrbitDB,
  downloadBlockFromStoracha,
  analyzeBlocks,
  clearStorachaSpace as originalClearStorachaSpace,
  reconstructWithoutManifest,
} from './orbitdb-storacha-bridge.js'

/**
 * Find the correct manifest block by matching log entries to database IDs
 * (Shared implementation with main bridge)
 * 
 * @param {Object} analysis - Block analysis results
 * @returns {Object|null} - Correct manifest block or null if not found
 */
function findCorrectManifest(analysis) {
  console.log('🎯 Finding correct manifest from log entries...')
  
  if (analysis.manifestBlocks.length === 1) {
    console.log('   ✅ Only one manifest found, using it')
    return analysis.manifestBlocks[0]
  }
  
  if (analysis.manifestBlocks.length === 0) {
    console.log('   ❌ No manifest blocks found')
    return null
  }
  
  // Extract database IDs from log entries
  const databaseIds = new Set()
  for (const logEntry of analysis.logEntryBlocks) {
    if (logEntry.content && logEntry.content.id) {
      // Extract manifest CID from database address like '/orbitdb/zdpu...'
      const manifestCID = logEntry.content.id.replace('/orbitdb/', '')
      databaseIds.add(manifestCID)
      console.log(`   📝 Log entry references database: ${logEntry.content.id} (manifest: ${manifestCID})`)
    }
  }
  
  console.log(`   🔍 Found ${databaseIds.size} unique database ID(s) from ${analysis.logEntryBlocks.length} log entries`)
  
  // Find manifest that matches the most referenced database ID
  const manifestCounts = new Map()
  for (const manifestBlock of analysis.manifestBlocks) {
    const count = databaseIds.has(manifestBlock.cid) ? 1 : 0
    manifestCounts.set(manifestBlock.cid, count)
    console.log(`   📋 Manifest ${manifestBlock.cid}: ${count > 0 ? 'MATCHES' : 'no match'}`)
  }
  
  // Find the manifest with the highest count (most log entry references)
  let bestManifest = null
  let bestCount = -1
  
  for (const [manifestCID, count] of manifestCounts) {
    if (count > bestCount) {
      bestCount = count
      bestManifest = analysis.manifestBlocks.find(m => m.cid === manifestCID)
    }
  }
  
  if (bestManifest && bestCount > 0) {
    console.log(`   ✅ Selected manifest: ${bestManifest.cid} (referenced by ${bestCount} log entries)`)
    return bestManifest
  }
  
  // Fallback: if no manifest matches log entries, use the first one and warn
  console.warn('   ⚠️ No manifest matched log entries, using first manifest as fallback')
  return analysis.manifestBlocks[0]
}

/**
 * Default configuration options for UCAN bridge
 */
const DEFAULT_UCAN_OPTIONS = {
  timeout: 30000,
  gateway: 'https://w3s.link',
  batchSize: 10,
  maxConcurrency: 3,
  // UCAN-specific options
  ucanFile: undefined,           // Path to UCAN CAR file
  ucanToken: undefined,          // Base64-encoded UCAN token
  recipientKey: undefined,       // Recipient identity private key (for delegation)
  agentDID: undefined,           // Agent DID for the client
  spaceDID: undefined,           // Target space DID
  // Fallback options
  fallbackDatabaseName: undefined,
  forceFallback: false,
}

/**
 * Load UCAN delegation from CAR file
 * 
 * @param {string} ucanFilePath - Path to UCAN CAR file
 * @returns {Promise<Object>} - Parsed UCAN delegation
 */
async function loadUCANFromFile(ucanFilePath) {
  try {
    console.log(`📖 Loading UCAN from file: ${ucanFilePath}`)
    
    const carBytes = await fs.readFile(ucanFilePath)
    
    // Extract the delegation directly from CAR bytes (like SecretShare)
    const delegation = await Delegation.extract(carBytes)
    
    if (!delegation.ok) {
      throw new Error('Failed to extract delegation from CAR file')
    }
    
    const extractedDelegation = delegation.ok
    
    console.log(`✅ UCAN loaded successfully`)
    console.log(`   📋 Capabilities: ${extractedDelegation.capabilities.map(cap => cap.can).join(', ')}`)
    console.log(`   🎯 Audience: ${extractedDelegation.audience.did()}`)
    console.log(`   🔑 Issuer: ${extractedDelegation.issuer.did()}`)
    
    return extractedDelegation
  } catch (error) {
    throw new Error(`Failed to load UCAN from file ${ucanFilePath}: ${error.message}`)
  }
}

/**
 * Load UCAN delegation from base64 token
 * 
 * @param {string} ucanToken - Base64-encoded UCAN token
 * @returns {Promise<Object>} - Parsed UCAN delegation
 */
async function loadUCANFromToken(ucanToken) {
  try {
    console.log(`📖 Loading UCAN from token`)
    
    // Decode base64 token
    const tokenBytes = Buffer.from(ucanToken, 'base64')
    
    // Try @ucanto/core/delegation first (for pure UCAN tokens)
    try {
      const delegation = await Delegation.extract(tokenBytes)
      
      if (delegation.ok) {
        const extractedDelegation = delegation.ok
        console.log(`✅ UCAN token loaded successfully with @ucanto/core`)
        console.log(`   📋 Capabilities: ${extractedDelegation.capabilities.map(cap => cap.can).join(', ')}`)
        console.log(`   🎯 Audience: ${extractedDelegation.audience.did()}`)
        console.log(`   🔑 Issuer: ${extractedDelegation.issuer.did()}`)
        return extractedDelegation
      }
    } catch (ucantoError) {
      console.log(`   ⚠️  @ucanto/core failed: ${ucantoError.message.substring(0, 100)}...`)
    }
    
    // Try @web3-storage/w3up-client/proof (for w3 CLI generated tokens)
    try {
      const proof = await Proof.parse(tokenBytes)
      console.log(`✅ UCAN token loaded successfully with w3up-client/proof`)
      console.log(`   📋 Proof CID: ${proof.cid}`)
      
      // The proof itself is the delegation we need
      return proof
      
    } catch (proofError) {
      console.log(`   ⚠️  w3up-client/proof failed: ${proofError.message.substring(0, 100)}...`)
    }
    
    throw new Error('Failed to parse token with both @ucanto/core and @web3-storage/w3up-client methods')
    
  } catch (error) {
    throw new Error(`Failed to load UCAN from token: ${error.message}`)
  }
}

/**
 * Initialize Storacha client using UCAN delegation (SecretShare pattern)
 * 
 * @param {Object} options - UCAN configuration options
 * @returns {Promise<Object>} - Initialized Storacha client
 */
async function initializeStorachaClientWithUCAN(options) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options }
  
  console.log('🔐 Initializing Storacha client with UCAN authentication...')
  
  // Method 1: Use proper UCAN delegation (from our working example)
  if (config.ucanToken && config.recipientKey) {
    console.log('   🎉 Using proper UCAN delegation approach...')
    
    try {
      // Parse recipient identity from JSON archive and fix the key format
      const recipientKeyData = JSON.parse(config.recipientKey)
      
      // JSON serialization converts Uint8Array to plain object, so we need to reconstruct it
      const fixedArchive = {
        id: recipientKeyData.id,
        keys: {
          [recipientKeyData.id]: new Uint8Array(Object.values(recipientKeyData.keys[recipientKeyData.id]))
        }
      }
      
      const recipientPrincipal = Signer.from(fixedArchive)
      const store = new StoreMemory()
      const client = await Client.create({ principal: recipientPrincipal, store })
      
      // Parse delegation token
      const delegationBytes = Buffer.from(config.ucanToken, 'base64')
      const delegation = await Delegation.extract(delegationBytes)
      
      if (!delegation.ok) {
        throw new Error('Failed to extract delegation from token')
      }
      
      // Add space using delegation
      const space = await client.addSpace(delegation.ok)
      await client.setCurrentSpace(space.did())
      
      console.log('✅ Storacha client initialized with UCAN delegation')
      console.log(`   🤖 Agent: ${recipientPrincipal.did()}`)
      console.log(`   🚀 Space: ${space.did()}`)
      console.log(`   📋 Capabilities: ${delegation.ok.capabilities.length}`)
      
      return client
      
    } catch (error) {
      console.log(`   ⚠️  UCAN delegation failed: ${error.message}`)
    }
  }
  
  // Method 2: Try legacy approaches as fallback
  try {
    let delegation
    
    if (config.ucanFile) {
      delegation = await loadUCANFromFile(config.ucanFile)
    } else if (config.ucanToken) {
      delegation = await loadUCANFromToken(config.ucanToken)
    }
    
    if (delegation && delegation.audience) {
      console.log(`   🔄 Using legacy delegation approach...`)
      
      const audience = delegation.audience
      const store = new StoreMemory()
      const client = await Client.create({ principal: audience, store })
      const space = await client.addSpace(delegation)
      await client.setCurrentSpace(space.did())
      
      console.log('✅ Storacha client initialized with legacy delegation')
      console.log(`   🤖 Agent: ${audience.did()}`)
      console.log(`   🚀 Space: ${space.did()}`)
      
      return client
    }
    
  } catch (delegationError) {
    console.log(`   ⚠️  Legacy delegation failed: ${delegationError.message}`)
  }
  
  throw new Error('All UCAN authentication methods failed. Please check your UCAN credentials.')
}

/**
 * Backup database using UCAN authentication
 * 
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - UCAN backup options
 * @returns {Promise<Object>} - Backup result
 */
export async function backupDatabaseWithUCAN(orbitdb, databaseAddress, options = {}) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options }
  const eventEmitter = options.eventEmitter
  
  console.log('🚀 Starting OrbitDB Database Backup to Storacha (UCAN)')
  console.log(`📍 Database: ${databaseAddress}`)
  
  try {
    // Initialize Storacha client with UCAN
    const client = await initializeStorachaClientWithUCAN(config)
    
    // Open the database
    const database = typeof databaseAddress === 'string' && databaseAddress.startsWith('/orbitdb/') 
      ? await orbitdb.open(databaseAddress)
      : await orbitdb.open(databaseAddress)
    
    // Extract all blocks (reuse existing function)
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(database)
    
    // Upload blocks to Storacha with progress tracking
    const { successful, cidMappings } = await uploadBlocksToStorachaUCAN(
      blocks, 
      client, 
      config.batchSize, 
      config.maxConcurrency, 
      eventEmitter
    )
    
    if (successful.length === 0) {
      throw new Error('No blocks were successfully uploaded')
    }
    
    // Get block summary
    const blockSummary = {}
    for (const [_hash, source] of blockSources) {
      blockSummary[source] = (blockSummary[source] || 0) + 1
    }
    
    console.log('✅ UCAN Backup completed successfully!')
    
    return {
      success: true,
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      blocksUploaded: successful.length,
      blockSummary,
      cidMappings: Object.fromEntries(cidMappings)
    }
    
  } catch (error) {
    console.error('❌ UCAN Backup failed:', error.message)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Upload blocks to Storacha using UCAN client
 */
async function uploadBlocksToStorachaUCAN(blocks, client, batchSize = 10, maxConcurrency = 3, eventEmitter = null) {
  console.log(`📤 Uploading ${blocks.size} blocks to Storacha (UCAN) in batches of ${batchSize}...`)
  
  const uploadResults = []
  const cidMappings = new Map()
  const blocksArray = Array.from(blocks.entries())
  const totalBlocks = blocks.size
  let completedBlocks = 0

  // Emit initial progress
  if (eventEmitter) {
    eventEmitter.emit('uploadProgress', {
      type: 'upload',
      current: 0,
      total: totalBlocks,
      percentage: 0,
      status: 'starting'
    })
  }

  // Helper function to upload a single block
  const uploadSingleBlock = async ([hash, blockData]) => {
    try {
      const blockFile = new File([blockData.bytes], hash, {
        type: 'application/octet-stream'
      })
      
      console.log(`   📤 Uploading block ${hash} (${blockData.bytes.length} bytes)...`)
      
      // Use UCAN-authenticated client
      const result = await client.uploadFile(blockFile)
      const uploadedCID = result.toString()
      
      console.log(`   ✅ Uploaded (UCAN): ${hash} → ${uploadedCID}`)
      
      // Update progress
      completedBlocks++
      if (eventEmitter) {
        eventEmitter.emit('uploadProgress', {
          type: 'upload',
          current: completedBlocks,
          total: totalBlocks,
          percentage: Math.round((completedBlocks / totalBlocks) * 100),
          status: 'uploading',
          currentBlock: {
            hash,
            uploadedCID,
            size: blockData.bytes.length
          }
        })
      }
      
      return {
        originalHash: hash,
        uploadedCID,
        size: blockData.bytes.length
      }
    } catch (error) {
      console.error(`   ❌ Failed to upload block ${hash}: ${error.message}`)
      
      completedBlocks++
      if (eventEmitter) {
        eventEmitter.emit('uploadProgress', {
          type: 'upload',
          current: completedBlocks,
          total: totalBlocks,
          percentage: Math.round((completedBlocks / totalBlocks) * 100),
          status: 'uploading',
          error: {
            hash,
            message: error.message
          }
        })
      }
      
      return {
        originalHash: hash,
        error: error.message,
        size: blockData.bytes.length
      }
    }
  }
  
  // Process blocks in batches (reuse existing batching logic)
  for (let i = 0; i < blocksArray.length; i += batchSize * maxConcurrency) {
    const megaBatch = blocksArray.slice(i, i + batchSize * maxConcurrency)
    const batches = []
    
    for (let j = 0; j < megaBatch.length; j += batchSize) {
      const batch = megaBatch.slice(j, j + batchSize)
      batches.push(batch)
    }
    
    console.log(`   🔄 Processing ${batches.length} concurrent batches (${megaBatch.length} blocks)...`)
    
    const batchPromises = batches.map(async (batch, batchIndex) => {
      console.log(`     📦 Batch ${batchIndex + 1}/${batches.length}: ${batch.length} blocks`)
      
      const batchResults = await Promise.allSettled(
        batch.map(uploadSingleBlock)
      )
      
      return batchResults.map(result => 
        result.status === 'fulfilled' ? result.value : {
          originalHash: 'unknown',
          error: result.reason?.message || 'Unknown error',
          size: 0
        }
      )
    })
    
    const batchResults = await Promise.all(batchPromises)
    
    for (const batchResult of batchResults) {
      for (const result of batchResult) {
        uploadResults.push(result)
        if (result.uploadedCID) {
          cidMappings.set(result.originalHash, result.uploadedCID)
        }
      }
    }
  }
  
  const successful = uploadResults.filter(r => r.uploadedCID)
  const failed = uploadResults.filter(r => r.error)
  
  console.log(`   📊 UCAN Upload summary:`)
  console.log(`      Total blocks: ${blocks.size}`)
  console.log(`      Successful: ${successful.length}`)
  console.log(`      Failed: ${failed.length}`)
  
  if (eventEmitter) {
    eventEmitter.emit('uploadProgress', {
      type: 'upload',
      current: totalBlocks,
      total: totalBlocks,
      percentage: 100,
      status: 'completed',
      summary: {
        successful: successful.length,
        failed: failed.length
      }
    })
  }

  return { uploadResults, successful, failed, cidMappings }
}

/**
 * Restore database from Storacha using UCAN authentication
 * 
 * @param {Object} orbitdb - Target OrbitDB instance
 * @param {Object} options - UCAN restore options
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreDatabaseFromSpaceWithUCAN(orbitdb, options = {}) {
  const config = { ...DEFAULT_UCAN_OPTIONS, ...options }
  const eventEmitter = options.eventEmitter
  
  console.log('🔄 Starting OrbitDB Restore from Storacha (UCAN)')
  
  try {
    // Step 1: List ALL files in Storacha space using UCAN
    console.log('\\n📋 Step 1: Discovering all files in Storacha space (UCAN)...')
    const spaceFiles = await listStorachaSpaceFilesWithUCAN(config)
    
    if (spaceFiles.length === 0) {
      throw new Error('No files found in Storacha space')
    }
    
    console.log(`   🎉 SUCCESS! Found ${spaceFiles.length} files in space using UCAN authentication`)
    
    // Step 2: Download ALL files from space with progress tracking
    const downloadedBlocks = await downloadBlocksWithProgressUCAN(spaceFiles, orbitdb, config, eventEmitter)
    
    // Step 3: Intelligent block analysis
    console.log('\\n🔍 Step 3: Analyzing block structure with advanced intelligence...')
    const analysis = await analyzeBlocks(orbitdb.ipfs.blockstore, downloadedBlocks)
    
    if (analysis.manifestBlocks.length === 0 || options.forceFallback) {
      console.log('⚠️ No manifest blocks found - attempting fallback reconstruction...')
      
      // Use existing fallback reconstruction logic
      const fallbackResult = await reconstructWithoutManifest(orbitdb, downloadedBlocks, config)
      
      return {
        database: fallbackResult.database,
        metadata: fallbackResult.metadata,
        entriesCount: fallbackResult.entriesCount,
        entriesRecovered: fallbackResult.entriesCount,
        method: 'fallback-reconstruction',
        success: true,
        preservedHashes: false,
        preservedAddress: false
      }
    }

    // Step 4: Reconstruct database using discovered manifest
    console.log('\\n🔄 Step 4: Reconstructing database from analysis...')
    
    // Find the correct manifest by matching log entries to database IDs
    const correctManifest = findCorrectManifest(analysis)
    if (!correctManifest) {
      throw new Error('Could not determine correct manifest from log entries')
    }
    
    const databaseAddress = `/orbitdb/${correctManifest.cid}`
    
    console.log(`   📥 Opening database at: ${databaseAddress}`)
    console.log(`   🎯 Selected manifest: ${correctManifest.cid} (matched from log entries)`)
    const reconstructedDB = await orbitdb.open(databaseAddress)
    
    // Wait for entries to load
    console.log('   ⏳ Waiting for entries to load...')
    await new Promise(resolve => setTimeout(resolve, config.timeout / 10))
    const reconstructedEntries = await reconstructedDB.all()
    await new Promise(resolve => setTimeout(resolve, config.timeout / 10))
    
    // Handle different database types properly (reuse existing logic)
    let entriesArray
    let entriesCount
    if (reconstructedDB.type === 'keyvalue') {
      const logEntries = await reconstructedDB.log.values()
      entriesArray = logEntries.map(logEntry => ({
        hash: logEntry.hash,
        payload: logEntry.payload
      }))
      entriesCount = Object.keys(reconstructedEntries).length
    } else {
      entriesArray = Array.isArray(reconstructedEntries) ? reconstructedEntries : []
      entriesCount = entriesArray.length
    }
    
    console.log(`   📊 Reconstructed entries: ${entriesCount}`)
    console.log(`   🔍 Database type: ${reconstructedDB.type}`)
    
    console.log('✅ UCAN Restore completed successfully!')
    
    return {
      success: true,
      database: reconstructedDB,
      orbitdb: orbitdb,
      manifestCID: correctManifest.cid,
      address: reconstructedDB.address,
      name: reconstructedDB.name,
      type: reconstructedDB.type,
      entriesRecovered: entriesCount,
      blocksRestored: downloadedBlocks.size,
      addressMatch: reconstructedDB.address === databaseAddress,
      spaceFilesFound: spaceFiles.length,
      analysis,
      entries: entriesArray,
    }
    
  } catch (error) {
    console.error('❌ UCAN Restore failed:', error.message)
    
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * List Storacha space files using UCAN authentication
 */
async function listStorachaSpaceFilesWithUCAN(options = {}) {
  console.log('📋 Listing files in Storacha space using UCAN...')
  
  try {
    // Initialize client with UCAN
    const client = await initializeStorachaClientWithUCAN(options)
    
    // Use existing list logic but with UCAN client
    const listOptions = {}
    if (options.size) {
      listOptions.size = parseInt(String(options.size))
    } else {
      listOptions.size = 1000000
    }
    if (options.cursor) {
      listOptions.cursor = options.cursor
    }
    if (options.pre) {
      listOptions.pre = options.pre
    }
    
    const result = await client.capability.upload.list(listOptions)
    
    console.log(`   ✅ Found ${result.results.length} uploads in space (UCAN)`)
    
    const spaceFiles = result.results.map(upload => ({
      root: upload.root.toString(),
      uploaded: upload.insertedAt ? new Date(upload.insertedAt) : new Date(),
      size: upload.shards?.reduce((total, shard) => {
        return total + (shard.size || 0)
      }, 0) || 'unknown',
      shards: upload.shards?.length || 0,
      insertedAt: upload.insertedAt,
      updatedAt: upload.updatedAt
    }))
    
    return spaceFiles
  } catch (error) {
    console.error('   ❌ UCAN listing error:', error.message)
    throw error
  }
}

/**
 * Download blocks with UCAN authentication
 */
async function downloadBlocksWithProgressUCAN(spaceFiles, currentOrbitDB, config, eventEmitter = null) {
  console.log('\\n📥 Downloading all space files (UCAN)...')
  const downloadedBlocks = new Map()
  const totalFiles = spaceFiles.length
  let completedFiles = 0

  if (eventEmitter) {
    eventEmitter.emit('downloadProgress', {
      type: 'download',
      current: 0,
      total: totalFiles,
      percentage: 0,
      status: 'starting'
    })
  }

  for (const spaceFile of spaceFiles) {
    const storachaCID = spaceFile.root
    console.log(`   🔄 Downloading (UCAN): ${storachaCID}`)
    
    try {
      const bytes = await downloadBlockFromStoracha(storachaCID, config)
      
      const orbitdbCID = convertStorachaCIDToOrbitDB(storachaCID)
      const parsedCID = CID.parse(orbitdbCID)
      
      await currentOrbitDB.ipfs.blockstore.put(parsedCID, bytes)
      downloadedBlocks.set(orbitdbCID, { storachaCID, bytes: bytes.length })
      
      console.log(`   ✅ Stored (UCAN): ${orbitdbCID}`)
      
      completedFiles++
      if (eventEmitter) {
        eventEmitter.emit('downloadProgress', {
          type: 'download',
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: 'downloading',
          currentBlock: {
            storachaCID,
            orbitdbCID,
            size: bytes.length
          }
        })
      }
      
    } catch (error) {
      console.error(`   ❌ Failed (UCAN): ${storachaCID} - ${error.message}`)
      
      completedFiles++
      if (eventEmitter) {
        eventEmitter.emit('downloadProgress', {
          type: 'download',
          current: completedFiles,
          total: totalFiles,
          percentage: Math.round((completedFiles / totalFiles) * 100),
          status: 'downloading',
          error: {
            storachaCID,
            message: error.message
          }
        })
      }
    }
  }

  if (eventEmitter) {
    eventEmitter.emit('downloadProgress', {
      type: 'download',
      current: totalFiles,
      total: totalFiles,
      percentage: 100,
      status: 'completed',
      summary: {
        downloaded: downloadedBlocks.size,
        failed: totalFiles - downloadedBlocks.size
      }
    })
  }

  console.log(`   📊 Downloaded ${downloadedBlocks.size} blocks total (UCAN)`)
  return downloadedBlocks
}

/**
 * Clear Storacha space using UCAN authentication
 */
export async function clearStorachaSpaceWithUCAN(options = {}) {
  console.log('🧹 Clearing Storacha space using UCAN...')
  
  // Initialize client with UCAN
  const _client = await initializeStorachaClientWithUCAN(options) // Prefixed with underscore
  
  // Use the existing clear logic but pass UCAN-authenticated client
  // This would require modifying the original functions to accept a client parameter
  return await originalClearStorachaSpace({
    ...options,
    // Pass the client somehow - this needs refactoring in original functions
  })
}

/**
 * Enhanced OrbitDBStorachaBridge class with UCAN support
 */
export class OrbitDBStorachaBridgeUCAN extends EventEmitter {
  constructor(options = {}) {
    super()
    this.config = { ...DEFAULT_UCAN_OPTIONS, ...options }
  }
  
  async backup(orbitdb, databaseAddress, options = {}) {
    return await backupDatabaseWithUCAN(orbitdb, databaseAddress, { 
      ...this.config, 
      ...options, 
      eventEmitter: this 
    })
  }
  
  async restoreFromSpace(orbitdb, options = {}) {
    return await restoreDatabaseFromSpaceWithUCAN(orbitdb, { 
      ...this.config, 
      ...options, 
      eventEmitter: this 
    })
  }
  
  // Utility methods
  async listSpaceFiles(options = {}) {
    return await listStorachaSpaceFilesWithUCAN({ ...this.config, ...options })
  }
  
  async clearSpace(options = {}) {
    return await clearStorachaSpaceWithUCAN({ ...this.config, ...options })
  }
  
  convertCID(storachaCID) {
    return convertStorachaCIDToOrbitDB(storachaCID)
  }
}

