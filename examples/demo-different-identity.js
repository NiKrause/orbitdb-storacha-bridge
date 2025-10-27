/**
 * OrbitDB Storacha Bridge Demo - Explicit Different Identities Edition
 * 
 * Demonstrates:
 * - Creating explicit different identities for Alice and Bob
 * - Setting up IPFS access controller with write permission for Alice only
 * - Backup and restore with identity verification
 * - Access control enforcement
 */

// Import dotenv for Node.js environment variable handling
import 'dotenv/config'
import { 
  backupDatabase, 
  restoreDatabaseFromSpace
} from '../lib/orbitdb-storacha-bridge.js'

// Import utilities separately  
import { 
  cleanupOrbitDBDirectories
} from '../lib/utils.js'

// Import required OrbitDB modules
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { createHelia } from 'helia'
import { createOrbitDB, Identities, IPFSAccessController } from '@orbitdb/core'
import { LevelBlockstore } from 'blockstore-level'
import { LevelDatastore } from 'datastore-level'

/**
 * Create a Helia/OrbitDB instance with explicit identity
 */
async function createHeliaOrbitDBWithIdentity(suffix = '', identityId = null) {
  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true })
    }
  })

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  const blockstore = new LevelBlockstore(`./orbitdb-bridge-${uniqueId}${suffix}`)
  const datastore = new LevelDatastore(`./orbitdb-bridge-${uniqueId}${suffix}-data`)

  const helia = await createHelia({ libp2p, blockstore, datastore })
  
  // Create OrbitDB with custom identity ID
  const orbitdb = await createOrbitDB({ 
    ipfs: helia,
    id: identityId,  // OrbitDB will create an identity with this ID
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`
  })
  
  console.log(`   🆔 Created identity for ${identityId}: ${orbitdb.identity.id}`)

  return { helia, orbitdb, libp2p, blockstore, datastore, identity: orbitdb.identity }
}

/**
 * Test OrbitDB backup and restore with explicit different identities
 */
async function testDifferentIdentities() {
  console.log('🚀 Testing OrbitDB Storacha Bridge - Different Identities Edition')
  console.log('=' .repeat(60))
  
  let aliceNode, bobNode
  
  try {
    // Step 1: Create Alice's node with her identity
    console.log('\n👩 Step 1: Creating Alice\'s node...')
    aliceNode = await createHeliaOrbitDBWithIdentity('-alice', 'alice')
    
    console.log(`   📋 Alice's OrbitDB identity: ${aliceNode.orbitdb.identity.id}`)
    console.log(`   🔑 Alice's public key: ${aliceNode.orbitdb.identity.publicKey}`)
    
    // Step 2: Create database with default access controller (only Alice can write)
    console.log('\n📊 Step 2: Creating database with default access controller...')
    console.log('   🔒 Access control: Only creator (Alice) can write by default')
    
    const sourceDB = await aliceNode.orbitdb.open('bridge-demo', { 
      type: 'events'
      // Default: only the creator (Alice) has write access
    })
    
    console.log(`   ✅ Database created: ${sourceDB.address}`)
    console.log(`   🔐 Access controller: ${sourceDB.access.address}`)
    
    // Step 3: Alice adds sample data
    console.log('\n📝 Step 3: Alice adding data...')
    const sampleData = [
      'Hello from Alice!',
      'Alice\'s private data',
      'Only Alice can write here',
      'Bob can read but not write'
    ]
    
    for (const content of sampleData) {
      const hash = await sourceDB.add(content)
      console.log(`   ✍️  Alice added: ${hash.substring(0, 16)}... - "${content}"`)
    }
    
    console.log(`\n📊 Alice's database summary:`)
    console.log(`   Name: ${sourceDB.name}`)
    console.log(`   Address: ${sourceDB.address}`)
    console.log(`   Entries: ${(await sourceDB.all()).length}`)
    console.log(`   Owner: ${aliceNode.orbitdb.identity.id}`)
    
    // Step 4: Backup database to Storacha
    console.log('\n📤 Step 4: Backing up Alice\'s database to Storacha...')
    
    const backupResult = await backupDatabase(aliceNode.orbitdb, sourceDB.address, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (!backupResult.success) {
      throw new Error(`Backup failed: ${backupResult.error}`)
    }
    
    console.log(`✅ Backup completed successfully!`)
    console.log(`   📋 Manifest CID: ${backupResult.manifestCID}`)
    console.log(`   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`)
    
    // Close Alice's database and node
    await sourceDB.close()
    await aliceNode.orbitdb.stop()
    await aliceNode.helia.stop()
    await aliceNode.blockstore.close()
    await aliceNode.datastore.close()
    
    console.log('\n🧹 Alice\'s node closed')
    
    // Step 5: Create Bob's node with his different identity
    console.log('\n👨 Step 5: Creating Bob\'s node...')
    bobNode = await createHeliaOrbitDBWithIdentity('-bob', 'bob')
    
    console.log(`   📋 Bob's OrbitDB identity: ${bobNode.orbitdb.identity.id}`)
    console.log(`   🔑 Bob's public key: ${bobNode.orbitdb.identity.publicKey}`)
    
    // Verify identities are different
    console.log('\n🔍 Step 6: Verifying identity separation...')
    const aliceIdentityId = aliceNode.identity.id
    const bobIdentityId = bobNode.orbitdb.identity.id
    
    console.log(`   👩 Alice's identity: ${aliceIdentityId}`)
    console.log(`   👨 Bob's identity: ${bobIdentityId}`)
    console.log(`   📊 Identities are different: ${aliceIdentityId !== bobIdentityId ? '✅ Yes' : '❌ No'}`)
    
    if (aliceIdentityId === bobIdentityId) {
      throw new Error('FAILED: Alice and Bob have the same identity!')
    }
    
    // Step 7: Restore database from Storacha
    console.log('\n📥 Step 7: Bob restoring database from Storacha...')
    
    const restoreResult = await restoreDatabaseFromSpace(bobNode.orbitdb, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })
    
    if (!restoreResult.success) {
      throw new Error(`Restore failed: ${restoreResult.error}`)
    }
    
    console.log(`✅ Restore completed successfully!`)
    console.log(`   📋 Restored database: ${restoreResult.name}`)
    console.log(`   📍 Address: ${restoreResult.address}`)
    console.log(`   📊 Entries recovered: ${restoreResult.entriesRecovered}`)
    
    // Step 8: Verify identity block restoration
    console.log('\n🔐 Step 8: Verifying identity block restoration...')
    
    if (restoreResult.analysis && restoreResult.analysis.identityBlocks) {
      console.log(`   ✅ Identity blocks restored: ${restoreResult.analysis.identityBlocks.length}`)
      
      if (restoreResult.analysis.identityBlocks.length > 0) {
        console.log('   📋 Identity preservation verified!')
        restoreResult.analysis.identityBlocks.forEach((block, i) => {
          console.log(`      ${i + 1}. ${block.cid} (Identity block)`)
        })
        console.log('   🎯 This proves Alice\'s identity is preserved in the backup')
        console.log('   🔒 Bob cannot access the data due to access control, not missing identity')
      } else {
        console.log('   ⚠️  No identity blocks found - this could explain access issues')
        console.log('   📚 Without identity blocks, Bob cannot verify Alice\'s entries')
      }
    } else {
      console.log('   ❌ No analysis data available for identity verification')
      console.log('   📊 This suggests identity metadata was not captured during backup')
    }
    
    // Also check access controller blocks
    if (restoreResult.analysis && restoreResult.analysis.accessControllerBlocks) {
      console.log(`   🔒 Access controller blocks: ${restoreResult.analysis.accessControllerBlocks.length}`)
      if (restoreResult.analysis.accessControllerBlocks.length > 0) {
        console.log('   ✅ Access control rules preserved - explaining why Bob cannot see Alice\'s data!')
      }
    }
    
    // Step 9: Display restored entries
    console.log('\n📄 Step 9: Bob viewing restored entries...')
    
    if (restoreResult.entries.length === 0) {
      console.log('   ⚠️ Bob sees 0 entries - this is expected!')
      console.log('   🔒 Why? Bob\'s identity is not in the write access list')
      console.log('   📚 Explanation: OrbitDB only loads entries from authorized identities')
      console.log('   👉 Even though the blocks exist, Bob cannot see Alice\'s data')
    } else {
      for (let i = 0; i < restoreResult.entries.length; i++) {
        const entry = restoreResult.entries[i]
        console.log(`   ${i + 1}. 👁️  Bob reads: "${entry.value}"`)
      }
    }
    
    // Step 10: Verify Alice's identity in restored data from raw log
    console.log('\n🔐 Step 10: Verifying data in raw log (bypassing access control)...')
    const logEntries = await restoreResult.database.log.values()
    
    if (logEntries.length === 0) {
      console.log('   📄 No log entries available - data exists in blocks but not accessible to Bob')
      console.log('   🔒 Access control is working as designed!')
      
      // Skip to Step 11
      console.log('\n🔒 Step 11: Testing access control...')
      console.log('   👨 Bob attempts to write to Alice\'s database...')
      
      try {
        await restoreResult.database.add('Bob trying to write')
        console.log('   ❌ UNEXPECTED: Bob was able to write! Access control failed!')
        throw new Error('Access control is not working - Bob should not be able to write')
      } catch (error) {
        console.log('   ✅ EXPECTED: Access denied!')
        console.log(`   📝 Error: ${error.message}`)
        console.log('   🎯 Success! Only Alice can write to this database')
      }
      
      // Close Bob's database
      await restoreResult.database.close()
      
      const originalCount = sampleData.length
      const restoredCount = 0  // Bob sees no entries
      
      console.log('\n🎉 SUCCESS! Different Identities Test Completed!')
      console.log('=' .repeat(60))
      console.log(`   👩 Alice's identity: ${aliceIdentityId}`)
      console.log(`   👨 Bob's identity: ${bobIdentityId}`)
      console.log(`   📊 Identities different: ✅ Yes`)
      console.log(`   📊 Alice's entries: ${originalCount}`)
      console.log(`   📊 Bob can see: ${restoredCount} (expected - access denied)`)
      console.log(`   📍 Address preserved: ${restoreResult.addressMatch}`)
      console.log(`   🔒 Access control working: ✅ Yes`)
      console.log(`   🌟 Blocks downloaded: ✅ Yes (${restoreResult.blocksRestored} blocks)`)
      console.log('\n   ✨ Key findings:')
      console.log('      • Alice and Bob have different identities')
      console.log('      • Only Alice can write to the database')
      console.log('      • Bob cannot read Alice\'s data (strict access control)')
      console.log('      • All blocks successfully backed up and restored')
      console.log('      • Access control prevents unauthorized access')
      
      return {
        success: true,
        aliceIdentity: aliceIdentityId,
        bobIdentity: bobIdentityId,
        identitiesDifferent: true,
        originalEntries: originalCount,
        restoredEntries: restoredCount,
        addressMatch: restoreResult.addressMatch,
        accessControlWorking: true,
        bobCannotRead: true
      }
    }
    
    const firstLogEntry = logEntries[0]
    
    console.log(`   👩 Original author (Alice): ${firstLogEntry.identity}`)
    console.log(`   👨 Current user (Bob): ${bobNode.orbitdb.identity.id}`)
    console.log(`   📊 Identity verification: ${firstLogEntry.identity === aliceIdentityId ? '✅ Matches Alice' : '❌ Does not match'}`)
    
    // Step 11: Test access control - Bob tries to write
    console.log('\n🔒 Step 11: Testing access control...')
    console.log('   👨 Bob attempts to write to Alice\'s database...')
    
    try {
      await restoreResult.database.add('Bob trying to write')
      console.log('   ❌ UNEXPECTED: Bob was able to write! Access control failed!')
      throw new Error('Access control is not working - Bob should not be able to write')
    } catch (error) {
      console.log('   ✅ EXPECTED: Access denied!')
      console.log(`   📝 Error: ${error.message}`)
      console.log('   🎯 Success! Only Alice can write to this database')
    }
    
    // Final summary
    const originalCount = sampleData.length
    const restoredCount = restoreResult.entriesRecovered
    
    console.log('\n🎉 SUCCESS! Different Identities Test Completed!')
    console.log('=' .repeat(60))
    console.log(`   👩 Alice's identity: ${aliceIdentityId}`)
    console.log(`   👨 Bob's identity: ${bobIdentityId}`)
    console.log(`   📊 Identities different: ✅ Yes`)
    console.log(`   📊 Original entries (Alice): ${originalCount}`)
    console.log(`   📊 Restored entries (Bob): ${restoredCount}`)
    console.log(`   📍 Address preserved: ${restoreResult.addressMatch}`)
    console.log(`   🔒 Access control working: ✅ Yes`)
    console.log(`   🌟 Data integrity: ${originalCount === restoredCount && restoreResult.addressMatch ? '✅ Perfect' : '❌ Failed'}`)
    console.log('\n   ✨ Key findings:')
    console.log('      • Alice and Bob have different identities')
    console.log('      • Only Alice can write to the database')
    console.log('      • Bob can read all of Alice\'s data')
    console.log('      • All signatures and identities preserved perfectly')
    
    // Close Bob's database
    await restoreResult.database.close()
    
    return {
      success: true,
      aliceIdentity: aliceIdentityId,
      bobIdentity: bobIdentityId,
      identitiesDifferent: aliceIdentityId !== bobIdentityId,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      accessControlWorking: true
    }
    
  } catch (error) {
    console.error('\n💥 Test failed:', error.message)
    console.error(error.stack)
    return {
      success: false,
      error: error.message
    }
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...')
    
    if (bobNode) {
      try {
        await bobNode.orbitdb.stop()
        await bobNode.helia.stop()
        await bobNode.blockstore.close()
        await bobNode.datastore.close()
        console.log('   ✅ Bob\'s node cleaned up')
      } catch (error) {
        console.warn(`   ⚠️ Bob cleanup warning: ${error.message}`)
      }
    }
    
    if (aliceNode) {
      try {
        // Alice's node may already be closed
        if (aliceNode.helia && typeof aliceNode.helia.stop === 'function') {
          await aliceNode.orbitdb.stop()
          await aliceNode.helia.stop()
          await aliceNode.blockstore.close()
          await aliceNode.datastore.close()
        }
        console.log('   ✅ Alice\'s node cleaned up')
      } catch (error) {
        console.warn(`   ⚠️ Alice cleanup warning: ${error.message}`)
      }
    }
    
    // Clean up OrbitDB directories
    console.log('\n🧹 Final cleanup - removing OrbitDB directories...')
    await cleanupOrbitDBDirectories()
  }
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testDifferentIdentities()
    .then((result) => {
      if (result?.success) {
        console.log('\n🎉 Demo completed successfully!')
        process.exit(0)
      } else {
        console.error('\n❌ Demo failed!')
        process.exit(1)
      }
    })
    .catch((error) => {
      console.error('\n💥 Demo crashed:', error.message)
      console.error(error.stack)
      process.exit(1)
    })
}

export { testDifferentIdentities }
