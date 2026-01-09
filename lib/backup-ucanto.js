/**
 * Direct UCANTO-based backup for in-memory testing
 * 
 * This bypasses @storacha/client to avoid JWT encoding issues,
 * using direct UCANTO capability invocations instead.
 */

import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';
import * as Block from 'multiformats/block';
import logger from './logger.js';

/**
 * Extract database blocks (reuse from main bridge)
 */
async function extractDatabaseBlocks(database, options = {}) {
  const { extractDatabaseBlocks: extract } = await import('./orbitdb-storacha-bridge.js');
  return extract(database, options);
}

/**
 * Upload blocks using direct UCANTO store/add invocations
 * 
 * @param {Map} blocks - Map of blocks to upload
 * @param {Object} connection - UCANTO connection to upload service
 * @param {Object} invocationConfig - Issuer, with, proofs, audience
 * @returns {Promise<Object>} Upload results
 */
async function uploadBlocksWithUCANTO(blocks, connection, invocationConfig, blockCache) {
  const StoreCapabilities = await import('@storacha/capabilities/store');
  const UploadCapabilities = await import('@storacha/capabilities/upload');
  
  logger.info(`📤 Uploading ${blocks.size} blocks via direct UCANTO...`);
  
  const uploadResults = [];
  const cidMappings = new Map();
  
  // Upload each block using store/add
  for (const [hash, blockData] of blocks.entries()) {
    try {
      logger.info(`   📤 Uploading block ${hash} (${blockData.bytes.length} bytes)...`);
      
      // Calculate multihash for the block
      const digest = await sha256.digest(blockData.bytes);
      // Use codec 0x202 (sha2-256) as required by store/add
      const link = CID.create(1, 0x202, digest);
      
      // Store block bytes in the block cache for in-memory testing
      if (blockCache) {
        blockCache.set(link.toString(), blockData.bytes);
        logger.info(`   💾 Cached block: ${link}`);
      }
      
      // Invoke store/add capability
      const storeInvocation = StoreCapabilities.add.invoke({
        issuer: invocationConfig.issuer,
        audience: invocationConfig.audience,
        with: invocationConfig.with,
        nb: {
          link,
          size: blockData.bytes.length,
        },
        proofs: invocationConfig.proofs,
      });
      
      // Execute the invocation
      const result = await storeInvocation.execute(connection);
      
      if (result.out.error) {
        logger.error(`Store/add invocation failed for ${hash}:`, result.out.error);
        throw new Error(`Store/add failed: ${result.out.error.message || JSON.stringify(result.out.error)}`);
      }
      
      if (!result.out.ok) {
        logger.error(`Store/add returned non-ok result for ${hash}:`, result.out);
        throw new Error(`Store/add returned non-ok result`);
      }
      
      const uploadedCID = link.toString();
      logger.info(`   ✅ Uploaded: ${hash} → ${uploadedCID}`);
      
      cidMappings.set(hash, uploadedCID);
      uploadResults.push({
        originalHash: hash,
        uploadedCID,
        size: blockData.bytes.length,
      });
    } catch (error) {
      logger.error(`   ❌ Failed to upload ${hash}:`, error.message);
      uploadResults.push({
        originalHash: hash,
        error: error.message,
      });
    }
  }
  
  const successful = uploadResults.filter(r => r.uploadedCID);
  const failed = uploadResults.filter(r => r.error);
  
  logger.info(`   📊 Upload summary:`);
  logger.info(`      Successful: ${successful.length}`);
  logger.info(`      Failed: ${failed.length}`);
  
  return { uploadResults, successful, failed, cidMappings };
}

/**
 * Backup database using direct UCANTO invocations
 * 
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address
 * @param {Object} options - Backup options
 * @param {Object} options.connection - UCANTO connection to test service
 * @param {Object} options.invocationConfig - Issuer, with, proofs, audience for invocations
 * @returns {Promise<Object>} Backup result
 */
