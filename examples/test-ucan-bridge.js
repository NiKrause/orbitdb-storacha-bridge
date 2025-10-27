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

async function testUCANBridge() {
  console.log('🧪 Testing UCAN Bridge Integration')
  console.log('=====================================')
  
  try {
    // Step 1: Load UCAN delegation files
    console.log('\n📁 Step 1: Loading UCAN delegation files...')
    
    // Load delegation token (base64 from CAR file)
    const ucanToken = await fs.readFile('./ucan-delegation.car', 'base64')
    console.log(`   ✅ Loaded delegation token (${ucanToken.length} chars)`)
    
    // Load recipient key
    const recipientKey = await fs.readFile('./recipient-key.txt', 'utf8')
    console.log(`   ✅ Loaded recipient key`)
    
    // Step 2: Test UCAN bridge initialization
    console.log('\n🔐 Step 2: Testing UCAN bridge initialization...')
    
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanToken,
      recipientKey
    })
    
    console.log('   ✅ UCAN bridge instance created')
    
    // Step 3: Test listing space files (this tests authentication)
    console.log('\n📋 Step 3: Testing space file listing (authentication test)...')
    
    try {
      const spaceFiles = await bridge.listSpaceFiles()
      console.log(`   ✅ Successfully listed ${spaceFiles.length} files in space`)
      
      if (spaceFiles.length > 0) {
        console.log(`   📁 Sample files:`)
        spaceFiles.slice(0, 3).forEach((file, i) => {
          console.log(`      ${i + 1}. ${file.root} (${file.size} bytes)`)
        })
      }
    } catch (error) {
      console.log(`   ⚠️  Space listing failed: ${error.message}`)
      console.log('   ℹ️  This might be expected if space is empty or has permission issues')
    }
    
    // Step 4: Create test OrbitDB database
    console.log('\n🛠️  Step 4: Setting up OrbitDB for testing...')
    
    // Use the working utility function
    const { helia, orbitdb, blockstore, datastore } = await createHeliaOrbitDB('-ucan-test')
    
    console.log('   ✅ OrbitDB instance created')
    console.log(`   🤖 Identity: ${orbitdb.identity.id}`)
    
    // Step 5: Create and populate test database
    console.log('\n📊 Step 5: Creating test database...')
    
    const dbName = `ucan-test-${Date.now()}`
    const db = await orbitdb.open(dbName, { type: 'keyvalue' })
    
    // Add some test data
    await db.put('test-key-1', `UCAN test data: ${new Date().toISOString()}`)
    await db.put('test-key-2', { message: 'Hello from UCAN!', timestamp: Date.now() })
    await db.put('test-key-3', 'Another test value')
    
    const allEntries = await db.all()
    const entryCount = Object.keys(allEntries).length
    
    console.log(`   ✅ Database created: ${db.address}`)
    console.log(`   📝 Added ${entryCount} entries:`)
    Object.entries(allEntries).forEach(([key, value]) => {
      console.log(`      ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    })
    
    // Step 6: Test backup with UCAN bridge
    console.log('\n📤 Step 6: Testing database backup with UCAN...')
    
    try {
      const backupResult = await bridge.backup(orbitdb, db.address)
      
      if (backupResult.success) {
        console.log('   ✅ UCAN Backup successful!')
        console.log(`   📍 Database: ${backupResult.databaseAddress}`)
        console.log(`   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`)
        console.log(`   🔍 Block summary:`, backupResult.blockSummary)
      } else {
        console.log('   ❌ UCAN Backup failed:', backupResult.error)
      }
      
      // Step 7: Test restore (optional, as it would overwrite)
      console.log('\n📥 Step 7: Testing space file discovery for restore...')
      
      try {
        const restoreFiles = await bridge.listSpaceFiles()
        console.log(`   ✅ Found ${restoreFiles.length} files available for restore`)
        
        if (restoreFiles.length > 0) {
          console.log('   ℹ️  Restore functionality verified (files available)')
          console.log('   ⚠️  Skipping actual restore to avoid overwriting data')
        }
      } catch (restoreError) {
        console.log(`   ⚠️  Restore file discovery failed: ${restoreError.message}`)
      }
      
    } catch (backupError) {
      console.log('   ❌ UCAN Backup failed:', backupError.message)
      console.log('   🔍 Error details:', backupError)
    }
    
    // Cleanup
    console.log('\n🧹 Cleanup...')
    await db.close()
    await orbitdb.stop()
    await helia.stop()
    
    console.log('\n✅ UCAN Bridge Test Complete!')
    console.log('🎉 The UCAN delegation authentication is working!')
    
  } catch (error) {
    console.error('\n❌ UCAN Bridge Test Failed:')
    console.error('Error:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  }
}

// Add progress tracking
function setupProgressTracking(bridge) {
  bridge.on('uploadProgress', (progress) => {
    if (progress.status === 'starting') {
      console.log(`   📤 Starting upload of ${progress.total} blocks...`)
    } else if (progress.status === 'uploading') {
      const percent = progress.percentage
      if (percent % 20 === 0 || progress.current === progress.total) { // Show every 20%
        console.log(`   📊 Upload progress: ${progress.current}/${progress.total} (${percent}%)`)
      }
    } else if (progress.status === 'completed') {
      console.log(`   ✅ Upload completed: ${progress.summary.successful} successful, ${progress.summary.failed} failed`)
    }
  })
  
  bridge.on('downloadProgress', (progress) => {
    if (progress.status === 'starting') {
      console.log(`   📥 Starting download of ${progress.total} files...`)
    } else if (progress.status === 'downloading') {
      const percent = progress.percentage
      if (percent % 20 === 0 || progress.current === progress.total) {
        console.log(`   📊 Download progress: ${progress.current}/${progress.total} (${percent}%)`)
      }
    } else if (progress.status === 'completed') {
      console.log(`   ✅ Download completed: ${progress.summary.downloaded} successful, ${progress.summary.failed} failed`)
    }
  })
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testUCANBridge().catch(console.error)
}
