/**
 * OrbitDB Storacha Bridge - Simple Todo Restore Demo
 * 
 * Demonstrates how to restore a simple-todo OrbitDB database from Storacha backup
 * connecting to specific relay nodes for peer-to-peer functionality
 * 
 * This demo is customized to work with the simple-todo project structure
 */

import 'dotenv/config'
import { restoreDatabaseFromSpace } from '../lib/orbitdb-storacha-bridge.js'

// Import utilities for creating OrbitDB/Helia instances
import { createHeliaOrbitDB } from '../lib/utils.js'
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { createHelia } from 'helia'
import { createOrbitDB } from '@orbitdb/core'
import { LevelBlockstore } from 'blockstore-level'
import { LevelDatastore } from 'datastore-level'
import * as filters from '@libp2p/websockets/filters'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { bootstrap } from '@libp2p/bootstrap'

// Relay nodes from simple-todo project
const RELAY_BOOTSTRAP_ADDRESSES = [
  '/dns4/159-69-119-82.k51qzi5uqu5dmesgnxu1wjx2r2rk797fre6yxj284fqhcn2dekq3mar5sz63jx.libp2p.direct/tcp/4002/wss/p2p/12D3KooWSdmKqDDpRftU2ayyGH66svXd3P6zuyH7cMyFV1iXRR4p',
  '/dns6/2a01-4f8-c012-3e86--1.k51qzi5uqu5dmesgnxu1wjx2r2rk797fre6yxj284fqhcn2dekq3mar5sz63jx.libp2p.direct/tcp/4002/wss/p2p/12D3KooWSdmKqDDpRftU2ayyGH66svXd3P6zuyH7cMyFV1iXRR4p'
]

/**
 * Create a Helia/OrbitDB instance configured to connect to simple-todo relay nodes
 */
async function createSimpleTodoOrbitDB(suffix = '') {
  console.log('📡 Creating libp2p node with simple-todo relay configuration...')
  
  const libp2p = await createLibp2p({
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/0', 
        '/ip4/127.0.0.1/tcp/0/ws'
      ]
    },
    transports: [
      tcp(),
      webSockets({
        filter: filters.all
      }),
      circuitRelayTransport({
        discoverRelays: 2
      })
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: RELAY_BOOTSTRAP_ADDRESSES
      })
    ],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true
      })
    }
  })

  console.log('🔧 Setting up Helia with persistent storage...')
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  const blockstore = new LevelBlockstore(
    `./orbitdb-bridge-${uniqueId}${suffix}`
  )
  const datastore = new LevelDatastore(
    `./orbitdb-bridge-${uniqueId}${suffix}-data`
  )

  const helia = await createHelia({ libp2p, blockstore, datastore })
  
  console.log('🛸 Creating OrbitDB instance...')
  const orbitdb = await createOrbitDB({ 
    ipfs: helia,
    id: 'simple-todo-restore-demo'
  })

  console.log(`✅ Created OrbitDB instance with peer ID: ${libp2p.peerId.toString()}`)
  
  return { helia, orbitdb, libp2p, blockstore, datastore }
}

