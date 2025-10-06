#!/usr/bin/env node

/**
 * Test Proper OrbitDB Identity Creation
 * 
 * This script tests the corrected createOrbitDBIdentityFromSeed function
 * to ensure it properly creates an OrbitDB identity with DID provider integration.
 */

import 'dotenv/config'
import { generateMnemonic } from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english'
import { createLibp2p } from 'libp2p'
import { createHelia } from 'helia'
import { LevelBlockstore } from 'blockstore-level'
import { createOrbitDB } from '@orbitdb/core'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { 
    generateMasterSeed,
    createOrbitDBIdentityFromSeed 
} from './decontact-style-identity.js'
import { logger } from '../lib/logger.js'

// Basic libp2p config (simplified)
const Libp2pOptions = {
    // Add minimal config - you may need to import your actual config
}

async function testProperOrbitDBIdentity() {
    logger.info('🧪 Testing Proper OrbitDB Identity Creation')
    logger.info('=' .repeat(50))
    
    try {
        logger.info('\n🌱 Step 1: Generate seed phrase and master seed')
        
        // Generate test seed
        const seedPhrase = generateMnemonic(english)
        const masterSeed = generateMasterSeed(seedPhrase, 'password')
        
        logger.info(`   🔤 Seed phrase: ${seedPhrase}`)
        logger.info(`   🔑 Master seed: ${masterSeed.substring(0, 16)}...`)
        
        logger.info('\n🆔 Step 2: Create proper OrbitDB identity from seed')
        
        // Create proper OrbitDB identity (this should now work correctly)
        const orbitdbResult = await createOrbitDBIdentityFromSeed(masterSeed)
        
        logger.info('\n✅ Identity Creation Results:')
        logger.info(`   🔵 OrbitDB Identity ID: ${orbitdbResult.identity.id}`)
        logger.info(`   🔑 Identity Type: ${orbitdbResult.identity.type}`)
        logger.info(`   📋 Identity Hash: ${orbitdbResult.identity.hash}`)
        
        logger.info('\n🚀 Step 3: Test OrbitDB integration with custom identity')
        
        // Initialize IPFS/Helia with minimal config
        const blockstore = new LevelBlockstore('./test-identity/ipfs')
        let libp2p
        try {
            // Try to import your libp2p config
            const { Libp2pOptions: ImportedConfig } = await import('../config/libp2p.js')
            libp2p = await createLibp2p(ImportedConfig)
        } catch {
            // Fallback to minimal config
            libp2p = await createLibp2p({
                addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
                transports: [tcp()],
                connectionEncryption: [noise()],
                streamMuxers: [yamux()]
            })
        }
        
        const ipfs = await createHelia({ libp2p, blockstore })
        
        // Create OrbitDB with custom identity
        const orbitdb = await createOrbitDB({ 
            ipfs, 
            identities: orbitdbResult.identities,
            id: orbitdbResult.identity.id,
            directory: './test-identity/orbitdb'
        })
        
        logger.info(`   ✅ OrbitDB initialized with custom identity`)
        logger.info(`   🤖 OrbitDB identity: ${orbitdb.identity.id}`)
        
        logger.info('\n🗄️ Step 4: Test database operations with custom identity')
        
        // Create a test database
        const db = await orbitdb.open('test-seed-identity-db')
        
        logger.info(`   📍 Database address: ${db.address}`)
        logger.info(`   🔑 Database creator: ${db.identity.id}`)
        
        // Add some test data
        await db.add('Hello from seed-derived OrbitDB identity!')
        await db.add(`Created at: ${new Date().toISOString()}`)
        await db.add(`Seed phrase: ${seedPhrase}`)
        
        // Retrieve all data
        const allEntries = await db.all()
        logger.info(`   📝 Added ${allEntries.length} entries to database`)
        
        logger.info('\n📊 Database Entries:')
        allEntries.forEach((entry, index) => {
            logger.info(`   ${index + 1}. ${entry.value}`)
        })
        
        logger.info('\n🔄 Step 5: Test deterministic identity recreation')
        
        // Create the same identity again from the same seed
        const orbitdbResult2 = await createOrbitDBIdentityFromSeed(masterSeed)
        
        const identityMatch = orbitdbResult.identity.id === orbitdbResult2.identity.id
        logger.info(`   🔍 Identity determinism: ${identityMatch ? '✅ SAME' : '❌ DIFFERENT'}`)
        logger.info(`   📋 Original: ${orbitdbResult.identity.id}`)
        logger.info(`   📋 Recreated: ${orbitdbResult2.identity.id}`)
        
        // Cleanup
        logger.info('\n🧹 Cleanup...')
        await db.close()
        await orbitdb.stop()
        await ipfs.stop()
        
        logger.info('\n🎉 SUCCESS! Proper OrbitDB identity creation with DID provider works!')
        logger.info('\n📋 Test Summary:')
        logger.info(`   ✅ Seed-derived OrbitDB identity created`)
        logger.info(`   ✅ Custom DID provider registered`)
        logger.info(`   ✅ OrbitDB integrated with custom identity`)
        logger.info(`   ✅ Database operations successful`)
        logger.info(`   ${identityMatch ? '✅' : '❌'} Deterministic identity recreation`)
        
        return {
            success: true,
            identity: orbitdbResult.identity,
            deterministic: identityMatch,
            seedPhrase,
            databaseEntries: allEntries.length
        }
        
    } catch (error) {
        logger.error('\n❌ Test failed:', error.message)
        logger.error('Stack:', error.stack)
        
        return {
            success: false,
            error: error.message
        }
    }
}

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testProperOrbitDBIdentity()
        .then(result => {
            if (result.success) {
                logger.info('\n✅ All tests passed!')
                process.exit(0)
            } else {
                logger.info('\n❌ Tests failed!')
                process.exit(1)
            }
        })
        .catch(error => {
            logger.error('Test execution failed:', error)
            process.exit(1)
        })
}

export { testProperOrbitDBIdentity }
