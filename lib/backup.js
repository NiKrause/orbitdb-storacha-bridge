/**
 * OrbitDB database backup with timestamps and error handling
 * NOTE: This file is a placeholder/example and is incomplete
 */

/* eslint-disable no-undef, no-unused-vars */
import { Readable } from "stream";
import { CarReader } from "@ipld/car";
import * as Signer from "@storacha/client/principal/ed25519";
import { createWritableCarReader } from "@storacha/client/utils";
import {
  generateBackupPrefix,
  getBackupFilenames,
  isValidMetadata,
  findLatestBackup,
} from "./backup-helpers.js";

/**
 * Backup an OrbitDB database with timestamps and error handling
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {string} databaseAddress - Database address or name
 * @param {Object} options - Backup options
 * @returns {Promise<Object>} - Backup result
 */
export async function backupDatabase(orbitdb, databaseAddress, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { spaceName } = config;
  const eventEmitter = options.eventEmitter;

  console.log("🚀 Starting OrbitDB Database Backup");
  console.log(`📍 Database: ${databaseAddress}`);

  try {
    // Open database and extract blocks
    const database = await orbitdb.open(databaseAddress, options.dbConfig);
    const { blocks, blockSources, manifestCID } = await extractDatabaseBlocks(
      database,
      { logEntriesOnly: false },
    );

    // Generate timestamped backup paths
    const backupPrefix = generateBackupPrefix(spaceName);
    const backupFiles = getBackupFilenames(backupPrefix);

    // Create metadata
    const metadata = {
      version: "1.0",
      timestamp: Date.now(),
      databaseCount: 1,
      totalEntries: blocks.size,
      databases: [
        {
          root: database.address.root,
          path: database.address.path,
        },
      ],
    };

    // Validate metadata structure
    if (!isValidMetadata(metadata)) {
      throw new Error("Invalid metadata structure");
    }

    // Write metadata with error handling
    try {
      await Signer.writeFile(
        backupFiles.metadata,
        JSON.stringify(metadata, null, 2),
      );
    } catch (error) {
      throw new Error(`Failed to write backup metadata: ${error.message}`);
    }

    // Write blocks with error handling
    try {
      // Create CAR storage and add blocks
      const storage = await CARStorage({
        path: ".",
        name: "backup-temp",
        autoFlush: false,
      });

      for (const [key, value] of blocks) {
        await storage.put(key, value);
      }

      await storage.persist();
      const reader = await CarReader.fromIterable(storage.iterator());
      const stream = Readable.from(reader.blocks());

      await stream.pipe(
        await createWritableCarReader({
          name: backupFiles.blocks,
          comment: `OrbitDB backup blocks (created at ${new Date().toISOString()})`,
          space: spaceName,
        }),
      );

      // Clean up temp storage
      await storage.close();
      await storage.clear();
    } catch (error) {
      // Try to clean up failed metadata
      try {
        await Signer.rm(backupFiles.metadata);
      } catch (cleanupError) {
        console.warn(
          `Failed to clean up metadata after error: ${cleanupError.message}`,
        );
      }
      throw new Error(`Failed to write backup blocks: ${error.message}`);
    }

    // Return success with file info
    return {
      success: true,
      manifestCID,
      databaseAddress: database.address,
      databaseName: database.name,
      blocksTotal: blocks.size,
      blocksUploaded: blocks.size,
      blockSummary: blockSources,
      backupFiles,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Restore from the latest valid backup in a space
 *
 * @param {Object} orbitdb - OrbitDB instance
 * @param {Object} options - Restore options
 * @returns {Promise<Object>} - Restore result
 */
export async function restoreFromSpace(orbitdb, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { spaceName } = config;

  console.log("🔄 Starting OrbitDB Restore");

  try {
    // Find latest valid backup
    const spaceFiles = await listStorachaSpaceFiles(config);
    const latestBackup = findLatestBackup(spaceFiles, {
      onWarning: (msg) => console.warn(msg),
    });

    if (!latestBackup) {
      throw new Error("No valid backup found in space");
    }

    // Read and validate metadata
    let metadata;
    try {
      const metadataJson = await Signer.readFile(
        `${spaceName}/${latestBackup.metadata}`,
      );
      metadata = JSON.parse(metadataJson);
      if (!isValidMetadata(metadata)) {
        throw new Error("Invalid backup metadata structure");
      }
    } catch (error) {
      throw new Error(`Failed to read/validate metadata: ${error.message}`);
    }

    // Create storage and load blocks
    const storage = await CARStorage({
      path: ".",
      name: "restore-temp",
      autoFlush: false,
    });

    try {
      // Get blocks stream
      const carStream = await Signer.readStream(
        `${spaceName}/${latestBackup.blocks}`,
      );
      const reader = await fromReadableStream(carStream);

      // Load blocks with validation
      let validBlocks = 0;
      for await (const block of reader.blocks()) {
        try {
          await storage.put(block.cid.toString(), block.bytes);
          validBlocks++;
        } catch (blockError) {
          console.warn(`⚠️ Failed to restore block: ${blockError.message}`);
        }
      }

      if (validBlocks === 0) {
        throw new Error("No valid blocks found in backup");
      }

      // Open database using metadata
      const databaseAddress = `/orbitdb/${metadata.databases[0].root}`;
      const database = await orbitdb.open(databaseAddress);

      // Replace storage and load entries
      await database._index.replaceStorage(storage);
      await database.load();

      const entries = await database.all();

      return {
        success: true,
        database,
        databaseAddress,
        entriesRecovered: entries.length,
        blocksRestored: validBlocks,
        backupUsed: latestBackup,
      };
    } catch (error) {
      throw new Error(`Failed to restore blocks: ${error.message}`);
    } finally {
      // Clean up temp storage
      await storage.close();
      await storage.clear();
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}
