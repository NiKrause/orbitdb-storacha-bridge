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
async function uploadBlocksWithUCANTO(blocks, connection, invocationConfig) {
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
        throw new Error(`Store/add failed: ${result.out.error.message || JSON.stringify(result.out.error)}`);
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
    
    // Upload blocks using UCANTO
    const { successful, cidMappings } = await uploadBlocksWithUCANTO(
      blocks,
      options.connection,
      options.invocationConfig
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
