/**
 * OrbitDB Storacha Bridge Demo - Node.js Edition
 *
 * Demonstrates complete OrbitDB database backup and restoration via Storacha/Filecoin
 * with 100% hash preservation and identity recovery using the refactored library.
 */

// Import dotenv for Node.js environment variable handling
import "dotenv/config";
import {
  backupDatabase,
  restoreDatabaseFromSpace,
} from "../lib/orbitdb-storacha-bridge.js";

// Import utilities separately
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

import { logger } from "../lib/logger.js";

/**
 * Test complete OrbitDB backup and restore workflow
 */
async function testOrbitDBStorachaBridge() {
  logger.info("🚀 Testing OrbitDB Storacha Bridge");
  logger.info("=".repeat(60));

  let sourceNode, targetNode;

  try {
    // Step 1: Create source database with sample data
    logger.info("\n📡 Step 1: Creating source database...");
    sourceNode = await createHeliaOrbitDB("-source");

    const sourceDB = await sourceNode.orbitdb.open("bridge-demo", {
      type: "events",
    });

    // Add sample data
    const sampleData = [
      "Hello from OrbitDB!",
      "This data will survive backup and restore",
      "Perfect hash preservation test",
      "Identity recovery demonstration",
    ];

    for (const content of sampleData) {
      const hash = await sourceDB.add(content);
      logger.info(
        { hash: hash.substring(0, 16), content },
        `   📝 Added: ${hash.substring(0, 16)}... - "${content}"`,
      );
    }

    logger.info(`\n📊 Source database created:`);
    logger.info(`   Name: ${sourceDB.name}`);
    logger.info(`   Address: ${sourceDB.address}`);
    logger.info(`   Entries: ${(await sourceDB.all()).length}`);

    // Step 2: Backup database to Storacha
    logger.info("\n📤 Step 2: Backing up database to Storacha...");

    const backupResult = await backupDatabase(
      sourceNode.orbitdb,
      sourceDB.address,
      {
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
      },
    );

    if (!backupResult.success) {
      throw new Error(`Backup failed: ${backupResult.error}`);
    }

    logger.info(`✅ Backup completed successfully!`);
    logger.info(`   📋 Manifest CID: ${backupResult.manifestCID}`);
    logger.info(
      `   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`,
    );
    logger.info(`   📦 Block types:`, backupResult.blockSummary);

    // Close source database
    await sourceDB.close();
    await sourceNode.orbitdb.stop();
    await sourceNode.helia.stop();
    await sourceNode.blockstore.close();
    await sourceNode.datastore.close();

    logger.info("\n🧹 Source database closed and cleaned up");

    // Step 3: Create target node and restore from space
    logger.info("\n🔄 Step 3: Creating target node...");
    targetNode = await createHeliaOrbitDB("-target");

    logger.info("\n📥 Step 4: Restoring database from Storacha space...");

    const restoreResult = await restoreDatabaseFromSpace(targetNode.orbitdb, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
    });

    if (!restoreResult.success) {
      throw new Error(`Restore failed: ${restoreResult.error}`);
    }

    logger.info(`✅ Restore completed successfully!`);
    logger.info(`   📋 Restored database: ${restoreResult.name}`);
    logger.info(`   📍 Address: ${restoreResult.address}`);
    logger.info(`   📊 Entries recovered: ${restoreResult.entriesRecovered}`);
    logger.info(`   🔄 Blocks restored: ${restoreResult.blocksRestored}`);
    logger.info(`   🎯 Address match: ${restoreResult.addressMatch}`);

    // Display restored entries
    logger.info("\n📄 Restored entries:");
    for (let i = 0; i < restoreResult.entries.length; i++) {
      const entry = restoreResult.entries[i];
      logger.info(
        `   ${i + 1}. ${entry.hash.substring(0, 16)}... - "${entry.value}"`,
      );
    }

    // Test identity separation
    logger.info("\n🔐 Testing identity separation...");

    // Get Alice's identity from the log entries (not from the entries array)
    const logEntries = await restoreResult.database.log.values();
    const firstLogEntry = logEntries[0];
    logger.info(
      { aliceIdentity: firstLogEntry.identity },
      "   Alice's identity (from restored log)",
    );

    // Get Bob's current OrbitDB identity
    const bobIdentity = targetNode.orbitdb.identity.id;
    logger.info({ bobIdentity }, "   Bob's identity (current OrbitDB)");
    logger.info(
      { match: firstLogEntry.identity === bobIdentity },
      "   📊 Identities match: " +
        (firstLogEntry.identity === bobIdentity
          ? "❌ Same (unexpected)"
          : "✅ Different (expected)"),
    );

    // Try to add a new entry as Bob (this will fail due to access control)
    logger.info("\n🔒 Testing access control...");
    logger.info("   Bob attempts to write to Alice's database...");
    try {
      const bobEntry = await restoreResult.database.add("New entry from Bob");
      logger.warn(
        { entryHash: bobEntry.substring(0, 16) },
        "   ❌ UNEXPECTED: Bob was able to write!",
      );
    } catch (error) {
      logger.info("   ✅ EXPECTED: Access control working!");
      logger.info({ error: error.message }, "   📝 Error");
      logger.info(
        "   🎯 This confirms Bob has a different identity and cannot write to Alice's database",
      );
    }

    const originalCount = sampleData.length;
    const restoredCount = restoreResult.entriesRecovered;

    // Close Bob's database after identity test
    await restoreResult.database.close();

    logger.info("\n🎉 SUCCESS! OrbitDB Storacha Bridge test completed!");
    logger.info(`   📊 Original entries: ${originalCount}`);
    logger.info(`   📊 Restored entries: ${restoredCount}`);
    logger.info(`   📋 Manifest CID: ${restoreResult.manifestCID}`);
    logger.info(`   📍 Address preserved: ${restoreResult.addressMatch}`);
    logger.info(
      `   🌟 100% data integrity: ${originalCount === restoredCount && restoreResult.addressMatch}`,
    );

    return {
      success: true,
      manifestCID: restoreResult.manifestCID,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      blocksUploaded: backupResult.blocksUploaded,
      blocksRestored: restoreResult.blocksRestored,
    };
  } catch (error) {
    logger.error("\n💥 Test failed:", error.message);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    // Cleanup
    logger.info("\n🧹 Cleaning up...");

    if (targetNode) {
      try {
        await targetNode.orbitdb.stop();
        await targetNode.helia.stop();
        await targetNode.blockstore.close();
        await targetNode.datastore.close();
        logger.info("   ✅ Target node cleaned up");
      } catch (error) {
        logger.warn(`   ⚠️ Target cleanup warning: ${error.message}`);
      }
    }

    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop();
        await sourceNode.helia.stop();
        await sourceNode.blockstore.close();
        await sourceNode.datastore.close();
        logger.info("   ✅ Source node cleaned up");
      } catch (error) {
        logger.warn(`   ⚠️ Source cleanup warning: ${error.message}`);
      }
    }

    // Clean up OrbitDB directories
    logger.info("\n🧹 Final cleanup - removing OrbitDB directories...");
    await cleanupOrbitDBDirectories();
  }
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testOrbitDBStorachaBridge()
    .then((result) => {
      if (result?.success) {
        logger.info("\n🎉 Demo completed successfully!");
        process.exit(0);
      } else {
        logger.error("\n❌ Demo failed!");
        process.exit(1);
      }
    })
    .catch((error) => {
      logger.error("\n💥 Demo crashed:", error.message);
      process.exit(1);
    });
}

export { testOrbitDBStorachaBridge };