export async function backupDatabaseWithUCANTO(orbitdb, databaseAddress, options = {}) {
  logger.info('🚀 Starting OrbitDB Backup with Direct UCANTO');
  logger.info(`📍 Database: ${databaseAddress}`);
  
  try {
    if (!options.connection) {
      throw new Error('UCANTO connection required');
    }
    
    if (!options.invocationConfig) {
      throw new Error('Invocation config (issuer, with, proofs, audience) required');
    }
    
    // Open database
    const database = await orbitdb.open(databaseAddress, options.dbConfig);
    
    // Extract blocks
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(
      database,
      { logEntriesOnly: options.logEntriesOnly || false }
    );
    
    // Upload blocks using UCANTO (pass blockCache if available)
    const { successful, cidMappings } = await uploadBlocksWithUCANTO(
      blocks,
      options.connection,
      options.invocationConfig,
      options.blockCache
    );
    
    if (successful.length === 0) {
      throw new Error('No blocks were successfully uploaded');
    }
    
    // Get block summary
    const blockSummary = {};
    for (const [_hash, source] of blockSources) {
      blockSummary[source] = (blockSummary[source] || 0) + 1;
    }
    
    logger.info('✅ UCANTO Backup completed successfully!');
    
    return {
      success: true,
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      blocksUploaded: successful.length,
      blockSummary,
      cidMappings: Object.fromEntries(cidMappings),
    };
  } catch (error) {
    logger.error('❌ UCANTO Backup failed:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Restore database by loading blocks from block cache to target blockstore
 * 
 * For in-memory testing: blocks are retrieved from a simple Map cache.
 * 
 * @param {Object} orbitdb - Target OrbitDB instance  
 * @param {string} manifestCID - Manifest CID to restore
 * @param {Object} cidMappings - Map of original CIDs to uploaded CIDs
 * @param {Object} options - Restore options
 * @param {Map} options.blockCache - Cache Map containing uploaded blocks
 * @returns {Promise<Object>} Restore result
 */
export async function restoreDatabaseWithUCANTO(orbitdb, manifestCID, cidMappings, options = {}) {
  logger.info('🔄 Starting OrbitDB Restore with Direct UCANTO');
  logger.info(`📍 Manifest CID: ${manifestCID}`);
  
  try {
    if (!options.blockCache) {
      throw new Error('blockCache required for block retrieval');
    }
    
    const { blockCache } = options;
    const targetBlockstore = orbitdb.ipfs.blockstore;
    
    // Load all blocks from cache to target blockstore
    logger.info(`📥 Loading ${Object.keys(cidMappings).length} blocks from cache...`);
    
    let loadedCount = 0;
    for (const [originalCID, uploadedCID] of Object.entries(cidMappings)) {
      try {
        // Get block from cache
        const blockBytes = blockCache.get(uploadedCID);
        
        if (!blockBytes) {
          logger.warn(`   ⚠️ Block not found in cache: ${uploadedCID}`);
          continue;
        }
        
        // Put block into target blockstore using ORIGINAL CID
        const originalCIDParsed = CID.parse(originalCID);
        await targetBlockstore.put(originalCIDParsed, blockBytes);
        loadedCount++;
        logger.info(`   ✅ Loaded: ${originalCID}`);
      } catch (error) {
        logger.warn(`   ⚠️ Failed to load ${originalCID}: ${error.message}`);
      }
    }
    
    logger.info(`📋 Loaded ${loadedCount}/${Object.keys(cidMappings).length} blocks`);
    
    if (loadedCount === 0) {
      throw new Error('No blocks were successfully loaded');
    }
    
    // Now open the database - blocks are in the target blockstore
    const databaseAddress = `/orbitdb/${manifestCID}`;
    logger.info(`   📥 Opening database at: ${databaseAddress}`);
    const database = await orbitdb.open(databaseAddress);
    
    // Analyze blocks to find HEAD entries
    logger.info(`   🔍 Analyzing blocks to find HEAD entries...`);
    const { analyzeBlocks } = await import('./orbitdb-storacha-bridge.js');
    const analysis = await analyzeBlocks(
      orbitdb.ipfs.blockstore,
      new Map(Object.keys(cidMappings).map(cid => [cid, {}]))
    );
    
    logger.info(`   🎯 Found ${analysis.potentialHeads.length} HEAD(s) in ${analysis.logEntryBlocks.length} log entries`);
    
    // Join HEAD entries to the database
    let joinedHeads = 0;
    for (const headCID of analysis.potentialHeads) {
      try {
        const logEntryBlock = analysis.logEntryBlocks.find(block => block.cid === headCID);
        if (!logEntryBlock) {
          logger.warn(`   ⚠️ HEAD ${headCID} not found in log entry blocks`);
          continue;
        }
        
        const entryData = {
          hash: logEntryBlock.cid,
          v: logEntryBlock.content.v,
          id: logEntryBlock.content.id,
          key: logEntryBlock.content.key,
          sig: logEntryBlock.content.sig,
          next: logEntryBlock.content.next,
          refs: logEntryBlock.content.refs,
          clock: logEntryBlock.content.clock,
          payload: logEntryBlock.content.payload,
          identity: logEntryBlock.content.identity,
        };
        
        const updated = await database.log.joinEntry(entryData);
        if (updated) {
          joinedHeads++;
          logger.info(`   ✅ Joined HEAD ${joinedHeads}/${analysis.potentialHeads.length}`);
        }
      } catch (error) {
        logger.warn(`   ⚠️ Failed to join HEAD ${headCID}: ${error.message}`);
      }
    }
    
    logger.info(`   📋 Joined ${joinedHeads}/${analysis.potentialHeads.length} HEAD entries`);
    
    // Wait for log to settle after joining entries
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get all entries
    const entries = await database.all();
    logger.info(`   📋 Retrieved ${entries.length} entries from database`);
    
    logger.info(`✅ UCANTO Restore completed: ${entries.length} entries recovered`);
    
    return {
      success: true,
      entriesRecovered: entries.length,
      addressMatch: database.address === databaseAddress,
      entries,
      database,
    };
  } catch (error) {
    logger.error('❌ UCANTO Restore failed:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}
