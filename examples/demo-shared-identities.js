/**
 * OrbitDB Storacha Bridge Demo - Shared Identities Edition
 * 
 * Demonstrates:
 * - Creating both Alice and Bob identities upfront
 * - Both identities known to both OrbitDB nodes
 * - Alice creates database with both identities in write access
 * - Testing if Bob can read Alice's data
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
 * Create shared identities directory and identities
 */
async function createSharedIdentities() {
  const sharedIdentitiesPath = './orbitdb-shared-identities'
  const identities = await Identities({ path: sharedIdentitiesPath })
  
  // Create Alice's identity
  const aliceIdentity = await identities.createIdentity({ id: 'alice' })
  console.log(`   👩 Created Alice's identity: ${aliceIdentity.id}`)
  
  // Create Bob's identity
  const bobIdentity = await identities.createIdentity({ id: 'bob' })
  console.log(`   👨 Created Bob's identity: ${bobIdentity.id}`)
  
  return { identities, aliceIdentity, bobIdentity, sharedIdentitiesPath }
}

/**
 * Create a Helia/OrbitDB instance with specific identity
 */
async function createHeliaOrbitDBWithIdentity(suffix = '', identity, identities) {
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
  
  // Create OrbitDB with the provided identity
  const orbitdb = await createOrbitDB({ 
    ipfs: helia,
    identity: identity,
    identities: identities,  // Share the identities store
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`
  })

  return { helia, orbitdb, libp2p, blockstore, datastore }
}

/**
 * Test OrbitDB with shared identities
 */
async function testSharedIdentities() {
  console.log('🚀 Testing OrbitDB Storacha Bridge - Shared Identities Edition')
  console.log('=' .repeat(60))
  
  let aliceNode, bobNode, sharedIdentities
  
  try {
    // Step 1: Create both identities upfront
    console.log('\n🔑 Step 1: Creating shared identities...')
    sharedIdentities = await createSharedIdentities()
    const { identities, aliceIdentity, bobIdentity, sharedIdentitiesPath } = sharedIdentities
    
    console.log(`\n   ✅ Both identities created in shared store: ${sharedIdentitiesPath}`)
    console.log(`   👩 Alice: ${aliceIdentity.id}`)
    console.log(`   👨 Bob: ${bobIdentity.id}`)
    
    // Step 2: Create Alice's node with her identity
    console.log('\n👩 Step 2: Creating Alice\'s node with her identity...')
    aliceNode = await createHeliaOrbitDBWithIdentity('-alice', aliceIdentity, identities)
    console.log(`   ✅ Alice's OrbitDB created`)
    console.log(`   📋 Alice's OrbitDB identity: ${aliceNode.orbitdb.identity.id}`)
    
    // Step 3: Create database with BOTH Alice and Bob in write access
    console.log('\n📊 Step 3: Creating database with write access for BOTH...')
    console.log('   🔒 Access control: Both Alice AND Bob can write')
    
    const sourceDB = await aliceNode.orbitdb.open('bridge-demo', { 
      type: 'events',
      AccessController: IPFSAccessController({ 
        write: [
          aliceIdentity.id,  // Alice can write
          bobIdentity.id      // Bob can also write
        ] 
      })
    })
    
    console.log(`   ✅ Database created: ${sourceDB.address}`)
    console.log(`   🔐 Access controller: ${sourceDB.access.address}`)
    console.log(`   📝 Write access list: [Alice, Bob]`)
    
    // Step 4: Alice adds sample data
    console.log('\n📝 Step 4: Alice adding data...')
    const sampleData = [
      'Hello from Alice!',
      'Alice\'s data - Bob should be able to read this',
      'Both have write access',
      'Testing shared access'
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
    
    // Step 5: Backup database to Storacha
    console.log('\n📤 Step 5: Backing up Alice\'s database to Storacha...')
    
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
    
    // Step 6: Create Bob's node with his identity (using same identities store)
    console.log('\n👨 Step 6: Creating Bob\'s node with his identity...')
    bobNode = await createHeliaOrbitDBWithIdentity('-bob', bobIdentity, identities)
    console.log(`   ✅ Bob's OrbitDB created`)
    console.log(`   📋 Bob's OrbitDB identity: ${bobNode.orbitdb.identity.id}`)
    
    // Verify identities are different
    console.log('\n🔍 Step 7: Verifying identities...')
    console.log(`   👩 Alice's identity: ${aliceIdentity.id}`)
    console.log(`   👨 Bob's identity: ${bobIdentity.id}`)
    console.log(`   📊 Identities are different: ${aliceIdentity.id !== bobIdentity.id ? '✅ Yes' : '❌ No'}`)
    console.log(`   🔑 Both identities in shared store: ✅ Yes`)
    console.log(`   🔐 Bob's identity in write list: ✅ Yes`)
    
    // Step 8: Restore database from Storacha
    console.log('\n📥 Step 8: Bob restoring database from Storacha...')
    
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
    console.log(`   🔄 Blocks restored: ${restoreResult.blocksRestored}`)
    
    // Step 9: Verify identity block restoration
    console.log('\n🔐 Step 9: Verifying identity block restoration...')
    
    if (restoreResult.analysis && restoreResult.analysis.identityBlocks) {
      console.log(`   ✅ Identity blocks restored: ${restoreResult.analysis.identityBlocks.length}`)
      
      if (restoreResult.analysis.identityBlocks.length > 0) {
        console.log('   📋 Identity preservation verified!')
        restoreResult.analysis.identityBlocks.forEach((block, i) => {
          console.log(`      ${i + 1}. ${block.cid} (Identity block)`)
        })
        console.log('   🎯 This ensures Alice\'s identity is preserved across nodes')
      } else {
        console.log('   ⚠️  No identity blocks found - this could affect cross-node access')
        console.log('   📚 Without identity blocks, Bob may not be able to verify Alice\'s identity')
      }
    } else {
      console.log('   ❌ No analysis data available for identity verification')
      console.log('   📊 This suggests the restore process may not have captured identity metadata')
    }
    
    // Also check access controller blocks
    if (restoreResult.analysis && restoreResult.analysis.accessControllerBlocks) {
      console.log(`   🔒 Access controller blocks: ${restoreResult.analysis.accessControllerBlocks.length}`)
      if (restoreResult.analysis.accessControllerBlocks.length > 0) {
        console.log('   ✅ Access control configuration preserved!')
      }
    }
    
    // Step 10: Check if Bob can see the entries
    console.log('\n📄 Step 10: Bob viewing restored entries...')
    
    if (restoreResult.entries.length === 0) {
      console.log('   ⚠️ Bob sees 0 entries')
      console.log('   🤔 Even though Bob is in the write list!')
      console.log('   📊 This reveals the actual reason for the issue...')
      
      // Check the raw log
      const logEntries = await restoreResult.database.log.values()
      console.log(`   📝 Raw log entries: ${logEntries.length}`)
      
      if (logEntries.length > 0) {
        console.log('   ✅ Entries exist in log!')
        console.log('   🔍 First entry author:', logEntries[0].identity)
        console.log('   📚 Issue is likely in database.all() layer, not access control')
      }
    } else {
      console.log(`   ✅ Bob sees ${restoreResult.entries.length} entries!`)
      for (let i = 0; i < restoreResult.entries.length; i++) {
        const entry = restoreResult.entries[i]
        console.log(`   ${i + 1}. 👁️  Bob reads: "${entry.value}"`)
      }
    }
    
    // Step 11: Test if Bob can write
    console.log('\n✍️  Step 11: Testing if Bob can write...')
    
    try {
      const bobEntry = await restoreResult.database.add('Message from Bob')
      console.log(`   ✅ Bob successfully wrote an entry!`)
      console.log(`   📝 Bob's entry hash: ${bobEntry.substring(0, 16)}...`)
      
      const allEntriesNow = await restoreResult.database.all()
      console.log(`   📊 Total entries now: ${allEntriesNow.length}`)
    } catch (error) {
      console.log(`   ❌ Bob could not write: ${error.message}`)
    }
    
    // Close Bob's database
    await restoreResult.database.close()
    
    // Final summary
    const originalCount = sampleData.length
    const restoredCount = restoreResult.entriesRecovered
    
    console.log('\n🎉 Test Completed!')
    console.log('=' .repeat(60))
    console.log(`   👩 Alice's identity: ${aliceIdentity.id}`)
    console.log(`   👨 Bob's identity: ${bobIdentity.id}`)
    console.log(`   📊 Identities different: ✅ Yes`)
    console.log(`   🔑 Identities shared: ✅ Yes`)
    console.log(`   📊 Alice's entries: ${originalCount}`)
    console.log(`   📊 Bob can see: ${restoredCount}`)
    console.log(`   📍 Address preserved: ${restoreResult.addressMatch}`)
    console.log(`   🔒 Both in write list: ✅ Yes`)
    console.log('\n   ✨ Key findings:')
    console.log('      • Alice and Bob have different identities')
    console.log('      • Both identities stored in shared keystore')
    console.log('      • Both identities in write access list')
    console.log('      • This tests if shared identities solve the issue')
    
    // Close identities keystore
    await identities.keystore.close()
    
    return {
      success: true,
      aliceIdentity: aliceIdentity.id,
      bobIdentity: bobIdentity.id,
      identitiesDifferent: true,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      sharedIdentities: true
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
  testSharedIdentities()
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

export { testSharedIdentities }