async function runSimpleTodoRestoreDemo() {
  console.log('🔄 Simple Todo OrbitDB Storacha Bridge - Restore Demo')
  console.log('=' .repeat(60))
  
  // Check for required environment variables
  if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
    console.error('❌ Missing Storacha credentials!')
    console.error('   Please set STORACHA_KEY and STORACHA_PROOF in your .env file')
    console.log('\n💡 Example .env file:')
    console.log('   STORACHA_KEY=your_private_key')
    console.log('   STORACHA_PROOF=your_delegation_proof')
    process.exit(1)
  }
  
  console.log('📋 Using relay nodes:')
  RELAY_BOOTSTRAP_ADDRESSES.forEach((addr, i) => {
    console.log(`   ${i + 1}. ${addr}`)
  })
  
  let targetNode
  
  try {
    // Step 1: Create target OrbitDB instance connected to simple-todo relays
    console.log('\n📡 Creating target OrbitDB instance connected to simple-todo relays...')
    targetNode = await createSimpleTodoOrbitDB('-simple-todo-restore')
    
    console.log('\n📋 Restore parameters:')
    console.log('   Using credentials from .env file')
    console.log('   Database type: keyvalue (simple-todo format)')
    console.log('   Expected database name: simple-todos')
    console.log('   Will discover all files in Storacha space automatically')
    
    // Give some time for relay connections to establish
    console.log('\n⏳ Waiting for relay connections to establish...')
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    // Check connections
    const connections = targetNode.libp2p.getConnections()
    console.log(`🔗 Current connections: ${connections.length}`)
    connections.forEach((conn, i) => {
      console.log(`   ${i + 1}. ${conn.remoteAddr.toString()}`)
    })
    
    // Step 2: Restore from Storacha using space discovery
    console.log('\n💾 Starting restore from Storacha space...')
    const restoreResult = await restoreDatabaseFromSpace(
      targetNode.orbitdb, 
      { 
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
        timeout: 120000, // 2 minutes timeout
      }
    )
    
    if (restoreResult.success) {
      console.log('\n🎉 Restore completed successfully!')
      console.log(`📋 Database Name: ${restoreResult.database.name}`)
      console.log(`📋 Database Address: ${restoreResult.database.address}`)
      console.log(`📊 Entries recovered: ${restoreResult.entriesRecovered}`)
      console.log(`📊 Blocks restored: ${restoreResult.blocksRestored}`)
      console.log(`🔗 Address match: ${restoreResult.addressMatch ? '✅ Perfect' : '❌ Different'}`)
      
      if (restoreResult.blockSummary) {
        console.log('📈 Block breakdown:')
        for (const [type, count] of Object.entries(restoreResult.blockSummary)) {
          console.log(`   ${type}: ${count} blocks`)
        }
      }
      
      // Step 3: Verify restored database with simple-todo structure
      console.log('\n🔍 Verifying restored simple-todo database...')
      
      try {
        const restoredDB = await targetNode.orbitdb.open(restoreResult.database.address)
        const allEntries = await restoredDB.all()
        
        console.log('\n📊 Database verification:')
        console.log(`   Name: ${restoredDB.name}`)
        console.log(`   Type: ${restoredDB.type}`)
        console.log(`   Address: ${restoredDB.address}`)
        console.log(`   Total entries: ${allEntries.length}`)
        
        if (allEntries.length > 0) {
          console.log('\n📄 Sample todo entries:')
          for (const [index, entry] of allEntries.slice(0, 3).entries()) {
            const todo = entry.value || entry
            console.log(`   ${index + 1}. [${entry.hash.slice(0, 8)}...] "${todo.text || 'No text'}"`)
            if (todo.completed !== undefined) {
              console.log(`      Status: ${todo.completed ? '✅ Completed' : '⏳ Pending'}`)
            }
            if (todo.createdAt) {
              console.log(`      Created: ${new Date(todo.createdAt).toLocaleString()}`)
            }
            if (todo.createdBy) {
              console.log(`      Created by: ${todo.createdBy.slice(0, 12)}...`)
            }
          }
          
          if (allEntries.length > 3) {
            console.log(`   ... and ${allEntries.length - 3} more todos`)
          }
          
          // Count completed vs pending
          const completed = allEntries.filter(entry => {
            const todo = entry.value || entry
            return todo.completed === true
          }).length
          const pending = allEntries.length - completed
          
          console.log('\n📈 Todo statistics:')
          console.log(`   ✅ Completed: ${completed}`)
          console.log(`   ⏳ Pending: ${pending}`)
          console.log(`   📊 Total: ${allEntries.length}`)
          
        } else {
          console.log('   ⚠️  No todos found - database might be empty or restore incomplete')
        }
        
        // Step 4: Test simple database operations (if it's a keyvalue store)
        console.log('\n🧪 Testing simple-todo database operations...')
        
        if (restoredDB.type === 'keyvalue') {
          const testTodoId = `test_todo_${Date.now()}`
          const testTodo = {
            text: `Test todo added after restore - ${new Date().toISOString()}`,
            completed: false,
            createdBy: targetNode.libp2p.peerId.toString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
          
          await restoredDB.put(testTodoId, testTodo)
          console.log(`   ✅ Added test todo: ${testTodoId}`)
          
          const retrievedTodo = await restoredDB.get(testTodoId)
          console.log(`   ✅ Retrieved test todo: "${retrievedTodo.value.text}"`)
          
          const updatedEntries = await restoredDB.all()
          console.log(`   ✅ Total todos after test: ${updatedEntries.length}`)
          
        } else {
          console.log(`   ℹ️  Database type '${restoredDB.type}' - skipping simple-todo specific tests`)
        }
        
      } catch (error) {
        console.error('   ❌ Database verification failed:', error.message)
      }
      
    } else {
      console.error('\n❌ Restore failed:', restoreResult.error)
      
      if (restoreResult.error?.includes('not found') || restoreResult.error?.includes('404')) {
        console.log('\n💡 Troubleshooting tips:')
        console.log('   • Make sure you have backed up a simple-todo database to your Storacha space')
        console.log('   • Try running a backup from the simple-todo app first')
        console.log('   • Verify your Storacha credentials are correct')
        console.log('   • Check that your Storacha space contains OrbitDB backup files')
        console.log('   • Ensure the simple-todo relay nodes are accessible')
      }
      
      process.exit(1)
    }
    
  } catch (error) {
    console.error('\n💥 Demo failed:', error.message)
    console.error(error.stack)
    
    if (error.message.includes('credentials') || error.message.includes('auth')) {
      console.log('\n💡 Make sure your .env file contains valid Storacha credentials:')
      console.log('   STORACHA_KEY=your_private_key')
      console.log('   STORACHA_PROOF=your_delegation_proof')
    } else if (error.message.includes('connection') || error.message.includes('network')) {
      console.log('\n💡 Network troubleshooting:')
      console.log('   • Check that the relay nodes are accessible')
      console.log('   • Verify your internet connection')
      console.log('   • Try running the demo again in a few minutes')
    }
    
    process.exit(1)
    
  } finally {
    // Cleanup
    if (targetNode) {
      try {
        console.log('\n🧹 Cleaning up connections and storage...')
        await targetNode.orbitdb.stop()
        await targetNode.helia.stop()
        await targetNode.blockstore.close()
        await targetNode.datastore.close()
        console.log('✅ Cleanup completed')
      } catch (error) {
        console.warn('⚠️ Cleanup warning:', error.message)
      }
    }
  }
}

// Show usage information
function showUsage() {
  console.log('\n📚 Simple Todo OrbitDB Storacha Bridge - Restore Demo')
  console.log('\nThis demo shows how to restore a simple-todo OrbitDB database from Storacha backup.')
  console.log('It connects to the simple-todo relay nodes for peer-to-peer functionality.')
  console.log('\nUsage:')
  console.log('  node simple-todo-restore-demo.js')
  console.log('\nPrerequisites:')
  console.log('  1. Set up your .env file with Storacha credentials')
  console.log('  2. Have a simple-todo database backed up in your Storacha space')
  console.log('\nRelay nodes used:')
  RELAY_BOOTSTRAP_ADDRESSES.forEach((addr, i) => {
    console.log(`  ${i + 1}. ${addr}`)
  })
  console.log('\nWhat this demo does:')
  console.log('  • Creates OrbitDB instance connected to simple-todo relay nodes')
  console.log('  • Automatically discovers backup files in your Storacha space')
  console.log('  • Downloads and reconstructs the database with perfect hash preservation')  
  console.log('  • Verifies simple-todo data structure and functionality')
  console.log('  • Tests basic todo database operations')
}

// Handle help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showUsage()
  process.exit(0)
}

// Run demo
runSimpleTodoRestoreDemo()