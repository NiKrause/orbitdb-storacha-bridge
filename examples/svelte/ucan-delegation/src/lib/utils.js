/**
 * OrbitDB Storacha Bridge - Utility Functions
 *
 * Common utility functions for OrbitDB operations and cleanup
 */

import { createLibp2p } from "libp2p";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { createHelia } from "helia";
import { createOrbitDB } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { logger } from './logger.js'

/**
 * Clean up OrbitDB directories
 */
export async function cleanupOrbitDBDirectories() {
  const fs = await import("fs");

  try {
    const entries = await fs.promises.readdir(".", { withFileTypes: true });
    const orbitdbDirs = entries.filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith("orbitdb-bridge-") ||
          entry.name.includes("orbitdb-bridge-")),
    );

    for (const dir of orbitdbDirs) {
      try {
        await fs.promises.rm(dir.name, { recursive: true, force: true });
        logger.info(`🧹 Cleaned up: ${dir.name}`);
      } catch (error) {
        logger.warn(`⚠️ Could not clean up ${dir.name}: ${error.message}`);
      }
    }

    if (orbitdbDirs.length === 0) {
      logger.info("🧹 No OrbitDB directories to clean up");
    } else {
      logger.info(`🧹 Cleaned up ${orbitdbDirs.length} OrbitDB directories`);
    }
  } catch (error) {
    logger.warn(`⚠️ Cleanup warning: ${error.message}`);
  }
}

/**
 * Clean up all test-related directories and CAR files
 * This function removes all common test artifacts created during testing
 */
export async function cleanupAllTestArtifacts() {
  const fs = await import("fs");
  // const path = await import('path') // Currently unused

  logger.info("🧹 Starting comprehensive test cleanup...");

  // Test directories to clean up
  const testDirectories = [
    "./test-car-storage-bridge",
    "./test-orbitdb-car-integration",
    "./test-preservation",
    "./test-advanced",
    "./test-data",
    "./test-hash-preservation",
    "./orbitdb-todo-restored",
    "./orbitdb-todo-source",
    "./helia-car-demo",
    "./storage-demo",
  ];

  // CAR files to clean up (common patterns)
  // const carFilePatterns = [
  //   'test-*.car',
  //   '*-test.car',
  //   'todos-backup.car',
  //   'storacha-hash-preservation-test.car'
  // ]

  let cleanedDirs = 0;
  let cleanedFiles = 0;

  // Clean up test directories
  for (const dir of testDirectories) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      logger.info(`🧹 Removed test directory: ${dir}`);
      cleanedDirs++;
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.warn(`⚠️ Could not remove ${dir}: ${error.message}`);
      }
    }
  }

  // Clean up CAR files
  try {
    const entries = await fs.promises.readdir(".", { withFileTypes: true });
    const carFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".car"),
    );

    for (const carFile of carFiles) {
      try {
        await fs.promises.unlink(carFile.name);
        logger.info(`🧹 Removed CAR file: ${carFile.name}`);
        cleanedFiles++;
      } catch (error) {
        logger.warn(`⚠️ Could not remove ${carFile.name}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.warn(`⚠️ Error scanning for CAR files: ${error.message}`);
  }

  // Also clean up OrbitDB directories
  await cleanupOrbitDBDirectories();

  logger.info(
    `🧹 Comprehensive cleanup completed: ${cleanedDirs} directories, ${cleanedFiles} CAR files`,
  );
}

/**
 * Clean up specific test directory and associated CAR files
 * @param {string} testDir - The test directory path
 * @param {string} [carPrefix] - Optional prefix for CAR files to clean
 */
export async function cleanupTestDirectory(testDir, carPrefix = "") {
  const fs = await import("fs");

  try {
    // Remove test directory
    await fs.promises.rm(testDir, { recursive: true, force: true });
    logger.info(`🧹 Removed test directory: ${testDir}`);

    // Remove associated CAR files if prefix provided
    if (carPrefix) {
      try {
        const entries = await fs.promises.readdir(".", { withFileTypes: true });
        const carFiles = entries.filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".car") &&
            entry.name.includes(carPrefix),
        );

        for (const carFile of carFiles) {
          await fs.promises.unlink(carFile.name);
          logger.info(`🧹 Removed CAR file: ${carFile.name}`);
        }
      } catch (error) {
        logger.warn(
          `⚠️ Error cleaning CAR files with prefix ${carPrefix}: ${error.message}`,
        );
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(
        `⚠️ Could not clean up test directory ${testDir}: ${error.message}`,
      );
    }
  }
}

/**
 * Create a Helia/OrbitDB instance with specified suffix
 */
export async function createHeliaOrbitDB(suffix = "") {
  const libp2p = await createLibp2p({
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const blockstore = new LevelBlockstore(
    `./orbitdb-bridge-${uniqueId}${suffix}`,
  );
  const datastore = new LevelDatastore(
    `./orbitdb-bridge-${uniqueId}${suffix}-data`,
  );

  const helia = await createHelia({ libp2p, blockstore, datastore });
  const orbitdb = await createOrbitDB({ ipfs: helia });

  return { helia, orbitdb, libp2p, blockstore, datastore };
}
