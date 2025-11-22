/**
 * CAR-based OrbitDB Backup with Timestamps
 *
 * Alternative implementation using CAR (Content Addressable Archive) files
 * for efficient timestamped backups. Works in both Node.js and browser environments.
 *
 * This is backward compatible with the existing individual block upload approach.
 * Use this when you want:
 * - Timestamped backups (multiple backup points)
 * - More efficient upload (fewer files)
 * - Better organization (grouped by timestamp)
 */

import { Readable } from "stream";
import { CarWriter, CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateBackupPrefix,
  getBackupFilenames,
  isValidMetadata,
} from "./backup-helpers.js";
import {
  extractDatabaseBlocks,
  initializeStorachaClient,
  initializeStorachaClientWithUCAN,
  listStorachaSpaceFiles,
} from "./orbitdb-storacha-bridge.js";
import logger from "./logger.js";

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS = {
  timeout: 30000,
  gateway: "https://w3s.link",
  storachaKey: undefined,
  storachaProof: undefined,
  fallbackDatabaseName: undefined,
  forceFallback: false,
};

/**
 * Create a CAR file in memory from blocks
 * @param {Map} blocks - Map of blocks to include
 * @param {string} manifestCID - Root CID for the CAR file
 * @returns {Promise<Uint8Array>} CAR file as bytes
 */
export async function createCARFromBlocks(blocks, manifestCID) {
  logger.debug(`Creating CAR file with ${blocks.size} blocks`);

  // Parse the manifest CID as the root
  const rootCID = CID.parse(manifestCID);

  // Create an in-memory CAR writer
  const { writer, out } = CarWriter.create([rootCID]);

  // Collect all output chunks
  const chunks = [];
  const reader = Readable.from(out);

  reader.on("data", (chunk) => chunks.push(chunk));

  // Add all blocks to the CAR
  for (const [cidString, blockData] of blocks.entries()) {
    try {
      const cid = CID.parse(cidString);
      await writer.put({ cid, bytes: blockData.bytes });
    } catch (error) {
      logger.warn(`Failed to add block ${cidString} to CAR: ${error.message}`);
    }
  }

  await writer.close();

  // Wait for all data to be written
  await new Promise((resolve) => {
    reader.on("end", resolve);
  });

  // Concatenate all chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const carBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    carBytes.set(chunk, offset);
    offset += chunk.length;
  }

  logger.info(`Created CAR file: ${carBytes.length} bytes`);
  return carBytes;
}

/**
 * Read blocks from a CAR file
 * @param {Uint8Array|AsyncIterable} carData - CAR file data
 * @returns {Promise<Map>} Map of CID -> block data
 */
export async function readBlocksFromCAR(carData) {
  logger.debug("Reading blocks from CAR file");

  const blocks = new Map();

  // Convert Uint8Array to async iterable if needed
  const iterable =
    carData instanceof Uint8Array
      ? (async function* () {
          yield carData;
        })()
      : carData;

  const reader = await CarReader.fromIterable(iterable);

  for await (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), { cid, bytes });
  }

  logger.info(`Read ${blocks.size} blocks from CAR file`);
  return blocks;
}

/**
 * Backup an OrbitDB database using CAR format with timestamps
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - Backup options
 * @param {string} [options.spaceName='default'] - Storacha space name for organizing backups
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress
 * @returns {Promise<Object>} Backup result with file info
 */
