#!/usr/bin/env node

/**
 * Test UCAN File Listing
 * 
 * Test if we can now list files using UCAN after successful upload
 */

import { promises as fs } from 'fs'
import { OrbitDBStorachaBridgeUCAN } from './lib/ucan-bridge.js'
import { logger } from '../lib/logger.js'

async function testUCANListing() {
  logger.info('🧪 Testing UCAN File Listing After Upload')
  logger.info('=========================================')
  
  try {
    // Load UCAN credentials
    logger.info('\n📁 Loading UCAN credentials...')
    const ucanToken = await fs.readFile('./ucan-delegation.car', 'base64')
    const recipientKey = await fs.readFile('./recipient-key.txt', 'utf8')
    
    logger.info({ tokenLength: ucanToken.length }, `   ✅ Delegation token: ${ucanToken.length} chars`)
    logger.info('   ✅ Recipient key loaded')
    
    // Create bridge
    logger.info('\n🔐 Creating UCAN bridge...')
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanToken,
      recipientKey
    })
    
    logger.info('   ✅ Bridge created')
    
    // Test listing files
    logger.info('\n📋 Testing file listing with UCAN...')
    
    try {
      const spaceFiles = await bridge.listSpaceFiles()
      logger.info({ fileCount: spaceFiles.length }, `   🎉 SUCCESS! Listed ${spaceFiles.length} files`)
      
      if (spaceFiles.length > 0) {
        logger.info('\n📄 Files found:')
        spaceFiles.forEach((file, index) => {
          const uploadDate = file.uploaded ? new Date(file.uploaded).toLocaleString() : 'Unknown'
          logger.info({ index: index + 1, root: file.root }, `   ${index + 1}. ${file.root}`)
          logger.info({ size: file.size }, `      Size: ${file.size} bytes`)
          logger.info({ shards: file.shards }, `      Shards: ${file.shards}`)
          logger.info({ uploadDate }, `      Uploaded: ${uploadDate}`)
          logger.info('      ---')
        })
        
        logger.info('\n📊 Summary:')
        logger.info({ totalFiles: spaceFiles.length }, `   Total files: ${spaceFiles.length}`)
        logger.info({ totalSize: spaceFiles.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0) }, `   Total size: ${spaceFiles.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0)} bytes`)
      } else {
        logger.info('   📭 No files found in space')
      }
      
    } catch (listError) {
      logger.error({ error: listError.message }, `   ❌ Listing failed: ${listError.message}`)
      
      // Check if it's a permissions issue
      if (listError.message.includes('upload/list')) {
        logger.info('\n🔍 Analysis:')
        logger.info('   💡 This appears to be a capability/permission issue')
        logger.info('   🤔 The UCAN delegation might not include upload/list capability')
        logger.info('   ✅ However, upload worked fine, so the delegation is valid')
        logger.info('   💭 Options:')
        logger.info('      1. Create new delegation with upload/list capability')
        logger.info('      2. Use a different method to verify uploads')
        logger.info('      3. Check if files exist using gateway URLs')
      }
    }
    
    logger.info('\n✅ UCAN Listing Test Complete')
    
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, '\n❌ Test failed')
  }
}

testUCANListing().catch(error => logger.error({ error: error.message, stack: error.stack }, 'Test failed'))
