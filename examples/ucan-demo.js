/**
 * OrbitDB Storacha Bridge UCAN Demo
 * 
 * Demonstrates complete OrbitDB database backup and restoration via Storacha/Filecoin
 * using UCAN-based authentication instead of traditional key/proof credentials.
 */

import 'dotenv/config'
import { 
  backupDatabaseWithUCAN, 
  restoreDatabaseFromSpaceWithUCAN,
  OrbitDBStorachaBridgeUCAN
} from '../lib/ucan-bridge.js'
import { logger } from '../lib/logger.js'

// Import utilities
import { 
  createHeliaOrbitDB,
  cleanupOrbitDBDirectories
} from '../lib/utils.js'

/**
 * Test complete OrbitDB backup and restore workflow using UCAN
 */
async function testOrbitDBStorachaBridgeUCAN() {
  logger.info('🚀 Testing OrbitDB Storacha Bridge with UCAN Authentication')
  logger.info('=' .repeat(70))
  
  let sourceNode, targetNode
  
  try {
    // Step 1: Create source database with sample data
    logger.info('\\n📡 Step 1: Creating source database...')
    sourceNode = await createHeliaOrbitDB('-ucan-source')
    
    const sourceDB = await sourceNode.orbitdb.open('ucan-bridge-demo', { type: 'events' })
    
    // Add sample data
    const sampleData = [
      'Hello from OrbitDB with UCAN!',
      'This data will survive UCAN backup and restore',
      'Perfect hash preservation with UCAN test',
      'UCAN-based identity recovery demonstration',
      'Decentralized authorization without API keys!'
    ]
    
    for (const content of sampleData) {
      const hash = await sourceDB.add(content)
      logger.info(`   📝 Added: ${hash.substring(0, 16)}... - "${content}"`)
    }
    
    logger.info(`\\n📊 Source database created:`)
    logger.info(`   Name: ${sourceDB.name}`)
    logger.info(`   Address: ${sourceDB.address}`)
    logger.info(`   Entries: ${(await sourceDB.all()).length}`)
    
    // Step 2: Backup database to Storacha using UCAN
    logger.info('\\n📤 Step 2: Backing up database to Storacha with UCAN...')
    
    const backupOptions = {
      // UCAN authentication options
      ucanFile: process.env.STORACHA_UCAN_FILE,
      ucanToken: process.env.STORACHA_UCAN_TOKEN,
      agentDID: process.env.STORACHA_AGENT_DID,
      spaceDID: process.env.STORACHA_SPACE_DID,
    }
    
    const backupResult = await backupDatabaseWithUCAN(
      sourceNode.orbitdb, 
      sourceDB.address, 
      backupOptions
    )
    
    if (!backupResult.success) {
      throw new Error(`UCAN Backup failed: ${backupResult.error}`)
    }
    
    logger.info(`✅ UCAN Backup completed successfully!`)
    logger.info(`   📋 Manifest CID: ${backupResult.manifestCID}`)
    logger.info(`   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`)
    logger.info(`   📦 Block types:`, backupResult.blockSummary)
    
    // Close source database
    await sourceDB.close()
    await sourceNode.orbitdb.stop()
    await sourceNode.helia.stop()
    await sourceNode.blockstore.close()
    await sourceNode.datastore.close()
    
    logger.info('\\n🧹 Source database closed and cleaned up')
    
    // Step 3: Create target node and restore from space using UCAN
    logger.info('\\n🔄 Step 3: Creating target node...')
    targetNode = await createHeliaOrbitDB('-ucan-target')
    
    logger.info('\\n📥 Step 4: Restoring database from Storacha space with UCAN...')
    
    const restoreOptions = {
      // UCAN authentication options
      ucanFile: process.env.STORACHA_UCAN_FILE,
      ucanToken: process.env.STORACHA_UCAN_TOKEN,
      agentDID: process.env.STORACHA_AGENT_DID,
      spaceDID: process.env.STORACHA_SPACE_DID,
    }
    
    const restoreResult = await restoreDatabaseFromSpaceWithUCAN(
      targetNode.orbitdb, 
      restoreOptions
    )
    
    if (!restoreResult.success) {
      throw new Error(`UCAN Restore failed: ${restoreResult.error}`)
    }
    
    logger.info(`✅ UCAN Restore completed successfully!`)
    logger.info(`   📋 Restored database: ${restoreResult.name}`)
    logger.info(`   📍 Address: ${restoreResult.address}`)
    logger.info(`   📊 Entries recovered: ${restoreResult.entriesRecovered}`)
    logger.info(`   🔄 Blocks restored: ${restoreResult.blocksRestored}`)
    logger.info(`   🎯 Address match: ${restoreResult.addressMatch}`)
    
    // Display restored entries
    logger.info('\\n📄 Restored entries:')
    for (let i = 0; i < restoreResult.entries.length; i++) {
      const entry = restoreResult.entries[i]
      logger.info(`   ${i + 1}. ${entry.hash.substring(0, 16)}... - "${entry.value}"`)
    }
    
    const originalCount = sampleData.length
    const restoredCount = restoreResult.entriesRecovered
    
    logger.info('\\n🎉 SUCCESS! OrbitDB Storacha Bridge UCAN test completed!')
    logger.info(`   📊 Original entries: ${originalCount}`)
    logger.info(`   📊 Restored entries: ${restoredCount}`)
    logger.info(`   📋 Manifest CID: ${restoreResult.manifestCID}`)
    logger.info(`   📍 Address preserved: ${restoreResult.addressMatch}`)
    logger.info(`   🌟 100% data integrity: ${originalCount === restoredCount && restoreResult.addressMatch}`)
    logger.info(`   🔐 UCAN Authentication: ✅ SUCCESS`)
    
    return {
      success: true,
      manifestCID: restoreResult.manifestCID,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      blocksUploaded: backupResult.blocksUploaded,
      blocksRestored: restoreResult.blocksRestored,
      authMethod: 'UCAN'
    }
    
  } catch (error) {
    logger.error('\\n💥 UCAN Test failed:', error.message)
    return {
      success: false,
      error: error.message
    }
  } finally {
    // Cleanup
    logger.info('\\n🧹 Cleaning up...')
    
    if (targetNode) {
      try {
        await targetNode.orbitdb.stop()
        await targetNode.helia.stop()
        await targetNode.blockstore.close()
        await targetNode.datastore.close()
        logger.info('   ✅ Target node cleaned up')
      } catch (error) {
        logger.warn(`   ⚠️ Target cleanup warning: ${error.message}`)
      }
    }
    
    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop()
        await sourceNode.helia.stop()
        await sourceNode.blockstore.close()
        await sourceNode.datastore.close()
        logger.info('   ✅ Source node cleaned up')
      } catch (error) {
        logger.warn(`   ⚠️ Source cleanup warning: ${error.message}`)
      }
    }
    
    // Clean up OrbitDB directories
    logger.info('\\n🧹 Final cleanup - removing OrbitDB directories...')
    await cleanupOrbitDBDirectories()
  }
}

