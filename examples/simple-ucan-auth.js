#!/usr/bin/env node
/**
 * Simple UCAN Authentication Script
 * Uses an existing DID and delegation token (no key generation)
 * 
 * This demonstrates that you need BOTH:
 * 1. The recipient's private key (to prove you are the intended recipient)
 * 2. The delegation token (to prove you have permission)
 */

import 'dotenv/config'
import * as Client from '@storacha/client'
import { StoreMemory } from '@storacha/client/stores/memory'
import { Signer } from '@storacha/client/principal/ed25519'
import * as Delegation from '@ucanto/core/delegation'
import { promises as fs } from 'fs'
import { logger } from '../lib/logger.js'

async function authenticateWithExistingUCAN() {
  logger.info('🔐 Authenticating with Existing UCAN Delegation')
  logger.info('=' .repeat(60))
  
  try {
    // Read the saved recipient key and delegation token
    const recipientKeyData = JSON.parse(await fs.readFile('recipient-key.txt', 'utf8'))
    const delegationToken = await fs.readFile('delegation-token.txt', 'utf8')
    
    logger.info('📋 Loading credentials from files...')
    logger.info({ recipientDid: recipientKeyData.id }, `   🔑 Recipient DID: ${recipientKeyData.id}`)
    logger.info({ tokenLength: delegationToken.length }, `   📜 Delegation token length: ${delegationToken.length} characters`)
    
    // Step 1: Reconstruct the recipient identity from saved key
    const fixedArchive = {
      id: recipientKeyData.id,
      keys: {
        [recipientKeyData.id]: new Uint8Array(Object.values(recipientKeyData.keys[recipientKeyData.id]))
      }
    }
    const recipientPrincipal = Signer.from(fixedArchive)
    
    logger.info('✅ Recipient identity reconstructed')
    logger.info({ did: recipientPrincipal.did() }, `   🆔 DID: ${recipientPrincipal.did()}`)
    
    // Step 2: Create Storacha client with the recipient identity
    const store = new StoreMemory()
    const client = await Client.create({ 
      principal: recipientPrincipal, 
      store 
    })
    
    // Step 3: Parse and add the delegation
    const delegationBytes = Buffer.from(delegationToken, 'base64')
    const delegation = await Delegation.extract(delegationBytes)
    
    if (!delegation.ok) {
      throw new Error('Failed to extract delegation from token')
    }
    
    logger.info('✅ Delegation parsed successfully')
    logger.info({ capabilities: delegation.ok.capabilities.map(cap => cap.can).join(', ') }, `   📋 Capabilities: ${delegation.ok.capabilities.map(cap => cap.can).join(', ')}`)
    logger.info({ audience: delegation.ok.audience.did() }, `   🎯 Audience: ${delegation.ok.audience.did()}`)
    logger.info({ issuer: delegation.ok.issuer.did() }, `   🔑 Issuer: ${delegation.ok.issuer.did()}`)
    
    // Step 4: Add the delegation as a space
    const space = await client.addSpace(delegation.ok)
    await client.setCurrentSpace(space.did())
    
    logger.info({ spaceDid: space.did() }, `✅ Space connected: ${space.did()}`)
    
    // Step 5: Test file upload
    logger.info('\n📤 Testing file upload...')
    
    const testContent = `Hello from simplified UCAN! Uploaded at ${new Date().toISOString()}`
    const testFile = new File([testContent], 'simple-ucan-test.txt', {
      type: 'text/plain'
    })
    
    const result = await client.uploadFile(testFile)
    
    logger.info('✅ Upload successful!')
    logger.info({ cid: result }, `   🔗 Uploaded CID: ${result}`)
    logger.info({ ipfsUrl: `https://w3s.link/ipfs/${result}` }, `   🌐 IPFS URL: https://w3s.link/ipfs/${result}`)
    
    logger.info('\n🎉 SUCCESS! Authentication with existing UCAN works!')
    logger.info('\n📋 Key Points:')
    logger.info('   ✅ Used existing recipient DID (no new key generation)')
    logger.info('   ✅ Used existing delegation token')
    logger.info('   ✅ Both DID private key AND delegation are required')
    logger.info('   ✅ Storacha validates the delegation on each request')
    
    return {
      success: true,
      recipientDID: recipientPrincipal.did(),
      spaceDID: space.did(),
      uploadedCID: result.toString()
    }
    
  } catch (error) {
    logger.error({ error: error.message }, '❌ Authentication failed')
    logger.error('\n💡 Make sure you have run create-proper-ucan.js first to generate:')
    logger.error('   - recipient-key.txt (contains the recipient private key)')
    logger.error('   - delegation-token.txt (contains the UCAN delegation)')
    
    return {
      success: false,
      error: error.message
    }
  }
}

// Alternative function that takes parameters directly
export async function authenticateWithUCAN(recipientKey, delegationToken) {
  logger.info('🔐 Authenticating with provided UCAN credentials...')
  
  try {
    // Parse recipient key (could be JSON string or object)
    const recipientKeyData = typeof recipientKey === 'string' 
      ? JSON.parse(recipientKey) 
      : recipientKey
    
    // Reconstruct recipient identity
    const fixedArchive = {
      id: recipientKeyData.id,
      keys: {
        [recipientKeyData.id]: new Uint8Array(Object.values(recipientKeyData.keys[recipientKeyData.id]))
      }
    }
    const recipientPrincipal = Signer.from(fixedArchive)
    
    // Create client
    const store = new StoreMemory()
    const client = await Client.create({ principal: recipientPrincipal, store })
    
    // Parse delegation
    const delegationBytes = Buffer.from(delegationToken, 'base64')
    const delegation = await Delegation.extract(delegationBytes)
    
    if (!delegation.ok) {
      throw new Error('Invalid delegation token')
    }
    
    // Add space
    const space = await client.addSpace(delegation.ok)
    await client.setCurrentSpace(space.did())
    
    return {
      client,
      space,
      recipientDID: recipientPrincipal.did(),
      capabilities: delegation.ok.capabilities.map(cap => cap.can)
    }
    
  } catch (error) {
    throw new Error(`UCAN authentication failed: ${error.message}`)
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  authenticateWithExistingUCAN()
    .then(result => {
      if (result.success) {
        logger.info('\n🚀 Ready to use this pattern in your OrbitDB bridge!')
        logger.info('\n💡 Integration tips:')
        logger.info('   1. Store recipient key and delegation token securely')
        logger.info('   2. Both are required for every authentication')
        logger.info('   3. Delegation tokens can expire - check expiration dates')
        logger.info('   4. You can create multiple delegations for different recipients')
      }
    })
    .catch(error => logger.error({ error: error.message, stack: error.stack }, 'Authentication failed'))
}