export async function backupDatabaseCAR(
  orbitdb,
  databaseAddress,
  options = {},
) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const spaceName = config.spaceName || "default";
  const eventEmitter = options.eventEmitter;

  logger.info("🚀 Starting CAR-based OrbitDB Backup");
  logger.info(`📍 Database: ${databaseAddress}`);
  logger.info(`🗂️  Space: ${spaceName}`);

  try {
    // Initialize Storacha client
    let client;
    if (config.ucanClient) {
      logger.info("🔐 Using UCAN authentication...");
      client = await initializeStorachaClientWithUCAN({
        client: config.ucanClient,
        spaceDID: config.spaceDID,
      });
    } else {
      const storachaKey =
        config.storachaKey ||
        (typeof process !== "undefined"
          ? process.env?.STORACHA_KEY
          : undefined);
      const storachaProof =
        config.storachaProof ||
        (typeof process !== "undefined"
          ? process.env?.STORACHA_PROOF
          : undefined);

      if (!storachaKey || !storachaProof) {
        throw new Error(
          "Storacha authentication required: provide storachaKey + storachaProof OR ucanClient",
        );
      }

      client = await initializeStorachaClient(storachaKey, storachaProof);
    }

    // Step 1: Extract database blocks
    logger.info("📦 Step 1: Extracting database blocks...");
    
    // Open database - if it's already open, OrbitDB will return the existing instance
    const database = await orbitdb.open(databaseAddress, config.dbConfig);
    
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(
      database,
      { logEntriesOnly: false },
    );

    logger.info(`   ✅ Extracted ${blocks.size} blocks`);

    // Step 2: Generate timestamped filenames
    const backupPrefix = generateBackupPrefix(spaceName);
    const backupFiles = getBackupFilenames(backupPrefix);

    logger.info(`📝 Step 2: Creating timestamped backup files...`);
    logger.info(`   Metadata: ${backupFiles.metadata}`);
    logger.info(`   Blocks: ${backupFiles.blocks}`);

    // Step 3: Create metadata
    // Get entry count for verification during restore
    const entries = await database.all();
    const entriesCount = Array.isArray(entries)
      ? entries.length
      : Object.keys(entries).length;
    
    const metadata = {
      version: "1.0",
      timestamp: Date.now(),
      spaceName: spaceName, // Add spaceName for filtering backups
      databaseCount: 1,
      totalBlocks: blocks.size,
      totalEntries: entriesCount,
      manifestCID: manifestCID,
      databases: [
        {
          address: database.address,
          name: database.name,
          type: database.type,
          manifestCID: manifestCID,
          entryCount: entriesCount,
        },
      ],
      blockSummary: Object.fromEntries(
        Array.from(new Set(blockSources.values())).map((type) => [
          type,
          Array.from(blockSources.values()).filter((t) => t === type).length,
        ]),
      ),
    };

    // Validate metadata
    if (!isValidMetadata(metadata)) {
      throw new Error("Invalid metadata structure");
    }

    // Step 4: Create CAR file in memory
    logger.info("🗜️  Step 3: Creating CAR archive...");

    if (eventEmitter) {
      eventEmitter.emit("backupProgress", {
        type: "car-creation",
        status: "creating",
        totalBlocks: blocks.size,
      });
    }

    const carBytes = await createCARFromBlocks(blocks, manifestCID);

    logger.info(
      `   ✅ Created CAR file: ${carBytes.length} bytes (${blocks.size} blocks)`,
    );

    // Step 5: Upload to Storacha
    logger.info("📤 Step 4: Uploading to Storacha...");

    // Upload CAR file first (so we can include its CID in metadata)
    const carBlob = new Blob([carBytes], { type: "application/vnd.ipld.car" });
    const carFile = new File([carBlob], backupFiles.blocks, {
      type: "application/vnd.ipld.car",
    });

    if (eventEmitter) {
      eventEmitter.emit("backupProgress", {
        type: "upload",
        status: "uploading-blocks",
        size: carBytes.length,
      });
    }

    const carResult = await client.uploadFile(carFile);
    const carCID = carResult.toString();
    logger.info(`   ✅ CAR file uploaded: ${carCID}`);
    
    // Add CAR CID to metadata
    metadata.carCID = carCID;
    
    // Now upload updated metadata with CAR CID
    const updatedMetadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
      type: "application/json",
    });
    const updatedMetadataFile = new File([updatedMetadataBlob], backupFiles.metadata, {
      type: "application/json",
    });

    if (eventEmitter) {
      eventEmitter.emit("backupProgress", {
        type: "upload",
        status: "uploading-metadata",
      });
    }

    const metadataResult = await client.uploadFile(updatedMetadataFile);
    logger.info(`   ✅ Metadata uploaded: ${metadataResult.toString()}`);

    if (eventEmitter) {
      eventEmitter.emit("backupProgress", {
        type: "upload",
        status: "completed",
        metadataCID: metadataResult.toString(),
        carCID: carResult.toString(),
      });
    }

    logger.info("✅ CAR-based backup completed successfully!");
    logger.info("   Note: Database is left open for caller to manage");

    return {
      success: true,
      method: "car-timestamped",
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      carFileSize: carBytes.length,
      blockSummary: metadata.blockSummary,
      backupFiles: {
        metadata: backupFiles.metadata,
        blocks: backupFiles.blocks,
        metadataCID: metadataResult.toString(),
        carCID: carResult.toString(),
      },
      timestamp: metadata.timestamp,
    };
  } catch (error) {
    logger.error(`❌ CAR-based backup failed: ${error.message}`);

    if (eventEmitter) {
      eventEmitter.emit("backupProgress", {
        type: "upload",
        status: "error",
        error: error.message,
      });
    }

    return {
      success: false,
      method: "car-timestamped",
      error: error.message,
    };
  }
}

