/**
 * OrbitDB Storacha Bridge - Restore Demo
 * 
 * Demonstrates how to restore an OrbitDB database from Storacha backup
 * using the mapping-independent restore function
 * 
 * Prerequisites: Run backup-demo.js first to create a backup
 */

import 'dotenv/config'
import { restoreDatabaseFromSpace } from '../lib/orbitdb-storacha-bridge.js'

// Import utilities separately
import { createHeliaOrbitDB } from '../lib/utils.js'
import { logger } from '../lib/logger.js'

async function runRestoreDemo() {
  logger.info('🔄 OrbitDB Storacha Bridge - Restore Demo')
  logger.info('=' .repeat(50))
  
  // Check for required environment variables
  if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
    logger.error('❌ Missing Storacha credentials!')
    logger.error('   Please set STORACHA_KEY and STORACHA_PROOF in your .env file')
    logger.info('\n💡 Example .env file:')
    logger.info('   STORACHA_KEY=your_private_key')
    logger.info('   STORACHA_PROOF=your_delegation_proof')
    process.exit(1)
  }
  
  let targetNode
  
  try {
    // Step 1: Create target OrbitDB instance
    logger.info('\n📡 Creating target OrbitDB instance...')
    targetNode = await createHeliaOrbitDB('-restore-demo')
    
    logger.info(`\n📋 Restore parameters:`)
    logger.info(`   Using credentials from .env file`)
    logger.info(`   Will discover all files in Storacha space automatically`)
    
    // Step 2: Restore from Storacha using space discovery
    logger.info('\n💾 Starting restore from Storacha space...')
    const restoreResult = await restoreDatabaseFromSpace(
      targetNode.orbitdb, 
      { 
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
        timeout: 60000,
      }
    )
    
    if (restoreResult.success) {
      logger.info('\n🎉 Restore completed successfully!')
      logger.info(`📋 Database Address: ${restoreResult.database.address}`)
      logger.info(`📊 Entries recovered: ${restoreResult.entriesRecovered}`)
      logger.info(`📊 Blocks restored: ${restoreResult.blocksRestored}`)
      logger.info(`🔗 Address match: ${restoreResult.addressMatch ? '✅ Perfect' : '❌ Different'}`)
      logger.info(`📈 Block breakdown:`)
      for (const [type, count] of Object.entries(restoreResult.blockSummary || {})) {
        logger.info(`   ${type}: ${count} blocks`)
      }
      
      // Step 3: Verify restored database
      logger.info('\n🔍 Verifying restored database...')
      
      try {
        const restoredDB = await targetNode.orbitdb.open(restoreResult.database.address)
        const allEntries = await restoredDB.all()
        
        logger.info(`\n📊 Database verification:`)
        logger.info(`   Name: ${restoredDB.name}`)
        logger.info(`   Type: ${restoredDB.type}`)
        logger.info(`   Address: ${restoredDB.address}`)
        logger.info(`   Total entries: ${allEntries.length}`)
        
        if (allEntries.length > 0) {
          logger.info(`\n📄 Sample entries:`)
          for (const [index, entry] of allEntries.slice(0, 3).entries()) {
            logger.info(`   ${index + 1}. ${entry.hash} - "${entry.value}"`)
          }
          
          if (allEntries.length > 3) {
            logger.info(`   ... and ${allEntries.length - 3} more entries`)
          }
        } else {
          logger.info(`   ⚠️  No entries found - database might be empty or restore incomplete`)
        }
        
        // Step 4: Test database operations
        logger.info('\n🧪 Testing database operations...')
        
        if (restoredDB.type === 'events') {
          const testEntry = `Test entry added after restore - ${new Date().toISOString()}`
          const hash = await restoredDB.add(testEntry)
          logger.info(`   ✅ Added test entry: ${hash}`)
          
          const updatedEntries = await restoredDB.all()
          logger.info(`   ✅ Total entries after test: ${updatedEntries.length}`)
        } else {
          logger.info(`   ℹ️  Database type '${restoredDB.type}' - skipping write test`)
        }
        
      } catch (error) {
        logger.error('   ❌ Database verification failed:', error.message)
      }
      
    } else {
      logger.error('\n❌ Restore failed:', restoreResult.error)
      
      if (restoreResult.error?.includes('not found') || restoreResult.error?.includes('404')) {
        logger.info('\n💡 Troubleshooting tips:')
        logger.info('   • Make sure you have backed up a database to your Storacha space')
        logger.info('   • Try running backup-demo.js first to create a fresh backup')
        logger.info('   • Verify your Storacha credentials are correct')
        logger.info('   • Check that your Storacha space contains OrbitDB backup files')
      }
      
      process.exit(1)
    }
    
  } catch (error) {
    logger.error('\n💥 Demo failed:', error.message)
    logger.error(error.stack)
    
    if (error.message.includes('credentials') || error.message.includes('auth')) {
      logger.info('\n💡 Make sure your .env file contains valid Storacha credentials:')
      logger.info('   STORACHA_KEY=your_private_key')
      logger.info('   STORACHA_PROOF=your_delegation_proof')
    }
    
    process.exit(1)
    
  } finally {
    // Cleanup
    if (targetNode) {
      try {
        await targetNode.orbitdb.stop()
        await targetNode.helia.stop()
        await targetNode.blockstore.close()
        await targetNode.datastore.close()
        logger.info('\n🧹 Cleanup completed')
      } catch (error) {
        logger.warn('⚠️ Cleanup warning:', error.message)
      }
    }
  }
}

// Show usage information
function showUsage() {
  logger.info('\n📚 OrbitDB Storacha Bridge - Restore Demo')
  logger.info('\nThis demo shows how to restore an OrbitDB database from a Storacha backup.')
  logger.info('\nUsage:')
  logger.info('  node restore-demo.js')
  logger.info('\nPrerequisites:')
  logger.info('  1. Set up your .env file with Storacha credentials:')
  logger.info('     STORACHA_KEY=your_private_key')
  logger.info('     STORACHA_PROOF=your_delegation_proof')
  logger.info('  2. Run backup-demo.js first to create a backup in your space')
  logger.info('\nWhat this demo does:')
  logger.info('  • Creates a fresh OrbitDB instance')
  logger.info('  • Automatically discovers all backup files in your Storacha space')
  logger.info('  • Downloads and reconstructs the database with perfect hash preservation')
  logger.info('  • Verifies data integrity and database functionality')
  logger.info('  • Tests basic database operations on restored data')
  logger.info('\nNo CID parameters needed - this uses mapping-independent restore!')
}

// Handle help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showUsage()
  process.exit(0)
}

// Run demo
runRestoreDemo()
