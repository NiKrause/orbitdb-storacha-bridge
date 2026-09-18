/**
 * Restore Demo
 *
 * Restores an OrbitDB database from a backup, on a node that has never seen
 * that database. Everything hangs off one CID: the metadata names the CAR, the
 * CAR holds the blocks, the blocks carry their own addresses.
 *
 *   node examples/backup-demo.js                  # prints the CID
 *   BACKUP_CID=<cid> node examples/restore-demo.js
 *
 * Storage comes from STORAGE (Aleph by default), see examples/storage.js — use
 * the same one the backup went to.
 */

import "dotenv/config";
import { restoreFromCID } from "../lib/restore-cid.js";

// Import utilities separately
import { createHeliaOrbitDB } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { storageFromEnv } from "./storage.js";
import { enable } from "@libp2p/logger";

// The demos speak through the library's logger, which is off unless DEBUG says
// otherwise. Running an example should print what it did.
if (!process.env.DEBUG) enable("libp2p:orbitdb-storacha*");

async function runRestoreDemo() {
  const metadataCID = process.env.BACKUP_CID || process.argv[2];
  if (!metadataCID) {
    logger.error("❌ No backup to restore from.");
    logger.error("   Run backup-demo.js first; it prints the CID to use:");
    logger.error("   BACKUP_CID=<cid> node examples/restore-demo.js");
    process.exit(1);
  }

  const { backend, label } = storageFromEnv();

  logger.info("🔄 OrbitDB Storage Bridge - Restore Demo (%s)", label);
  logger.info("=".repeat(50));

  let targetNode;

  try {
    // Step 1: Create target OrbitDB instance
    logger.info("\n📡 Creating target OrbitDB instance...");
    targetNode = await createHeliaOrbitDB("-restore-demo");

    logger.info(`\n📋 Restore parameters:`);
    logger.info(`   Backup: ${metadataCID}`);
    logger.info(`   Fetched from: ${label}`);

    // Step 2: Restore. No account and no space — the bytes come from wherever
    // the caller says, here the same backend the backup went to.
    logger.info("\n💾 Starting restore...");
    const restoreResult = await restoreFromCID(targetNode.orbitdb, {
      metadataCID,
      fetchBytes: (cid) => backend.getBlob(cid),
      log: logger,
    });

    logger.info("\n🎉 Restore completed successfully!");
    logger.info(`📋 Database Address: ${restoreResult.address}`);
    logger.info(`📊 Entries in the backup: ${restoreResult.entries}`);
    logger.info(`📦 Blocks restored: ${restoreResult.blocks}`);
    logger.info(`🔗 Heads joined: ${restoreResult.joined}/${restoreResult.heads}`);

    // Step 3: Verify restored database. `restoreFromCID` hands back the open
    // database; opening the address again returns that same instance.
    logger.info("\n🔍 Verifying restored database...");

    const restoredDB = restoreResult.database;
    const allEntries = await restoredDB.all();

    logger.info(`\n📊 Database verification:`);
    logger.info(`   Name: ${restoredDB.name}`);
    logger.info(`   Type: ${restoredDB.type}`);
    logger.info(`   Address: ${restoredDB.address}`);
    logger.info(`   Total entries: ${allEntries.length}`);

    if (allEntries.length > 0) {
      logger.info(`\n📄 Sample entries:`);
      for (const [index, entry] of allEntries.slice(0, 3).entries()) {
        logger.info(`   ${index + 1}. ${entry.hash} - "${entry.value}"`);
      }

      if (allEntries.length > 3) {
        logger.info(`   ... and ${allEntries.length - 3} more entries`);
      }
    } else {
      logger.info(
        `   ⚠️  No entries found - database might be empty or restore incomplete`,
      );
    }

    // Step 4: A restored database is a database: it still takes writes.
    logger.info("\n🧪 Testing database operations...");

    if (restoredDB.type === "events") {
      const testEntry = `Test entry added after restore - ${new Date().toISOString()}`;
      const hash = await restoredDB.add(testEntry);
      logger.info(`   ✅ Added test entry: ${hash}`);
      logger.info(`   ✅ Total entries after test: ${(await restoredDB.all()).length}`);
    } else {
      logger.info(`   ℹ️  Database type '${restoredDB.type}' - skipping write test`);
    }
  } catch (error) {
    logger.error("\n💥 Restore failed: %s", error.message);
    if (/fetch|gateway|not found|404/i.test(error.message)) {
      logger.info("\n💡 Troubleshooting tips:");
      logger.info("   • Use the same STORAGE the backup went to");
      logger.info("   • Check the CID — backup-demo.js prints the one to use");
      logger.info("   • An Aleph upload is not kept: back up again and restore right away");
    }
    process.exit(1);
  } finally {
    // Cleanup
    if (targetNode) {
      try {
        await targetNode.orbitdb.stop();
        await targetNode.helia.stop();
        await targetNode.blockstore.close();
        await targetNode.datastore.close();
        logger.info("\n🧹 Cleanup completed");
      } catch (error) {
        logger.warn("⚠️ Cleanup warning: %s", error.message);
      }
    }
  }
}

// Run demo
runRestoreDemo();
