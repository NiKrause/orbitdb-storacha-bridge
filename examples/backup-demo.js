/**
 * Backup Demo
 *
 * Backs an OrbitDB database up to decentralized storage — Aleph by default,
 * see examples/storage.js — and prints the CID that restore-demo.js needs.
 */

import "dotenv/config";
import { backupDatabase } from "../lib/orbitdb-storacha-bridge.js";

// Import utilities separately
import { createHeliaOrbitDB } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { storageFromEnv } from "./storage.js";
import { enable } from "@libp2p/logger";

// The demos speak through the library's logger, which is off unless DEBUG says
// otherwise. Running an example should print what it did.
if (!process.env.DEBUG) enable("libp2p:orbitdb-storacha*");

async function runBackupDemo() {
  const { backend, label } = storageFromEnv();

  logger.info("🚀 OrbitDB Storage Bridge - Backup Demo (%s)", label);
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

    // Step 3: Backup. The whole database goes up as one CAR file, and the
    // metadata beside it names that CAR — which is why a single CID is enough
    // to restore from.
    logger.info("\n💾 Starting backup to %s...", label);
    const backupResult = await backupDatabase(
      sourceNode.orbitdb,
      database.address,
      { backend },
    );

    if (backupResult.success) {
      logger.info("\n🎉 Backup completed successfully!");
      logger.info("📦 Blocks: %d", backupResult.blocksTotal);
      logger.info("🗜️  CAR: %s", backupResult.backupFiles.carCID);
      logger.info("📈 Block breakdown:");
      for (const [type, count] of Object.entries(backupResult.blockSummary)) {
        logger.info(`   ${type}: %d blocks`, count);
      }

      logger.info("\n💾 Restore it with:");
      logger.info(
        "   %sBACKUP_CID=%s node examples/restore-demo.js",
        process.env.STORAGE ? `STORAGE=${process.env.STORAGE} ` : "",
        backupResult.backupFiles.metadataCID,
      );
    } else {
      logger.error("\n❌ Backup failed: %o", backupResult.error);
      process.exit(1);
    }
  } catch (error) {
    logger.error("\n💥 Demo failed: %s\nStack: %s", error.message, error.stack);
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
