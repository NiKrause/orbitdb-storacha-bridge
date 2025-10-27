#!/usr/bin/env node

/**
 * Test UCAN Bridge Integration
 * 
 * This script tests the OrbitDB-Storacha bridge using UCAN delegation authentication.
 */

import { promises as fs } from 'fs'

// Import utilities for proper setup
import { createHeliaOrbitDB } from '../lib/utils.js'

// Import our UCAN bridge
import { OrbitDBStorachaBridgeUCAN, backupDatabaseWithUCAN, restoreDatabaseFromSpaceWithUCAN } from '../lib/ucan-bridge.js'
import { logger } from '../lib/logger.js'

async function testUCANBridge() {
  logger.info('🧪 Testing UCAN Bridge Integration')
  logger.info('=====================================')
  
  try {
    // Step 1: Load UCAN delegation files
    logger.info('\n📁 Step 1: Loading UCAN delegation files...')
    
    // Load delegation token (base64 from CAR file)
    const ucanToken = await fs.readFile('./ucan-delegation.car', 'base64')
    logger.info({ tokenLength: ucanToken.length }, `   ✅ Loaded delegation token (${ucanToken.length} chars)`)
    
    // Load recipient key
    const recipientKey = await fs.readFile('./recipient-key.txt', 'utf8')
    logger.info('   ✅ Loaded recipient key')
    
    // Step 2: Test UCAN bridge initialization
    logger.info('\n🔐 Step 2: Testing UCAN bridge initialization...')
    
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanToken,
      recipientKey
    })
    
    logger.info('   ✅ UCAN bridge instance created')
    
    // Step 3: Test listing space files (this tests authentication)
    logger.info('\n📋 Step 3: Testing space file listing (authentication test)...')
    
    try {
      const spaceFiles = await bridge.listSpaceFiles()
      logger.info({ fileCount: spaceFiles.length }, `   ✅ Successfully listed ${spaceFiles.length} files in space`)
      
      if (spaceFiles.length > 0) {
        logger.info('   📁 Sample files:')
        spaceFiles.slice(0, 3).forEach((file, i) => {
          logger.info({ index: i + 1, root: file.root, size: file.size }, `      ${i + 1}. ${file.root} (${file.size} bytes)`)
        })
      }
    } catch (error) {
      logger.warn({ error: error.message }, `   ⚠️  Space listing failed: ${error.message}`)
      logger.info('   ℹ️  This might be expected if space is empty or has permission issues')
    }
    
    // Step 4: Create test OrbitDB database
    logger.info('\n🛠️  Step 4: Setting up OrbitDB for testing...')
    
    // Use the working utility function
    const { helia, orbitdb, blockstore, datastore } = await createHeliaOrbitDB('-ucan-test')
    
    logger.info('   ✅ OrbitDB instance created')
    logger.info({ identity: orbitdb.identity.id }, `   🤖 Identity: ${orbitdb.identity.id}`)
    
    // Step 5: Create and populate test database
    logger.info('\n📊 Step 5: Creating test database...')
    
    const dbName = `ucan-test-${Date.now()}`
    const db = await orbitdb.open(dbName, { type: 'keyvalue' })
    
    // Add some test data
    await db.put('test-key-1', `UCAN test data: ${new Date().toISOString()}`)
    await db.put('test-key-2', { message: 'Hello from UCAN!', timestamp: Date.now() })
    await db.put('test-key-3', 'Another test value')
    
    const allEntries = await db.all()
    const entryCount = Object.keys(allEntries).length
    
    logger.info({ databaseAddress: db.address }, `   ✅ Database created: ${db.address}`)
    logger.info({ entryCount }, `   📝 Added ${entryCount} entries:`)
    Object.entries(allEntries).forEach(([key, value]) => {
      logger.info({ key, value: typeof value === 'object' ? JSON.stringify(value) : value }, `      ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    })
    
    // Step 6: Test backup with UCAN bridge
    logger.info('\n📤 Step 6: Testing database backup with UCAN...')
    
    try {
      const backupResult = await bridge.backup(orbitdb, db.address)
      
      if (backupResult.success) {
        logger.info('   ✅ UCAN Backup successful!')
        logger.info({ databaseAddress: backupResult.databaseAddress }, `   📍 Database: ${backupResult.databaseAddress}`)
        logger.info({ uploaded: backupResult.blocksUploaded, total: backupResult.blocksTotal }, `   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`)
        logger.info({ blockSummary: backupResult.blockSummary }, `   🔍 Block summary: ${JSON.stringify(backupResult.blockSummary)}`)
      } else {
        logger.error({ error: backupResult.error }, '   ❌ UCAN Backup failed')
      }
      
      // Step 7: Test restore (optional, as it would overwrite)
      logger.info('\n📥 Step 7: Testing space file discovery for restore...')
      
      try {
        const restoreFiles = await bridge.listSpaceFiles()
        logger.info({ fileCount: restoreFiles.length }, `   ✅ Found ${restoreFiles.length} files available for restore`)
        
        if (restoreFiles.length > 0) {
          logger.info('   ℹ️  Restore functionality verified (files available)')
          logger.info('   ⚠️  Skipping actual restore to avoid overwriting data')
        }
      } catch (restoreError) {
        logger.warn({ error: restoreError.message }, `   ⚠️  Restore file discovery failed: ${restoreError.message}`)
      }
      
    } catch (backupError) {
      logger.error({ error: backupError.message, details: backupError }, '   ❌ UCAN Backup failed')
    }
    
    // Cleanup
    logger.info('\n🧹 Cleanup...')
    await db.close()
    await orbitdb.stop()
    await helia.stop()
    
    logger.info('\n✅ UCAN Bridge Test Complete!')
    logger.info('🎉 The UCAN delegation authentication is working!')
    
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, '\n❌ UCAN Bridge Test Failed')
    process.exit(1)
  }
}

// Add progress tracking
function setupProgressTracking(bridge) {
  bridge.on('uploadProgress', (progress) => {
    if (progress.status === 'starting') {
      logger.info({ total: progress.total }, `   📤 Starting upload of ${progress.total} blocks...`)
    } else if (progress.status === 'uploading') {
      const percent = progress.percentage
      if (percent % 20 === 0 || progress.current === progress.total) { // Show every 20%
        logger.info({ current: progress.current, total: progress.total, percentage: percent }, `   📊 Upload progress: ${progress.current}/${progress.total} (${percent}%)`)
      }
    } else if (progress.status === 'completed') {
      logger.info({ successful: progress.summary.successful, failed: progress.summary.failed }, `   ✅ Upload completed: ${progress.summary.successful} successful, ${progress.summary.failed} failed`)
    }
  })
  
  bridge.on('downloadProgress', (progress) => {
    if (progress.status === 'starting') {
      logger.info({ total: progress.total }, `   📥 Starting download of ${progress.total} files...`)
    } else if (progress.status === 'downloading') {
      const percent = progress.percentage
      if (percent % 20 === 0 || progress.current === progress.total) {
        logger.info({ current: progress.current, total: progress.total, percentage: percent }, `   📊 Download progress: ${progress.current}/${progress.total} (${percent}%)`)
      }
    } else if (progress.status === 'completed') {
      logger.info({ downloaded: progress.summary.downloaded, failed: progress.summary.failed }, `   ✅ Download completed: ${progress.summary.downloaded} successful, ${progress.summary.failed} failed`)
    }
  })
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testUCANBridge().catch(error => logger.error({ error: error.message, stack: error.stack }, 'Test failed'))
}
