#!/usr/bin/env node

/**
 * Test UCAN File Listing
 * 
 * Test if we can now list files using UCAN after successful upload
 */

import { promises as fs } from 'fs'
import { OrbitDBStorachaBridgeUCAN } from './lib/ucan-bridge.js'

async function testUCANListing() {
  console.log('🧪 Testing UCAN File Listing After Upload')
  console.log('=========================================')
  
  try {
    // Load UCAN credentials
    console.log('\n📁 Loading UCAN credentials...')
    const ucanToken = await fs.readFile('./ucan-delegation.car', 'base64')
    const recipientKey = await fs.readFile('./recipient-key.txt', 'utf8')
    
    console.log(`   ✅ Delegation token: ${ucanToken.length} chars`)
    console.log(`   ✅ Recipient key loaded`)
    
    // Create bridge
    console.log('\n🔐 Creating UCAN bridge...')
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanToken,
      recipientKey
    })
    
    console.log('   ✅ Bridge created')
    
    // Test listing files
    console.log('\n📋 Testing file listing with UCAN...')
    
    try {
      const spaceFiles = await bridge.listSpaceFiles()
      console.log(`   🎉 SUCCESS! Listed ${spaceFiles.length} files`)
      
      if (spaceFiles.length > 0) {
        console.log('\n📄 Files found:')
        spaceFiles.forEach((file, index) => {
          const uploadDate = file.uploaded ? file.uploaded.toISOString() : 'Unknown'
          console.log(`   ${index + 1}. ${file.root}`)
          console.log(`      Size: ${file.size} bytes`)
          console.log(`      Shards: ${file.shards}`)
          console.log(`      Uploaded: ${uploadDate}`)
          console.log(`      ---`)
        })
        
        console.log(`\n📊 Summary:`)
        console.log(`   Total files: ${spaceFiles.length}`)
        console.log(`   Total size: ${spaceFiles.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0)} bytes`)
      } else {
        console.log('   📭 No files found in space')
      }
      
    } catch (listError) {
      console.log(`   ❌ Listing failed: ${listError.message}`)
      
      // Check if it's a permissions issue
      if (listError.message.includes('upload/list')) {
        console.log('\n🔍 Analysis:')
        console.log('   💡 This appears to be a capability/permission issue')
        console.log('   🤔 The UCAN delegation might not include upload/list capability')
        console.log('   ✅ However, upload worked fine, so the delegation is valid')
        console.log('   💭 Options:')
        console.log('      1. Create new delegation with upload/list capability')
        console.log('      2. Use a different method to verify uploads')
        console.log('      3. Check if files exist using gateway URLs')
      }
    }
    
    console.log('\n✅ UCAN Listing Test Complete')
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error(error.stack)
  }
}

testUCANListing().catch(console.error)
