/**
 * OrbitDB Storacha Bridge - Backup Demo
 *
 * Demonstrates how to backup an OrbitDB database to Storacha
 */

import "dotenv/config";
import { backupDatabase } from "../lib/orbitdb-storacha-bridge.js";

// Import utilities separately
import { createHeliaOrbitDB } from "../lib/utils.js";
import { logger } from "../lib/logger.js";

async function runBackupDemo() {
  logger.info("🚀 OrbitDB Storacha Bridge - Backup Demo");
  logger.info("=".repeat(50));

  let sourceNode;

  try {
    // Step 1: Create OrbitDB instance
    logger.info("\n📡 Creating OrbitDB instance...");
    sourceNode = await createHeliaOrbitDB("-backup-demo");

    // Step 2: Create and populate database
    logger.info("\n📊 Creating database...");
    const database = await sourceNode.orbitdb.open("backup-demo-db", {
      type: "events",
    });

    const sampleEntries = [
      "First backup entry",
      "Second backup entry",
      "Third backup entry",
    ];

    for (const entry of sampleEntries) {
      const hash = await database.add(entry);
      logger.info(`   ✓ Added: %s - "%s"`, hash, entry);
    }

    logger.info("\n📋 Database created:");
    logger.info("   Name: %s", database.name);
    logger.info("   Address: %s", database.address);
    logger.info("   Entries: %d", (await database.all()).length);

    // Step 3: Backup to Storacha
    logger.info("\n💾 Starting backup...");
    const backupResult = await backupDatabase(
      sourceNode.orbitdb,
      database.address,
    );

    if (backupResult.success) {
      logger.info("\n🎉 Backup completed successfully!");
      logger.info("📋 Manifest CID: %s", backupResult.manifestCID);
      logger.info(
        "📊 Blocks uploaded: %d/%d",
        backupResult.blocksUploaded,
        backupResult.blocksTotal,
      );
      logger.info("📈 Block breakdown:");
      for (const [type, count] of Object.entries(backupResult.blockSummary)) {
        logger.info(`   ${type}: %d blocks`, count);
      }

      // Save backup info for restoration demo
      logger.info("\n💾 Backup information (save this for restore):");
      logger.info("Manifest CID: %s", backupResult.manifestCID);
      logger.info(
        "Database Address: %s",
        backupResult.databaseAddress,
      );
      logger.info(
        "CID Mappings (sample): %o",
        Object.keys(backupResult.cidMappings).slice(0, 2),
      );
    } else {
      logger.error("\n❌ Backup failed: %o", backupResult.error);
      process.exit(1);
    }
  } catch (error) {
    logger.error(
      "\n💥 Demo failed: %s\nStack: %s",
      error.message,
      error.stack,
    );
    process.exit(1);
  } finally {
    // Cleanup
    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop();
        await sourceNode.helia.stop();
        await sourceNode.blockstore.close();
        await sourceNode.datastore.close();
        logger.info("\n🧹 Cleanup completed");
      } catch (error) {
        logger.warn("⚠️ Cleanup warning: %s", error.message);
      }
    }
  }
}

// Run demo
runBackupDemo();
