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

async function authenticateWithExistingUCAN() {
  console.log('🔐 Authenticating with Existing UCAN Delegation')
  console.log('=' .repeat(60))
  
  try {
    // Read the saved recipient key and delegation token
    const recipientKeyData = JSON.parse(await fs.readFile('recipient-key.txt', 'utf8'))
    const delegationToken = await fs.readFile('delegation-token.txt', 'utf8')
    
    console.log('📋 Loading credentials from files...')
    console.log(`   🔑 Recipient DID: ${recipientKeyData.id}`)
    console.log(`   📜 Delegation token length: ${delegationToken.length} characters`)
    
    // Step 1: Reconstruct the recipient identity from saved key
    const fixedArchive = {
      id: recipientKeyData.id,
      keys: {
        [recipientKeyData.id]: new Uint8Array(Object.values(recipientKeyData.keys[recipientKeyData.id]))
      }
    }
    const recipientPrincipal = Signer.from(fixedArchive)
    
    console.log('✅ Recipient identity reconstructed')
    console.log(`   🆔 DID: ${recipientPrincipal.did()}`)
    
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
    
    console.log('✅ Delegation parsed successfully')
    console.log(`   📋 Capabilities: ${delegation.ok.capabilities.map(cap => cap.can).join(', ')}`)
    console.log(`   🎯 Audience: ${delegation.ok.audience.did()}`)
    console.log(`   🔑 Issuer: ${delegation.ok.issuer.did()}`)
    
    // Step 4: Add the delegation as a space
    const space = await client.addSpace(delegation.ok)
    await client.setCurrentSpace(space.did())
    
    console.log(`✅ Space connected: ${space.did()}`)
    
    // Step 5: Test file upload
    console.log('\n📤 Testing file upload...')
    
    const testContent = `Hello from simplified UCAN! Uploaded at ${new Date().toISOString()}`
    const testFile = new File([testContent], 'simple-ucan-test.txt', {
      type: 'text/plain'
    })
    
    const result = await client.uploadFile(testFile)
    
    console.log('✅ Upload successful!')
    console.log(`   🔗 Uploaded CID: ${result}`)
    console.log(`   🌐 IPFS URL: https://w3s.link/ipfs/${result}`)
    
    console.log('\n🎉 SUCCESS! Authentication with existing UCAN works!')
    console.log('\n📋 Key Points:')
    console.log('   ✅ Used existing recipient DID (no new key generation)')
    console.log('   ✅ Used existing delegation token')
    console.log('   ✅ Both DID private key AND delegation are required')
    console.log('   ✅ Storacha validates the delegation on each request')
    
    return {
      success: true,
      recipientDID: recipientPrincipal.did(),
      spaceDID: space.did(),
      uploadedCID: result.toString()
    }
    
  } catch (error) {
    console.error('❌ Authentication failed:', error.message)
    console.error('\n💡 Make sure you have run create-proper-ucan.js first to generate:')
    console.error('   - recipient-key.txt (contains the recipient private key)')
    console.error('   - delegation-token.txt (contains the UCAN delegation)')
    
    return {
      success: false,
      error: error.message
    }
  }
}

// Alternative function that takes parameters directly
export async function authenticateWithUCAN(recipientKey, delegationToken) {
  console.log('🔐 Authenticating with provided UCAN credentials...')
  
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
        console.log('\n🚀 Ready to use this pattern in your OrbitDB bridge!')
        console.log('\n💡 Integration tips:')
        console.log('   1. Store recipient key and delegation token securely')
        console.log('   2. Both are required for every authentication')
        console.log('   3. Delegation tokens can expire - check expiration dates')
        console.log('   4. You can create multiple delegations for different recipients')
      }
    })
    .catch(console.error)
}