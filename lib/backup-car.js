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
  downloadBlockFromIPFSNetwork,
  downloadBlockFromStoracha,
} from "./orbitdb-storacha-bridge.js";
import { unixfs } from "@helia/unixfs";
import logger from "./logger.js";

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS = {
  timeout: 30000,
  gateway: "https://w3s.link",
  // Network download options
  useIPFSNetwork: true, // Enable network downloads by default
  gatewayFallback: true, // Fallback to gateway if network fails
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
  if (!blocks || !(blocks instanceof Map)) {
    throw new Error("blocks must be a Map");
  }
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

    // Defensive check: ensure blocks is a Map
    if (!blocks || !(blocks instanceof Map)) {
      throw new Error("Failed to extract database blocks: blocks is not a Map");
    }

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
    const updatedMetadataFile = new File(
      [updatedMetadataBlob],
      backupFiles.metadata,
      {
        type: "application/json",
      },
    );

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
 * List all available backups in a space
 *
 * @param {Object} options - Options
 * @param {string} [options.spaceName='default'] - Storacha space name
 * @param {string} [options.storachaKey] - Storacha private key
 * @param {string} [options.storachaProof] - Storacha proof
 * @param {Object} [options.ucanClient] - Pre-configured UCAN client
 * @param {string} [options.spaceDID] - Space DID for UCAN auth
 * @param {Object} [options.ipfs] - IPFS/Helia instance for network downloads
 * @param {boolean} [options.useIPFSNetwork=true] - Use IPFS network for downloads
 * @param {boolean} [options.gatewayFallback=true] - Fallback to gateway if network fails
 * @returns {Promise<Array>} List of available backups sorted by timestamp (newest first)
 */
export async function listAvailableBackups(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const spaceName = config.spaceName || "default";
  const maxRetries = 5;
  const retryDelay = 5000; // 5 seconds

  logger.info(`Listing backups for space: ${spaceName}`);

  // listStorachaSpaceFiles handles authentication internally using config
  // Use the existing listStorachaSpaceFiles function
  const spaceFiles = await listStorachaSpaceFiles(config);

  logger.info(`Found ${spaceFiles.length} files in space`);

  // Storacha only returns CIDs, not original filenames
  // We need to download and check each file to see if it's a backup metadata file

  // Process files in parallel (batches of 10) with increased timeout
  /**
   * Checks if a file from Storacha space is a backup metadata file.
   *
   * Since Storacha only returns CIDs (not filenames), we need to download and inspect
   * each file to identify backup metadata files. The space contains both:
   * - Backup metadata files (JSON) - which we want to list
   * - CAR files (binary) - which we want to skip
   *
   * This function performs multiple validation checks to efficiently filter out
   * binary CAR files before attempting JSON parsing:
   * 1. Downloads the file from IPFS network (if available) or gateway with timeout protection
   *    - Uses downloadBlockFromStoracha for gateway downloads (tries multiple gateways)
   * 2. Checks file size (metadata files are small, < 100KB)
   * 3. Validates JSON structure (starts with '{' or '[')
   * 4. Detects binary data (non-printable characters)
   * 5. Parses as JSON and validates backup metadata structure
   * 6. Filters by spaceName if specified in metadata
   *
   * @param {Object} file - File object from Storacha space listing
   * @param {string} [file.root] - Root CID of the file
   * @param {string} [file.cid] - CID of the file
   * @returns {Promise<Object|null>} Backup metadata object if valid, null otherwise
   */
  const checkFile = async (file) => {
    try {
      const cid = file.root?.toString() || file.cid?.toString();
      if (!cid) return null;

      let text;

      // Try network download first if enabled and IPFS instance available
      if (config.useIPFSNetwork && config.ipfs) {
        try {
          const fs = unixfs(config.ipfs);
          const bytes = await downloadBlockFromIPFSNetwork(cid, config.ipfs, {
            ...config,
            unixfs: fs,
            timeout: 5000,
          });
          text = new TextDecoder().decode(bytes);
        } catch (error) {
          logger.debug(
            `Network download failed for ${cid.substring(0, 12)}..., ${config.gatewayFallback ? "falling back to gateway" : "no fallback"}: ${error.message}`,
          );
          if (!config.gatewayFallback) {
            return null; // Network failed and no fallback
          }
          // Fall through to gateway
        }
      }

      // Fallback to gateway if network failed or disabled
      if (!text) {
        // Use downloadBlockFromStoracha for better gateway fallback (tries multiple gateways)
        try {
          const bytes = await downloadBlockFromStoracha(cid, {
            ...config,
            useIPFSNetwork: false, // Force gateway-only mode
            helia: config.ipfs, // Pass IPFS instance if available (won't be used when useIPFSNetwork is false)
            timeout: 5000,
          });

          // Additional validation: check if we got an HTML error page
          const textStart = new TextDecoder("utf-8", { fatal: false }).decode(
            bytes.slice(0, Math.min(200, bytes.length)),
          );
          if (
            textStart.trim().startsWith("<!DOCTYPE") ||
            textStart.trim().startsWith("<html") ||
            textStart.trim().startsWith("<?xml")
          ) {
            logger.debug(
              `Gateway returned HTML error page for ${cid.substring(0, 12)}..., file may not be available on gateway yet`,
            );
            return null;
          }

          text = new TextDecoder().decode(bytes);
        } catch (error) {
          logger.debug(
            `Gateway download failed for ${cid.substring(0, 12)}...: ${error.message}`,
          );
          return null;
        }
      }

      // Quick size check - metadata files should be small
      if (text.length > 100000) return null; // Skip files > 100KB

      // Check if it looks like JSON before parsing (CAR files are binary and won't start with '{' or '[')
      const trimmedText = text.trim();
      if (!trimmedText.startsWith("{") && !trimmedText.startsWith("[")) {
        // Not JSON, likely a CAR file or other binary format
        logger.debug(
          `Skipping non-JSON file ${cid.substring(0, 12)}... (doesn't start with '{' or '[')`,
        );
        return null;
      }

      // Check for binary data (non-printable characters in first few bytes)
      // CAR files often have binary data that shows up as weird characters
      const firstBytes = text.substring(0, Math.min(100, text.length));
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0E-\x1F]/.test(firstBytes)) {
        // Contains binary data, likely not JSON
        logger.debug(
          `Skipping binary file ${cid.substring(0, 12)}... (contains binary data)`,
        );
        return null;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseError) {
        // Not valid JSON, skip it
        logger.debug(
          `Skipping invalid JSON file ${cid.substring(0, 12)}...: ${parseError.message}`,
        );
        return null;
      }

      // Check if it's a backup metadata file
      if (
        data.version &&
        data.timestamp &&
        data.databases &&
        data.databases.length > 0
      ) {
        // Filter by spaceName if it's in the metadata
        const metadataSpaceName =
          data.backupInfo?.spaceName || data.spaceName || "default";
        logger.debug(
          `Found backup with spaceName: ${metadataSpaceName}, looking for: ${spaceName}`,
        );
        if (metadataSpaceName !== spaceName) {
          logger.debug(`Skipping backup from space ${metadataSpaceName}`);
          return null; // Skip backups from other spaces
        }
        logger.info(`Matched backup from space ${metadataSpaceName}`);

        const timestamp = new Date(data.timestamp)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
          .replace(/:/g, "-")
          .replace(/\..+$/, "");

        return {
          timestamp,
          metadataCID: cid,
          metadata: data,
          date: new Date(data.timestamp).toISOString(),
        };
      }
      return null;
    } catch (error) {
      logger.debug(
        `Failed to check file ${file.root?.toString() || file.cid?.toString() || "unknown"}: ${error.message}`,
      );
      return null;
    }
  };

  // Retry logic: try up to maxRetries times if no backups found
  let backups = [];
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;

    if (attempt > 1) {
      logger.info(
        `Retry attempt ${attempt}/${maxRetries} (waiting ${retryDelay}ms before retry)...`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    // Process in batches of 10
    const batchSize = 10;
    backups = [];

    for (let i = 0; i < spaceFiles.length; i += batchSize) {
      const batch = spaceFiles.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(checkFile));
      backups.push(...results.filter((r) => r !== null));

      if (backups.length >= 20) {
        // Found enough backups, stop checking
        logger.info(`Found ${backups.length} backups, stopping search`);
        break;
      }
    }

    logger.info(
      `Found ${backups.length} backups (attempt ${attempt}/${maxRetries})`,
    );

    // If we found backups, break out of retry loop
    if (backups.length > 0) {
      break;
    }

    // If this was the last attempt, log a warning
    if (attempt === maxRetries) {
      logger.warn(
        `No backups found after ${maxRetries} attempts. Files may not be available on IPFS gateway yet.`,
      );
    }
  }

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

      const availableBackups = await listAvailableBackups({
        ...config,
        ipfs: orbitdb?.ipfs, // Pass IPFS instance for network downloads
      });

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
    if (
      backupToRestore.metadata &&
      typeof backupToRestore.metadata === "object"
    ) {
      // Already have metadata object from listAvailableBackups
      metadata = backupToRestore.metadata;
      logger.info(`   ✅ Using cached metadata`);
    } else {
      // Download metadata by CID or filename
      const metadataCID =
        options.metadataCID ||
        backupToRestore.metadataCID ||
        backupToRestore.metadata;

      // Try network download first if enabled and OrbitDB instance available
      let metadataBytes = null;
      if (config.useIPFSNetwork && orbitdb?.ipfs) {
        try {
          logger.info(
            "   🌐 Attempting to download metadata from IPFS network...",
          );
          // Get unixfs from orbitdb if available (it should be from createHeliaOrbitDB)
          const fs = unixfs(orbitdb.ipfs);
          metadataBytes = await downloadBlockFromIPFSNetwork(
            metadataCID,
            orbitdb.ipfs,
            { ...config, unixfs: fs },
          );
          metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
          logger.info("   ✅ Metadata downloaded from IPFS network");
        } catch (error) {
          logger.info(
            `   ⚠️ Network download failed, ${config.gatewayFallback ? "falling back to gateway" : "no fallback"}: ${error.message}`,
          );
          if (!config.gatewayFallback) {
            throw new Error(
              `Failed to download metadata from IPFS network and gateway fallback is disabled: ${error.message}`,
            );
          }
        }
      }

      // Fallback to gateway if network failed or disabled
      if (!metadata) {
        const metadataUrl = `${config.gateway}/ipfs/${metadataCID}`;
        const metadataResponse = await fetch(metadataUrl);

        if (!metadataResponse.ok) {
          throw new Error(
            `Failed to download metadata: ${metadataResponse.statusText}`,
          );
        }

        metadata = await metadataResponse.json();
        logger.info("   ✅ Metadata downloaded from gateway");
      }
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

    // Try network download first if enabled and OrbitDB instance available
    let carBytes = null;
    if (config.useIPFSNetwork && orbitdb?.ipfs) {
      try {
        logger.info(
          "   🌐 Attempting to download CAR file from IPFS network...",
        );
        // Use provided unixfs or create one from orbitdb
        let fs = config.unixfs;
        if (!fs) {
          fs = unixfs(orbitdb.ipfs);
        }
        carBytes = await downloadBlockFromIPFSNetwork(carCID, orbitdb.ipfs, {
          ...config,
          unixfs: fs,
        });
        logger.info(
          `   ✅ Downloaded CAR file: ${carBytes.length} bytes from IPFS network`,
        );
      } catch (error) {
        logger.info(
          `   ⚠️ Network download failed, ${config.gatewayFallback ? "falling back to gateway" : "no fallback"}: ${error.message}`,
        );
        if (!config.gatewayFallback) {
          throw new Error(
            `Failed to download CAR file from IPFS network and gateway fallback is disabled: ${error.message}`,
          );
        }
      }
    }

    // Fallback to gateway if network failed or disabled
    if (!carBytes) {
      // Try multiple gateways in order
      const gateways = [
        `${config.gateway}/ipfs`,
        "https://storacha.link/ipfs",
        "https://dweb.link/ipfs",
        "https://ipfs.io/ipfs",
      ];

      let carResponse;
      let lastError;

      for (const gateway of gateways) {
        const carUrl = `${gateway}/${carCID}`;
        logger.info(`   Trying gateway: ${gateway}...`);

        // Retry logic for rate limiting
        let attempts = 0;
        const maxAttempts = 3;
        let success = false;

        while (attempts < maxAttempts && !success) {
          try {
            carResponse = await fetch(carUrl);

            if (carResponse.ok) {
              const contentType =
                carResponse.headers?.get("content-type") || "";

              // Check if we got HTML (error page)
              if (
                contentType.includes("text/html") ||
                contentType.includes("application/xhtml")
              ) {
                // Decode and log the error page
                const tempBytes = new Uint8Array(
                  await carResponse.arrayBuffer(),
                );
                const errorPageText = new TextDecoder("utf-8", {
                  fatal: false,
                }).decode(tempBytes);
                logger.warn(
                  `   ⚠️ Gateway ${gateway} returned HTML error page (Content-Type: ${contentType})`,
                );
                logger.debug(
                  `   Error page preview: ${errorPageText.substring(0, 200)}...`,
                );
                break; // Try next gateway
              }

              // Download the bytes
              carBytes = new Uint8Array(await carResponse.arrayBuffer());

              // Validate that we didn't get an HTML error page by content
              const textStart = new TextDecoder("utf-8", {
                fatal: false,
              }).decode(carBytes.slice(0, Math.min(100, carBytes.length)));
              if (
                textStart.trim().startsWith("<!DOCTYPE") ||
                textStart.trim().startsWith("<html") ||
                textStart.trim().startsWith("<?xml")
              ) {
                // Decode and log the error page
                const errorPageText = new TextDecoder("utf-8", {
                  fatal: false,
                }).decode(carBytes);
                logger.warn(
                  `   ⚠️ Gateway ${gateway} returned HTML error page (detected by content)`,
                );
                logger.debug(
                  `   Error page preview: ${errorPageText.substring(0, 200)}...`,
                );
                carBytes = null; // Reset to try next gateway
                break; // Try next gateway
              }

              // Validate CAR file header (CAR files start with specific bytes)
              // CAR v1 format starts with 0x3aa16726649a (varint-encoded header)
              if (carBytes.length < 11) {
                logger.warn(
                  `   ⚠️ Gateway ${gateway} returned file too small (${carBytes.length} bytes), trying next gateway...`,
                );
                carBytes = null; // Reset to try next gateway
                break; // Try next gateway
              }

              // Success! We got a valid CAR file
              logger.info(
                `   ✅ Downloaded CAR file: ${carBytes.length} bytes from ${gateway}`,
              );
              success = true;
              break;
            }

            // Handle rate limiting
            if (carResponse.status === 429 && attempts < maxAttempts - 1) {
              const retryAfter = carResponse.headers.get("Retry-After");
              const rateLimitReset =
                carResponse.headers.get("X-RateLimit-Reset");
              const rateLimitRemaining = carResponse.headers.get(
                "X-RateLimit-Remaining",
              );

              logger.warn(`   ⚠️ Rate limited (429) on ${gateway}`);
              logger.warn(`   Retry-After: ${retryAfter || "not set"}`);
              logger.warn(
                `   X-RateLimit-Reset: ${rateLimitReset || "not set"}`,
              );
              logger.warn(
                `   X-RateLimit-Remaining: ${rateLimitRemaining || "not set"}`,
              );

              // Calculate wait time
              let waitTime = 2000 * (attempts + 1); // Default exponential backoff

              if (retryAfter) {
                const retrySeconds = parseInt(retryAfter);
                if (!isNaN(retrySeconds)) {
                  waitTime = retrySeconds * 1000;
                } else {
                  const retryDate = new Date(retryAfter);
                  if (!isNaN(retryDate.getTime())) {
                    waitTime = Math.max(0, retryDate.getTime() - Date.now());
                  }
                }
              } else if (rateLimitReset) {
                const resetTime = parseInt(rateLimitReset);
                if (!isNaN(resetTime)) {
                  waitTime = Math.max(0, resetTime * 1000 - Date.now());
                }
              }

              logger.warn(
                `   Waiting ${Math.round(waitTime / 1000)}s before retry (attempt ${attempts + 1}/${maxAttempts})...`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitTime));
              attempts++;
              continue;
            }

            // Other error status - try next gateway
            logger.debug(
              `   ⚠️ Gateway ${gateway} returned status ${carResponse.status}, trying next gateway...`,
            );
            break; // Try next gateway
          } catch (error) {
            lastError = error;
            logger.debug(`   ⚠️ Failed from ${gateway}: ${error.message}`);
            attempts++;
            if (attempts >= maxAttempts) {
              break; // Try next gateway
            }
          }
        }

        // If we successfully downloaded, break out of gateway loop
        if (success && carBytes) {
          break;
        }
      }

      // If we still don't have carBytes, all gateways failed
      if (!carBytes) {
        throw new Error(
          `Could not download CAR file from any gateway. Last error: ${lastError?.message || "Unknown error"}`,
        );
      }
    }

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
    if (!blocks || !(blocks instanceof Map)) {
      throw new Error("blocks must be a Map");
    }
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        // Put blocks into Helia's blockstore
        await orbitdb.ipfs.blockstore.put(cid, blockData.bytes);
        restoredCount++;

        logger.info(
          `   ✓ Restored block to blockstore: ${cidString.substring(0, 12)}...`,
        );
      } catch (error) {
        logger.warn(`Failed to restore block ${cidString}: ${error.message}`);
      }
    }

    logger.info(
      `   ✅ Restored ${restoredCount}/${blocks.size} blocks to blockstore`,
    );

    // Step 6: Open database
    logger.info("🔓 Step 6: Opening database...");

    const dbInfo = metadata.databases[0];
    const databaseAddress = dbInfo.address;
    const manifestCID = dbInfo.manifestCID || metadata.manifestCID;

    logger.info(`   Opening database with address: ${databaseAddress}`);
    logger.info(
      `   Expected entries: ${metadata.totalEntries || dbInfo.entryCount || "unknown"}`,
    );

    // Verify manifest is in restored blocks and accessible
    if (manifestCID) {
      const manifestInBlocks = blocks.has(manifestCID);
      logger.info(
        `   📋 Manifest CID: ${manifestCID.substring(0, 12)}... (in blocks: ${manifestInBlocks ? "✅" : "❌"})`,
      );

      if (manifestInBlocks) {
        // Verify manifest is accessible in blockstore
        try {
          const manifestCid = CID.parse(manifestCID);
          const manifestBytes = await orbitdb.ipfs.blockstore.get(manifestCid);
          if (manifestBytes) {
            logger.info(`   ✅ Manifest is accessible in blockstore`);
          } else {
            logger.warn(`   ⚠️ Manifest not found in blockstore`);
          }
        } catch (error) {
          logger.warn(
            `   ⚠️ Could not verify manifest in blockstore: ${error.message}`,
          );
        }
      }
    }

    const database = await orbitdb.open(databaseAddress, { type: dbInfo.type });

    // Put blocks directly into the database's log storage as well
    // OrbitDB expects CIDs in base58btc format (starting with 'z'), so we need to convert
    logger.info(`   📝 Copying blocks to database log storage...`);
    let copiedToStorage = 0;
    if (!blocks || !(blocks instanceof Map)) {
      throw new Error("blocks must be a Map");
    }
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        // Convert CID to base58btc format (what OrbitDB expects)
        const cidBase58btc = cid.toV1().toString(base58btc);
        await database.log.storage.put(cidBase58btc, blockData.bytes);
        copiedToStorage++;
        logger.info(
          `   ✓ Copied ${cidString.substring(0, 12)}... (as ${cidBase58btc.substring(0, 12)}...) to log storage`,
        );
      } catch (error) {
        logger.error(
          `   ❌ Failed to put ${cidString.substring(0, 12)}... to log storage: ${error.message}`,
        );
      }
    }
    logger.info(
      `   ✅ Copied ${copiedToStorage}/${blocks.size} blocks to log storage`,
    );

    // Close and reopen the database to force it to reload from storage
    logger.info(`   🔄 Reopening database to load entries from storage...`);
    await database.close();

    const reopenedDatabase = await orbitdb.open(databaseAddress, {
      type: dbInfo.type,
    });

    // Step 7: Discover heads and join them to the log
    logger.info("🎯 Step 7: Discovering and joining log heads...");

    // Decode blocks to find log entries and determine heads
    const logEntries = [];
    const logChain = new Map(); // Maps entry hash -> entries that reference it in "next"

    if (!blocks || !(blocks instanceof Map)) {
      throw new Error("blocks must be a Map");
    }
    for (const [cidString, blockData] of blocks.entries()) {
      try {
        const cid = CID.parse(cidString);
        if (cid.code === 0x71) {
          // dag-cbor
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
    const heads = logEntries.filter((entry) => !logChain.has(entry.cid));
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
          logger.info(
            `   ✓ Joined head ${joinedCount}/${heads.length}: ${head.cid.substring(0, 12)}...`,
          );
        }
      } catch (error) {
        logger.warn(
          `   ⚠️ Failed to join head ${head.cid.substring(0, 12)}...: ${error.message}`,
        );
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