/**
 * Test UCAN Bridge Class Interface
 */
async function testUCANBridgeClass() {
  logger.info('\\n🔧 Testing UCAN Bridge Class Interface')
  logger.info('=' .repeat(50))
  
  let sourceNode, targetNode
  
  try {
    // Initialize UCAN Bridge
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanFile: process.env.STORACHA_UCAN_FILE,
      ucanToken: process.env.STORACHA_UCAN_TOKEN,
      agentDID: process.env.STORACHA_AGENT_DID,
      spaceDID: process.env.STORACHA_SPACE_DID,
    })
    
    // Listen for progress events
    bridge.on('uploadProgress', (progress) => {
      logger.info(`   📤 Upload Progress: ${progress.percentage}% (${progress.current}/${progress.total})`)
    })
    
    bridge.on('downloadProgress', (progress) => {
      logger.info(`   📥 Download Progress: ${progress.percentage}% (${progress.current}/${progress.total})`)
    })
    
    // Create source database
    sourceNode = await createHeliaOrbitDB('-ucan-class-source')
    const sourceDB = await sourceNode.orbitdb.open('ucan-class-demo', { type: 'keyvalue' })
    
    await sourceDB.set('greeting', 'Hello UCAN World!')
    await sourceDB.set('framework', 'OrbitDB with Storacha')
    await sourceDB.set('auth', 'UCAN-based authentication')
    
    logger.info(`📊 Source database: ${sourceDB.address}`)
    
    // Backup using class interface
    logger.info('\\n📤 Backing up with UCAN Bridge class...')
    const backupResult = await bridge.backup(sourceNode.orbitdb, sourceDB.address)
    
    if (!backupResult.success) {
      throw new Error(`Class backup failed: ${backupResult.error}`)
    }
    
    logger.info(`✅ Class backup successful: ${backupResult.blocksUploaded} blocks`)
    
    // Close source
    await sourceDB.close()
    await sourceNode.orbitdb.stop()
    await sourceNode.helia.stop()
    await sourceNode.blockstore.close()
    await sourceNode.datastore.close()
    
    // Create target and restore
    targetNode = await createHeliaOrbitDB('-ucan-class-target')
    
    logger.info('\\n📥 Restoring with UCAN Bridge class...')
    const restoreResult = await bridge.restoreFromSpace(targetNode.orbitdb)
    
    if (!restoreResult.success) {
      throw new Error(`Class restore failed: ${restoreResult.error}`)
    }
    
    logger.info(`✅ Class restore successful: ${restoreResult.entriesRecovered} entries`)
    logger.info(`   📍 Restored to: ${restoreResult.address}`)
    
    return {
      success: true,
      method: 'class-interface',
      entries: restoreResult.entriesRecovered
    }
    
  } catch (error) {
    logger.error('❌ Class test failed:', error.message)
    return {
      success: false,
      error: error.message
    }
  } finally {
    // Cleanup nodes
    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop()
        await sourceNode.helia.stop()
        await sourceNode.blockstore.close()
        await sourceNode.datastore.close()
      } catch (error) {
        logger.warn(`Source cleanup warning: ${error.message}`)
      }
    }
    
    if (targetNode) {
      try {
        await targetNode.orbitdb.stop()
        await targetNode.helia.stop()
        await targetNode.blockstore.close()
        await targetNode.datastore.close()
      } catch (error) {
        logger.warn(`Target cleanup warning: ${error.message}`)
      }
    }
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info('🔐 OrbitDB Storacha Bridge - UCAN Authentication Demo')
  logger.info('=' .repeat(70))
  
  // Check for UCAN credentials
  const hasUCANFile = !!process.env.STORACHA_UCAN_FILE
  const hasUCANToken = !!process.env.STORACHA_UCAN_TOKEN
  
  if (!hasUCANFile && !hasUCANToken) {
    logger.error('❌ Missing UCAN credentials!')
    logger.error('   Set either STORACHA_UCAN_FILE or STORACHA_UCAN_TOKEN in your .env file')
    logger.error('   See docs/UCAN_SETUP.md for instructions')
    process.exit(1)
  }
  
  logger.info('🔐 UCAN Configuration:')
  logger.info(`   📁 UCAN File: ${hasUCANFile ? '✅' : '❌'}`)
  logger.info(`   🎫 UCAN Token: ${hasUCANToken ? '✅' : '❌'}`)
  logger.info(`   🤖 Agent DID: ${process.env.STORACHA_AGENT_DID || 'auto-detect'}`)
  logger.info(`   🚀 Space DID: ${process.env.STORACHA_SPACE_DID || 'auto-detect'}`)
  
  // Run both tests
  Promise.resolve()
    .then(async () => {
      const functionResult = await testOrbitDBStorachaBridgeUCAN()
      const classResult = await testUCANBridgeClass()
      
      logger.info('\\n🏁 Final Results:')
      logger.info(`   Function Interface: ${functionResult.success ? '✅' : '❌'}`)
      logger.info(`   Class Interface: ${classResult.success ? '✅' : '❌'}`)
      
      const overallSuccess = functionResult.success && classResult.success
      
      if (overallSuccess) {
        logger.info('\\n🎉 UCAN Demo completed successfully!')
        process.exit(0)
      } else {
        logger.error('\\n❌ UCAN Demo failed!')
        process.exit(1)
      }
    })
    .catch((error) => {
      logger.error('\\n💥 UCAN Demo crashed:', error.message)
      process.exit(1)
    })
}

export { testOrbitDBStorachaBridgeUCAN, testUCANBridgeClass }