/**
 * Check if a file is a valid backup metadata file using Helia blockstore
 * @param {Object} blockstore - Helia blockstore
 * @param {string} cidString - CID to check
 * @param {string} spaceName - Space name to filter by
 * @returns {Promise<Object|null>} Backup info or null
 */
async function checkFileWithHelia(blockstore, cidString, spaceName) {
  try {
    const cid = CID.parse(cidString);
    
    // Get block data from Helia - it will fetch from network if needed
    const bytes = await blockstore.get(cid);
    
    // Try to parse as JSON metadata
    const text = new TextDecoder().decode(bytes);
    
    // Quick size check - metadata files should be small
    if (text.length > 100000) return null; // Skip files > 100KB
    
    const data = JSON.parse(text);
    
    // Check if it's a backup metadata file
    if (data.version && data.timestamp && data.databases && data.databases.length > 0) {
      // Filter by spaceName if it's in the metadata
      const metadataSpaceName = data.backupInfo?.spaceName || data.spaceName || "default";
      if (metadataSpaceName !== spaceName) {
        return null; // Skip backups from other spaces
      }
      
      const timestamp = new Date(data.timestamp).toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:/g, '-')
        .replace(/\..+$/, '');
        
      return {
        timestamp,
        metadataCID: cidString,
        metadata: data,
        date: new Date(data.timestamp).toISOString(),
      };
    }
    return null;
  } catch (error) {
    // Not a valid JSON metadata file or not available
    return null;
  }
}

/**
 * Check if a file is a valid backup metadata file using gateway
 * @param {string} cidString - CID to check
 * @param {string} spaceName - Space name to filter by
 * @param {string} gateway - Gateway URL
 * @returns {Promise<Object|null>} Backup info or null
 */
