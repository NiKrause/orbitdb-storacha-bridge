/**
 * CAR-based Timestamped Backup Demo
 * 
 * Demonstrates the new CAR-based backup approach that:
 * - Creates timestamped backups (multiple versions)
 * - Uses efficient CAR format (fewer files uploaded)
 * - Works in both Node.js and browser environments
 * - Is backward compatible with existing backup approach
 */

import 'dotenv/config'
import { backupDatabaseCAR, restoreFromSpaceCAR } from '../lib/backup-car.js'
import { backupDatabase as backupDatabaseLegacy } from '../lib/orbitdb-storacha-bridge.js'
import { createHeliaOrbitDB } from '../lib/utils.js'
import logger from '../lib/logger.js'

/**
 * Demo: Create multiple timestamped backups
 */
async function demoTimestampedBackups() {
  logger.info('🎯 Demo 1: Multiple Timestamped Backups')
  logger.info('=' .repeat(60))
  
  const node = await createHeliaOrbitDB('-car-demo')
  
  try {
    // Create database with sample data
    const db = await node.orbitdb.open('products', { type: 'documents' })
    
    // Version 1: Initial data
    await db.put({ _id: 'prod1', name: 'Widget', price: 10 })
    await db.put({ _id: 'prod2', name: 'Gadget', price: 20 })
    
    logger.info('\n📦 Creating backup v1...')
    const backup1 = await backupDatabaseCAR(node.orbitdb, db.address, {
      spaceName: 'my-products',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (backup1.success) {
      logger.info(`✅ Backup v1 created at ${new Date(backup1.timestamp).toISOString()}`)
      logger.info(`   Files: ${backup1.backupFiles.metadata}`)
      logger.info(`          ${backup1.backupFiles.blocks}`)
    }
    
    // Wait a bit and create version 2
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // Version 2: Update prices
    await db.put({ _id: 'prod1', name: 'Widget', price: 12 })
    await db.put({ _id: 'prod3', name: 'Doohickey', price: 30 })
    
    logger.info('\n📦 Creating backup v2...')
    const backup2 = await backupDatabaseCAR(node.orbitdb, db.address, {
      spaceName: 'my-products',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (backup2.success) {
      logger.info(`✅ Backup v2 created at ${new Date(backup2.timestamp).toISOString()}`)
      logger.info(`   Both backups now exist in the space!`)
    }
    
    await db.close()
  } finally {
    await node.orbitdb.stop()
    await node.helia.stop()
    await node.blockstore.close()
    await node.datastore.close()
  }
}

/**
 * Demo: List all available backups
 */
async function demoListBackups() {
  logger.info('\n🎯 Demo 2: List All Available Backups')
  logger.info('=' .repeat(60))
  
  const { listAvailableBackups } = await import('../lib/backup-car.js')
  
  try {
    logger.info('\n🔍 Listing all backups in space...')
    
    const backups = await listAvailableBackups({
      spaceName: 'my-products',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (backups.length === 0) {
      logger.info('   No backups found')
    } else {
      logger.info(`\n📋 Found ${backups.length} backup(s):\n`)
      backups.forEach((backup, index) => {
        logger.info(`   ${index + 1}. ${backup.date}`)
        logger.info(`      Timestamp: ${backup.timestamp}`)
        logger.info(`      Files: ${backup.metadata}`)  
        logger.info(`             ${backup.blocks}\n`)
      })
    }
  } catch (error) {
    logger.error(`❌ Failed to list backups: ${error.message}`)
  }
}

/**
 * Demo: Restore from specific backup timestamp
 */
async function demoRestoreSpecific() {
  logger.info('\n🎯 Demo 3: Restore from Specific Backup')
  logger.info('=' .repeat(60))
  
  const { listAvailableBackups } = await import('../lib/backup-car.js')
  const node = await createHeliaOrbitDB('-car-specific')
  
  try {
    // First, list available backups
    logger.info('\n🔍 Step 1: Finding available backups...')
    const backups = await listAvailableBackups({
      spaceName: 'my-products',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (backups.length < 2) {
      logger.info('   Need at least 2 backups for this demo. Run demo 1 first!')
      return
    }
    
    // Restore from second-to-last backup (not the latest)
    const olderBackup = backups[1]  // Index 1 = second newest
    logger.info(`\n🕙 Step 2: Restoring from older backup...`)
    logger.info(`   Timestamp: ${olderBackup.timestamp}`)
    logger.info(`   Date: ${olderBackup.date}`)
    
    const restoreResult = await restoreFromSpaceCAR(node.orbitdb, {
      spaceName: 'my-products',
      timestamp: olderBackup.timestamp,  // Restore specific version!
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (restoreResult.success) {
      logger.info(`\n✅ Restored from specific backup!`)
      logger.info(`   Backup date: ${new Date(restoreResult.backupTimestamp).toISOString()}`)
      logger.info(`   Entries recovered: ${restoreResult.entriesRecovered}`)
      
      const entries = await restoreResult.database.all()
      logger.info('\n📄 Data from that point in time:')
      entries.forEach(entry => {
        logger.info(`   ${entry._id}: ${entry.name} - $${entry.price}`)
      })
      
      await restoreResult.database.close()
    } else {
      logger.error(`❌ Restore failed: ${restoreResult.error}`)
    }
  } catch (error) {
    logger.error(`❌ Demo failed: ${error.message}`)
  } finally {
    await node.orbitdb.stop()
    await node.helia.stop()
    await node.blockstore.close()
    await node.datastore.close()
  }
}

/**
 * Demo: Restore from latest backup
 */
async function demoRestoreLatest() {
  logger.info('\n🎯 Demo 4: Restore from Latest Backup')
  logger.info('=' .repeat(60))
  
  const node = await createHeliaOrbitDB('-car-restore')
  
  try {
    logger.info('\n🔍 Searching for latest backup...')
    
    const restoreResult = await restoreFromSpaceCAR(node.orbitdb, {
      spaceName: 'my-products',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (restoreResult.success) {
      logger.info(`✅ Restored from backup: ${new Date(restoreResult.backupTimestamp).toISOString()}`)
      logger.info(`   Database: ${restoreResult.databaseAddress}`)
      logger.info(`   Entries: ${restoreResult.entriesRecovered}`)
      
      // Show restored data
      const entries = await restoreResult.database.all()
      logger.info('\n📄 Restored data:')
      entries.forEach(entry => {
        logger.info(`   ${entry._id}: ${entry.name} - $${entry.price}`)
      })
      
      await restoreResult.database.close()
    } else {
      logger.error(`❌ Restore failed: ${restoreResult.error}`)
    }
  } finally {
    await node.orbitdb.stop()
    await node.helia.stop()
    await node.blockstore.close()
    await node.datastore.close()
  }
}

/**
 * Demo: Backward compatibility - both approaches work
 */
async function demoBackwardCompatibility() {
  logger.info('\n🎯 Demo 5: Backward Compatibility')
  logger.info('=' .repeat(60))
  
  const node = await createHeliaOrbitDB('-compat')
  
  try {
    const db = await node.orbitdb.open('test-compat', { type: 'events' })
    await db.add('Test data')
    
    // Old approach: Individual block files
    logger.info('\n📤 Using legacy backup (individual blocks)...')
    const legacyResult = await backupDatabaseLegacy(node.orbitdb, db.address, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (legacyResult.success) {
      logger.info(`✅ Legacy backup: ${legacyResult.blocksUploaded} blocks uploaded`)
    }
    
    // New approach: CAR file with timestamp
    logger.info('\n📦 Using CAR backup (timestamped)...')
    const carResult = await backupDatabaseCAR(node.orbitdb, db.address, {
      spaceName: 'test-compat',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (carResult.success) {
      logger.info(`✅ CAR backup: ${carResult.blocksTotal} blocks in ${carResult.carFileSize} bytes`)
      logger.info(`   More efficient: 2 files instead of ${legacyResult.blocksUploaded}`)
    }
    
    await db.close()
  } finally {
    await node.orbitdb.stop()
    await node.helia.stop()
    await node.blockstore.close()
    await node.datastore.close()
  }
}

/**
 * Demo: Progress events for UI integration
 */
async function demoProgressEvents() {
  logger.info('\n🎯 Demo 6: Progress Events (for UI)')
  logger.info('=' .repeat(60))
  
  const node = await createHeliaOrbitDB('-progress')
  const { EventEmitter } = await import('events')
  const emitter = new EventEmitter()
  
  // Listen to progress events
  emitter.on('backupProgress', (data) => {
    logger.info(`📊 Progress: ${data.type} - ${data.status}`)
    if (data.totalBlocks) {
      logger.info(`   Blocks: ${data.totalBlocks}`)
    }
    if (data.size) {
      logger.info(`   Size: ${data.size} bytes`)
    }
  })
  
  try {
    const db = await node.orbitdb.open('progress-test', { type: 'events' })
    await db.add('Entry 1')
    await db.add('Entry 2')
    await db.add('Entry 3')
    
    logger.info('\n📦 Starting backup with progress tracking...')
    
    const result = await backupDatabaseCAR(node.orbitdb, db.address, {
      spaceName: 'progress-demo',
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      eventEmitter: emitter
    })
    
    if (result.success) {
      logger.info('\n✅ Backup completed!')
    }
    
    await db.close()
  } finally {
    await node.orbitdb.stop()
    await node.helia.stop()
    await node.blockstore.close()
    await node.datastore.close()
  }
}

// Run demos
async function main() {
  try {
    // Check for credentials
    if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
      logger.error('❌ Missing Storacha credentials in .env file')
      logger.info('   Please set STORACHA_KEY and STORACHA_PROOF')
      process.exit(1)
    }
    
    // Run demos
    await demoTimestampedBackups()
    await demoListBackups()
    await demoRestoreSpecific()
    await demoRestoreLatest()
    await demoBackwardCompatibility()
    await demoProgressEvents()
    
    logger.info('\n🎉 All demos completed!')
  } catch (error) {
    logger.error('💥 Demo failed:', error.message)
    process.exit(1)
  }
}

main()