async function checkFileWithGateway(cidString, spaceName, gateway) {
  try {
    // Try to fetch with timeout - metadata files are small
      const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
    const response = await fetch(`${gateway}/ipfs/${cidString}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      
      if (!response.ok || response.status !== 200) return null;
      
      const text = await response.text();
      
      // Quick size check - metadata files should be small
      if (text.length > 100000) return null; // Skip files > 100KB
      
      const data = JSON.parse(text);
      
      // Check if it's a backup metadata file
      if (data.version && data.timestamp && data.databases && data.databases.length > 0) {
        // Filter by spaceName if it's in the metadata
        const metadataSpaceName = data.backupInfo?.spaceName || data.spaceName || "default";
        if (metadataSpaceName !== spaceName) {
          return null; // Skip backups from other spaces
        }
        
        const timestamp = new Date(data.timestamp).toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
          .replace(/:/g, '-')
          .replace(/\..+$/, '');
          
        return {
          timestamp,
        metadataCID: cidString,
          metadata: data,
          date: new Date(data.timestamp).toISOString(),
        };
      }
      return null;
    } catch (error) {
      return null;
  }
}

/**
 * List all available backups in a space
 *
 * @param {Object} options - Options
 * @param {string} [options.spaceName='default'] - Storacha space name
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {Object} [options.helia] - Helia instance for fetching blocks from IPFS
 * @param {Object} [options.orbitdb] - OrbitDB instance (will use its Helia instance)
 * @returns {Promise<Array>} List of available backups sorted by timestamp (newest first)
 */
export async function listAvailableBackups(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const spaceName = config.spaceName || "default";

  logger.info(`Listing backups for space: ${spaceName}`);

  // Get the blockstore from helia or orbitdb
  const blockstore = config.helia?.blockstore || config.orbitdb?.ipfs?.blockstore;
  
  // Check network connectivity if using Helia
  let peerCount = 0;
  if (config.helia?.libp2p || config.orbitdb?.ipfs?.libp2p) {
    const libp2p = config.helia?.libp2p || config.orbitdb.ipfs.libp2p;
    peerCount = libp2p.getPeers().length;
    logger.info(`🌐 Connected to ${peerCount} IPFS peers`);
    
    if (peerCount === 0) {
      logger.warn('⚠️  Not connected to any IPFS peers. Will fall back to gateway.');
    }
  }

  // listStorachaSpaceFiles handles authentication internally using config
  const spaceFiles = await listStorachaSpaceFiles(config);
  
  logger.info(`Found ${spaceFiles.length} files in space`);
  
  // Only use Helia if we have blockstore AND are connected to peers
  // Without peers, Helia can't fetch blocks from the network
  const useHelia = blockstore && peerCount > 0;
  
  if (useHelia) {
    logger.info('🔍 Using Helia blockstore to fetch backup metadata from IPFS');
  } else {
    logger.info('🌐 Using gateway to fetch backup metadata');
  }
  
  const gateway = config.gateway || "https://w3s.link";
  
  // Process files in parallel (batches of 10)
  const checkFile = async (file) => {
    const cid = file.root?.toString() || file.cid?.toString();
    if (!cid) return null;
    
    if (useHelia) {
      return await checkFileWithHelia(blockstore, cid, spaceName);
    } else {
      return await checkFileWithGateway(cid, spaceName, gateway);
    }
  };
  
  // Process in batches of 10
  const batchSize = 10;
  const backups = [];
  
  for (let i = 0; i < spaceFiles.length; i += batchSize) {
    const batch = spaceFiles.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(checkFile));
    backups.push(...results.filter(r => r !== null));
    
    if (backups.length >= 20) {
      // Found enough backups, stop checking
      logger.info(`Found ${backups.length} backups, stopping search`);
      break;
    }
  }
  
  logger.info(`Found ${backups.length} backups`);

  // Sort by timestamp (newest first)
  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return backups;
}

/**
 * Restore from a CAR-based backup in a space
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Object} options - Restore options
 * @param {string} [options.spaceName='default'] - Storacha space name
 * @param {string} [options.timestamp] - Specific backup timestamp to restore (e.g., '2025-10-27T14-30-00-123Z')
 *                                        If not provided, restores from latest backup
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {EventEmitter} [options.eventEmitter] - Optional event emitter for progress
 * @returns {Promise<Object>} Restore result
 */
export async function restoreFromSpaceCAR(orbitdb, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const spaceName = config.spaceName || "default";
  const eventEmitter = options.eventEmitter;

  logger.info("🔄 Starting CAR-based OrbitDB Restore");
  logger.info(`🗂️  Space: ${spaceName}`);

  try {
    // Step 1: Find backup (specific timestamp or latest)
    // Note: Authentication is handled by listAvailableBackups or via config for direct downloads
    let backupToRestore;

    if (options.timestamp) {
      // Restore from specific timestamp
      logger.info(
        `📋 Step 1: Finding backup with timestamp: ${options.timestamp}...`,
      );

      backupToRestore = {
        metadata: `backup-${options.timestamp}-metadata.json`,
        blocks: `backup-${options.timestamp}-blocks.car`,
        timestamp: options.timestamp,
      };

      logger.info(`   ✅ Restoring from specific backup: ${options.timestamp}`);
    } else {
      // Find latest backup using listAvailableBackups
      logger.info("📋 Step 1: Finding latest backup...");

      // Pass orbitdb instance so listAvailableBackups can use Helia
      const availableBackups = await listAvailableBackups({ ...config, orbitdb });

      if (!availableBackups || availableBackups.length === 0) {
        throw new Error("No valid CAR backup found in space");
      }

      // Use the most recent backup (already sorted by timestamp)
      const latestBackup = availableBackups[0];
      
      backupToRestore = {
        timestamp: latestBackup.timestamp,
        metadataCID: latestBackup.metadataCID,
        metadata: latestBackup.metadata,
      };

      logger.info(`   ✅ Found latest backup: ${backupToRestore.timestamp}`);
    }

    if (eventEmitter) {
      eventEmitter.emit("restoreProgress", {
        type: "discovery",
        status: "found",
        backup: backupToRestore,
      });
    }

    // Step 2: Get metadata (already have it if from listAvailableBackups)
    logger.info("📥 Step 2: Loading metadata...");

    let metadata;
    if (backupToRestore.metadata && typeof backupToRestore.metadata === 'object') {
      // Already have metadata object from listAvailableBackups
      metadata = backupToRestore.metadata;
      logger.info(`   ✅ Using cached metadata`);
    } else {
      // Download metadata by CID or filename
      const metadataCID = options.metadataCID || backupToRestore.metadataCID || backupToRestore.metadata;
      const metadataUrl = `${config.gateway}/ipfs/${metadataCID}`;
      const metadataResponse = await fetch(metadataUrl);

      if (!metadataResponse.ok) {
        throw new Error(
          `Failed to download metadata: ${metadataResponse.statusText}`,
        );
      }

      metadata = await metadataResponse.json();
    }

    if (!isValidMetadata(metadata)) {
      throw new Error("Invalid backup metadata");
    }

    logger.info(
      `   ✅ Metadata validated: ${metadata.totalBlocks} blocks, ${new Date(metadata.timestamp).toISOString()}`,
    );

    // Step 3: Download CAR file
    logger.info("📥 Step 3: Downloading CAR file...");

    if (eventEmitter) {
      eventEmitter.emit("restoreProgress", {
        type: "download",
        status: "downloading-blocks",
      });
    }

    // Get CAR CID from metadata (preferred) or options/backup object
    const carCID = metadata.carCID || options.carCID || backupToRestore.blocks;
    
    if (!carCID) {
      throw new Error("CAR file CID not found in metadata or backup info");
    }
    
    const carUrl = `${config.gateway}/ipfs/${carCID}`;
    
    // Retry logic for rate limiting
    let carResponse;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      carResponse = await fetch(carUrl);
      
      if (carResponse.ok) {
        break;
      }
      
      if (carResponse.status === 429 && attempts < maxAttempts - 1) {
        // Rate limited - check for retry hints in headers
        const retryAfter = carResponse.headers.get('Retry-After');
        const rateLimitReset = carResponse.headers.get('X-RateLimit-Reset');
        const rateLimitRemaining = carResponse.headers.get('X-RateLimit-Remaining');
        
        logger.warn(`   ⚠️ Rate limited (429)`);
        logger.warn(`   Retry-After: ${retryAfter || 'not set'}`);
        logger.warn(`   X-RateLimit-Reset: ${rateLimitReset || 'not set'}`);
        logger.warn(`   X-RateLimit-Remaining: ${rateLimitRemaining || 'not set'}`);
        
        // Calculate wait time
        let waitTime = 2000 * (attempts + 1); // Default exponential backoff
        
        if (retryAfter) {
          // Retry-After can be seconds or HTTP date
          const retrySeconds = parseInt(retryAfter);
          if (!isNaN(retrySeconds)) {
            waitTime = retrySeconds * 1000;
          } else {
            // Try parsing as date
            const retryDate = new Date(retryAfter);
            if (!isNaN(retryDate.getTime())) {
              waitTime = Math.max(0, retryDate.getTime() - Date.now());
            }
          }
        } else if (rateLimitReset) {
          // X-RateLimit-Reset is usually Unix timestamp
          const resetTime = parseInt(rateLimitReset);
          if (!isNaN(resetTime)) {
            waitTime = Math.max(0, (resetTime * 1000) - Date.now());
          }
        }
        
        logger.warn(`   Waiting ${Math.round(waitTime / 1000)}s before retry (attempt ${attempts + 1}/${maxAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        attempts++;
        continue;
      }
      
      throw new Error(`Failed to download CAR file: ${carResponse.statusText}`);
    }

    if (!carResponse.ok) {
      throw new Error(`Failed to download CAR file after ${maxAttempts} attempts: ${carResponse.statusText}`);
    }

    const carBytes = new Uint8Array(await carResponse.arrayBuffer());
    logger.info(`   ✅ Downloaded CAR file: ${carBytes.length} bytes`);

    // Step 4: Extract blocks from CAR
    logger.info("📦 Step 4: Extracting blocks from CAR...");

    const blocks = await readBlocksFromCAR(carBytes);
    logger.info(`   ✅ Extracted ${blocks.size} blocks`);

    // Step 5: Restore blocks to OrbitDB
    logger.info("💾 Step 5: Restoring blocks to OrbitDB...");

    if (eventEmitter) {
      eventEmitter.emit("restoreProgress", {
        type: "restore",
        status: "restoring-blocks",
        total: blocks.size,
      });
    }

    let restoredCount = 0;
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        // Put blocks into Helia's blockstore
        await orbitdb.ipfs.blockstore.put(cid, blockData.bytes);
        restoredCount++;
        
        logger.info(`   ✓ Restored block to blockstore: ${cidString.substring(0, 12)}...`);
      } catch (error) {
        logger.warn(`Failed to restore block ${cidString}: ${error.message}`);
      }
    }

    logger.info(`   ✅ Restored ${restoredCount}/${blocks.size} blocks to blockstore`);

    // Step 6: Open database
    logger.info("🔓 Step 6: Opening database...");

    const dbInfo = metadata.databases[0];
    const databaseAddress = dbInfo.address;
    
    logger.info(`   Opening database with address: ${databaseAddress}`);
    logger.info(`   Expected entries: ${metadata.totalEntries || dbInfo.entryCount || 'unknown'}`);
    
    const database = await orbitdb.open(databaseAddress, { type: dbInfo.type });
    
    // Put blocks directly into the database's log storage as well
    // OrbitDB expects CIDs in base58btc format (starting with 'z'), so we need to convert
    logger.info(`   📝 Copying blocks to database log storage...`);
    let copiedToStorage = 0;
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        // Convert CID to base58btc format (what OrbitDB expects)
        const cidBase58btc = cid.toV1().toString(base58btc);
        await database.log.storage.put(cidBase58btc, blockData.bytes);
        copiedToStorage++;
        logger.info(`   ✓ Copied ${cidString.substring(0, 12)}... (as ${cidBase58btc.substring(0, 12)}...) to log storage`);
      } catch (error) {
        logger.error(`   ❌ Failed to put ${cidString.substring(0, 12)}... to log storage: ${error.message}`);
      }
    }
    logger.info(`   ✅ Copied ${copiedToStorage}/${blocks.size} blocks to log storage`);
    
    // Close and reopen the database to force it to reload from storage
    logger.info(`   🔄 Reopening database to load entries from storage...`);
    await database.close();
    
    const reopenedDatabase = await orbitdb.open(databaseAddress, { type: dbInfo.type });
    
    // Step 7: Discover heads and join them to the log
    logger.info("🎯 Step 7: Discovering and joining log heads...");
    
    // Decode blocks to find log entries and determine heads
    const logEntries = [];
    const logChain = new Map(); // Maps entry hash -> entries that reference it in "next"
    
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        if (cid.code === 0x71) { // dag-cbor
          const block = await Block.decode({
            cid,
            bytes: blockData.bytes,
            codec: dagCbor,
            hasher: sha256,
          });
          
          const content = block.value;
          
          // Check if this is a log entry (has signature, key, identity)
          if (content && content.sig && content.key && content.identity) {
            const cidBase58btc = cid.toV1().toString(base58btc);
            logEntries.push({
              cid: cidBase58btc,
              content,
            });
            
            // Track references for head detection
            if (content.next && Array.isArray(content.next)) {
              for (const nextHash of content.next) {
                logChain.set(nextHash, cidBase58btc);
              }
            }
          }
        }
      } catch (error) {
        // Skip blocks that can't be decoded
      }
    }
    
    logger.info(`   Found ${logEntries.length} log entries`);
    
    // Find heads: entries not referenced by any other entry's "next"
    const heads = logEntries.filter(entry => !logChain.has(entry.cid));
    logger.info(`   Found ${heads.length} heads`);
    
    // Join heads to the database log
    let joinedCount = 0;
    for (const head of heads) {
      try {
        const entryData = {
          hash: head.cid,
          v: head.content.v,
          id: head.content.id,
          key: head.content.key,
          sig: head.content.sig,
          next: head.content.next,
          refs: head.content.refs,
          clock: head.content.clock,
          payload: head.content.payload,
          identity: head.content.identity,
        };
        
        const updated = await reopenedDatabase.log.joinEntry(entryData);
        if (updated) {
          joinedCount++;
          logger.info(`   ✓ Joined head ${joinedCount}/${heads.length}: ${head.cid.substring(0, 12)}...`);
        }
      } catch (error) {
        logger.warn(`   ⚠️ Failed to join head ${head.cid.substring(0, 12)}...: ${error.message}`);
      }
    }
    
    logger.info(`   ✅ Joined ${joinedCount}/${heads.length} heads`);

    // Wait for the log to be fully loaded
    // OrbitDB processes entries asynchronously, so we need to wait
    logger.info("   ⏳ Waiting for log entries to load...");
    
    // Poll until entries are loaded or timeout
    const startTime = Date.now();
    const maxWaitTime = config.timeout / 2; // Use half of timeout (15 seconds)
    const expectedEntries = metadata.totalEntries || dbInfo.entryCount;
    let entriesCount = 0;
    let previousCount = -1;
    
    while (Date.now() - startTime < maxWaitTime) {
      const entries = await reopenedDatabase.all();
      entriesCount = Array.isArray(entries)
        ? entries.length
        : Object.keys(entries).length;
      
      // If we know how many entries to expect, wait for that count
      if (expectedEntries !== undefined && entriesCount >= expectedEntries) {
        logger.info(`   ✅ All ${entriesCount} entries loaded`);
        break;
      }
      
      // If count hasn't changed for a bit, assume loading is complete
      if (entriesCount > 0 && entriesCount === previousCount) {
        // Wait one more second to be sure
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const finalCheck = await reopenedDatabase.all();
        const finalCount = Array.isArray(finalCheck)
          ? finalCheck.length
          : Object.keys(finalCheck).length;
        if (finalCount === entriesCount) {
          logger.info(`   ✅ Entries stabilized at ${entriesCount}`);
          break;
        }
      }
      
      previousCount = entriesCount;
      
      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Final check
    const entries = await reopenedDatabase.all();
    entriesCount = Array.isArray(entries)
      ? entries.length
      : Object.keys(entries).length;

    logger.info(`   ✅ Database opened: ${entriesCount} entries`);

    if (eventEmitter) {
      eventEmitter.emit("restoreProgress", {
        type: "restore",
        status: "completed",
        entriesRecovered: entriesCount,
      });
    }

    logger.info("✅ CAR-based restore completed successfully!");

    return {
      success: true,
      method: "car-timestamped",
      database: reopenedDatabase,
      databaseAddress,
      name: reopenedDatabase.name,
      type: reopenedDatabase.type,
      entriesRecovered: entriesCount,
      blocksRestored: restoredCount,
      backupTimestamp: metadata.timestamp,
      backupUsed: backupToRestore,
    };
  } catch (error) {
    logger.error(`❌ CAR-based restore failed: ${error.message}`);

    if (eventEmitter) {
      eventEmitter.emit("restoreProgress", {
        type: "restore",
        status: "error",
        error: error.message,
      });
    }

    return {
      success: false,
      method: "car-timestamped",
      error: error.message,
    };
  }
}

export default {
  backupDatabaseCAR,
  restoreFromSpaceCAR,
  listAvailableBackups,
  createCARFromBlocks,
  readBlocksFromCAR,
};
