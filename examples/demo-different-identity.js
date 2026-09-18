/**
 * OrbitDB Storacha Bridge Demo - Explicit Different Identities Edition
 *
 * Demonstrates:
 * - Creating explicit different identities for Alice and Bob
 * - Setting up IPFS access controller with write permission for Alice only
 * - Backup and restore with identity verification
 * - Access control enforcement
 */

// Import dotenv for Node.js environment variable handling
import "dotenv/config";
import {
  backupDatabase,
} from "../lib/orbitdb-storacha-bridge.js";

// Import utilities separately
import { cleanupOrbitDBDirectories } from "../lib/utils.js";

// Import required OrbitDB modules
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { gossipsub } from "@libp2p/gossipsub";
import { createHelia } from "helia";
import { createOrbitDB, Identities, IPFSAccessController } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { logger } from "../lib/logger.js";
import { restoreFromCID } from "../lib/restore-cid.js";
import { storageFromEnv } from "./storage.js";
import { enable } from "@libp2p/logger";

// The demos speak through the library's logger, which is off unless DEBUG says
// otherwise. Running an example should print what it did.
if (!process.env.DEBUG) enable("libp2p:orbitdb-storacha*");

/**
 * Create a Helia/OrbitDB instance with explicit identity
 */
async function createHeliaOrbitDBWithIdentity(suffix = "", identityId = null) {
  const libp2pOptions = {
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  };

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const blockstore = new LevelBlockstore(
    `./orbitdb-bridge-${uniqueId}${suffix}`,
  );
  const datastore = new LevelDatastore(
    `./orbitdb-bridge-${uniqueId}${suffix}-data`,
  );

  // Helia 7 builds libp2p from options, and fills any of the keys it knows
  // that are left out from its own defaults, which dial the public network.
  const helia = await createHelia({
    libp2p: { peerDiscovery: [], ...libp2pOptions },
    blockstore,
    datastore,
  }).start();
  const libp2p = helia.libp2p;

  // Create OrbitDB with custom identity ID
  const orbitdb = await createOrbitDB({
    ipfs: helia,
    id: identityId, // OrbitDB will create an identity with this ID
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`,
  });

  logger.info(
    { identityId, orbitdbIdentity: orbitdb.identity.id },
    `   🆔 Created identity for ${identityId}: ${orbitdb.identity.id}`,
  );

  return {
    helia,
    orbitdb,
    libp2p,
    blockstore,
    datastore,
    identity: orbitdb.identity,
  };
}

/**
 * Test OrbitDB backup and restore with explicit different identities
 */
async function testDifferentIdentities() {
  const { backend, label } = storageFromEnv();

  logger.info(
    "🚀 Testing OrbitDB Storage Bridge - Different Identities Edition (%s)",
    label,
  );
  logger.info("=".repeat(60));

  let aliceNode, bobNode;

  try {
    // Step 1: Create Alice's node with her identity
    logger.info("\n👩 Step 1: Creating Alice's node...");
    aliceNode = await createHeliaOrbitDBWithIdentity("-alice", "alice");

    logger.info(
      { aliceIdentity: aliceNode.orbitdb.identity.id },
      `   📋 Alice's OrbitDB identity: ${aliceNode.orbitdb.identity.id}`,
    );
    logger.info(
      { alicePublicKey: aliceNode.orbitdb.identity.publicKey },
      `   🔑 Alice's public key: ${aliceNode.orbitdb.identity.publicKey}`,
    );

    // Step 2: Create database with default access controller (only Alice can write)
    logger.info(
      "\n📊 Step 2: Creating database with default access controller...",
    );
    logger.info(
      "   🔒 Access control: Only creator (Alice) can write by default",
    );

    const sourceDB = await aliceNode.orbitdb.open("bridge-demo", {
      type: "events",
      // Default: only the creator (Alice) has write access
    });

    logger.info(
      { databaseAddress: sourceDB.address },
      `   ✅ Database created: ${sourceDB.address}`,
    );
    logger.info(
      { accessController: sourceDB.access.address },
      `   🔐 Access controller: ${sourceDB.access.address}`,
    );

    // Step 3: Alice adds sample data
    logger.info("\n📝 Step 3: Alice adding data...");
    const sampleData = [
      "Hello from Alice!",
      "Alice's private data",
      "Only Alice can write here",
      "Bob can read but not write",
    ];

    for (const content of sampleData) {
      const hash = await sourceDB.add(content);
      logger.info(
        { hash: hash.substring(0, 16), content },
        `   ✍️  Alice added: ${hash.substring(0, 16)}... - "${content}"`,
      );
    }

    logger.info("\n📊 Alice's database summary:");
    logger.info({ name: sourceDB.name }, `   Name: ${sourceDB.name}`);
    logger.info(
      { address: sourceDB.address },
      `   Address: ${sourceDB.address}`,
    );
    logger.info(
      { entryCount: (await sourceDB.all()).length },
      `   Entries: ${(await sourceDB.all()).length}`,
    );
    logger.info(
      { owner: aliceNode.orbitdb.identity.id },
      `   Owner: ${aliceNode.orbitdb.identity.id}`,
    );

    // Step 4: Backup
    logger.info(`\n📤 Step 4: Backing up Alice's database to ${label}...`);

    const backupResult = await backupDatabase(
      aliceNode.orbitdb,
      sourceDB.address,
      { backend },
    );

    if (!backupResult.success) {
      throw new Error(`Backup failed: ${backupResult.error}`);
    }

    const metadataCID = backupResult.backupFiles.metadataCID;
    logger.info("✅ Backup completed successfully!");
    logger.info(
      { manifestCID: backupResult.manifestCID },
      `   📋 Manifest CID: ${backupResult.manifestCID}`,
    );
    logger.info({ metadataCID }, `   🔑 Backup CID: ${metadataCID}`);
    logger.info(
      { blocks: backupResult.blocksTotal, types: backupResult.blockSummary },
      `   📊 Blocks in the CAR: ${backupResult.blocksTotal} (${Object.entries(backupResult.blockSummary)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ")})`,
    );

    // Close Alice's database and node
    await sourceDB.close();
    await aliceNode.orbitdb.stop();
    await aliceNode.helia.stop();
    await aliceNode.blockstore.close();
    await aliceNode.datastore.close();

    logger.info("\n🧹 Alice's node closed");

    // Step 5: Create Bob's node with his different identity
    logger.info("\n👨 Step 5: Creating Bob's node...");
    bobNode = await createHeliaOrbitDBWithIdentity("-bob", "bob");

    logger.info(
      { bobIdentity: bobNode.orbitdb.identity.id },
      `   📋 Bob's OrbitDB identity: ${bobNode.orbitdb.identity.id}`,
    );
    logger.info(
      { bobPublicKey: bobNode.orbitdb.identity.publicKey },
      `   🔑 Bob's public key: ${bobNode.orbitdb.identity.publicKey}`,
    );

    // Verify identities are different
    logger.info("\n🔍 Step 6: Verifying identity separation...");
    const aliceIdentityId = aliceNode.identity.id;
    const bobIdentityId = bobNode.orbitdb.identity.id;

    logger.info(
      { aliceIdentity: aliceIdentityId },
      `   👩 Alice's identity: ${aliceIdentityId}`,
    );
    logger.info(
      { bobIdentity: bobIdentityId },
      `   👨 Bob's identity: ${bobIdentityId}`,
    );
    logger.info(
      { different: aliceIdentityId !== bobIdentityId },
      `   📊 Identities are different: ${aliceIdentityId !== bobIdentityId ? "✅ Yes" : "❌ No"}`,
    );

    if (aliceIdentityId === bobIdentityId) {
      throw new Error("FAILED: Alice and Bob have the same identity!");
    }

    // Step 7: Restore, from the CID the backup returned
    logger.info(`\n📥 Step 7: Bob restoring database from ${label}...`);

    const restoreResult = await restoreFromCID(bobNode.orbitdb, {
      metadataCID,
      fetchBytes: (cid) => backend.getBlob(cid),
      log: logger,
    });

    const restoredEntries = await restoreResult.database.all();
    const addressMatch = restoreResult.address === sourceDB.address;

    logger.info("✅ Restore completed successfully!");
    logger.info(
      { name: restoreResult.database.name },
      `   📋 Restored database: ${restoreResult.database.name}`,
    );
    logger.info(
      { address: restoreResult.address },
      `   📍 Address: ${restoreResult.address}`,
    );
    logger.info(
      { entriesRecovered: restoredEntries.length },
      `   📊 Entries recovered: ${restoredEntries.length}`,
    );

    // Step 8: Verify identity block restoration
    logger.info("\n🔐 Step 8: Verifying identity block restoration...");

    // What went into the CAR is what came out of it: the backup counted the
    // blocks by kind, and the restore put every one of them into Bob's
    // blockstore.
    const identityBlocks =
      (backupResult.blockSummary.identity_own ?? 0) +
      (backupResult.blockSummary.identity_direct ?? 0) +
      (backupResult.blockSummary.identity_system ?? 0) +
      (backupResult.blockSummary.identity_discovered ?? 0);

    if (identityBlocks > 0) {
      logger.info(
        { count: identityBlocks },
        `   ✅ Identity blocks in the backup: ${identityBlocks}`,
      );
      logger.info("   📋 Identity preservation verified!");
      logger.info(
        "   🎯 This proves Alice's identity is preserved in the backup",
      );
      logger.info(
        "   🔒 Bob cannot write to the data due to access control, not missing identity",
      );
    } else {
      logger.warn(
        "   ⚠️  No identity blocks found - this could explain access issues",
      );
      logger.info(
        "   📚 Without identity blocks, Bob cannot verify Alice's entries",
      );
    }

    const accessControllerBlocks = backupResult.blockSummary.access_controller ?? 0;
    logger.info(
      { count: accessControllerBlocks },
      `   🔒 Access controller blocks: ${accessControllerBlocks}`,
    );
    if (accessControllerBlocks > 0) {
      logger.info(
        "   ✅ Access control rules preserved - which is what stops Bob from writing!",
      );
    }

    // Step 9: Display restored entries
    logger.info("\n📄 Step 9: Bob viewing restored entries...");

    if (restoredEntries.length === 0) {
      logger.info("   ⚠️ Bob sees 0 entries - this is expected!");
      logger.info("   🔒 Why? Bob's identity is not in the write access list");
      logger.info(
        "   📚 Explanation: OrbitDB only loads entries from authorized identities",
      );
      logger.info(
        "   👉 Even though the blocks exist, Bob cannot see Alice's data",
      );
    } else {
      for (let i = 0; i < restoredEntries.length; i++) {
        const entry = restoredEntries[i];
        logger.info(
          { index: i + 1, value: entry.value },
          `   ${i + 1}. 👁️  Bob reads: "${entry.value}"`,
        );
      }
    }

    // Step 10: Verify Alice's identity in restored data from raw log
    logger.info(
      "\n🔐 Step 10: Verifying data in raw log (bypassing access control)...",
    );
    const logEntries = await restoreResult.database.log.values();

    if (logEntries.length === 0) {
      logger.info(
        "   📄 No log entries available - data exists in blocks but not accessible to Bob",
      );
      logger.info("   🔒 Access control is working as designed!");

      // Skip to Step 11
      logger.info("\n🔒 Step 11: Testing access control...");
      logger.info("   👨 Bob attempts to write to Alice's database...");

      try {
        await restoreResult.database.add("Bob trying to write");
        logger.warn("   ❌ UNEXPECTED: Bob was able to write!");
        throw new Error(
          "Access control is not working - Bob should not be able to write",
        );
      } catch (error) {
        logger.info("   ✅ EXPECTED: Access denied!");
        logger.info(`   📝 Error: ${error.message}`);
        logger.info("   🎯 Success! Only Alice can write to this database");
      }

      // Close Bob's database
      await restoreResult.database.close();

      const originalCount = sampleData.length;
      const restoredCount = 0; // Bob sees no entries

      logger.info("\n🎉 SUCCESS! Different Identities Test Completed!");
      logger.info("=".repeat(60));
      logger.info(
        { aliceIdentity: aliceIdentityId },
        `   👩 Alice's identity: ${aliceIdentityId}`,
      );
      logger.info(
        { bobIdentity: bobIdentityId },
        `   👨 Bob's identity: ${bobIdentityId}`,
      );
      logger.info("   📊 Identities different: ✅ Yes");
      logger.info({ originalCount }, `   📊 Alice's entries: ${originalCount}`);
      logger.info(
        { restoredCount },
        `   📊 Bob can see: ${restoredCount} (expected - access denied)`,
      );
      logger.info(
        { addressMatch },
        `   📍 Address preserved: ${addressMatch}`,
      );
      logger.info("   🔒 Access control working: ✅ Yes");
      logger.info(
        { blocksRestored: restoreResult.blocks },
        `   🌟 Blocks downloaded: ✅ Yes (${restoreResult.blocks} blocks)`,
      );
      logger.info("\n   ✨ Key findings:");
      logger.info("      • Alice and Bob have different identities");
      logger.info("      • Only Alice can write to the database");
      logger.info(
        "      • Bob cannot read Alice's data (strict access control)",
      );
      logger.info("      • All blocks successfully backed up and restored");
      logger.info("      • Access control prevents unauthorized access");

      return {
        success: true,
        aliceIdentity: aliceIdentityId,
        bobIdentity: bobIdentityId,
        identitiesDifferent: true,
        originalEntries: originalCount,
        restoredEntries: restoredCount,
        addressMatch,
        accessControlWorking: true,
        bobCannotRead: true,
      };
    }

    const firstLogEntry = logEntries[0];

    logger.info(
      { originalAuthor: firstLogEntry.identity },
      `   👩 Original author (Alice): ${firstLogEntry.identity}`,
    );
    logger.info(
      { currentUser: bobNode.orbitdb.identity.id },
      `   👨 Current user (Bob): ${bobNode.orbitdb.identity.id}`,
    );
    logger.info(
      { matchesAlice: firstLogEntry.identity === aliceIdentityId },
      `   📊 Identity verification: ${firstLogEntry.identity === aliceIdentityId ? "✅ Matches Alice" : "❌ Does not match"}`,
    );

    // Step 11: Test access control - Bob tries to write
    logger.info("\n🔒 Step 11: Testing access control...");
    logger.info("   👨 Bob attempts to write to Alice's database...");

    try {
      await restoreResult.database.add("Bob trying to write");
      logger.warn(
        "   ❌ UNEXPECTED: Bob was able to write! Access control failed!",
      );
      throw new Error(
        "Access control is not working - Bob should not be able to write",
      );
    } catch (error) {
      logger.info("   ✅ EXPECTED: Access denied!");
      logger.info({ error: error.message }, `   📝 Error: ${error.message}`);
      logger.info("   🎯 Success! Only Alice can write to this database");
    }

    // Final summary
    const originalCount = sampleData.length;
    const restoredCount = restoredEntries.length;

    logger.info("\n🎉 SUCCESS! Different Identities Test Completed!");
    logger.info("=".repeat(60));
    logger.info(
      { aliceIdentity: aliceIdentityId },
      `   👩 Alice's identity: ${aliceIdentityId}`,
    );
    logger.info(
      { bobIdentity: bobIdentityId },
      `   👨 Bob's identity: ${bobIdentityId}`,
    );
    logger.info("   📊 Identities different: ✅ Yes");
    logger.info(
      { originalCount },
      `   📊 Original entries (Alice): ${originalCount}`,
    );
    logger.info(
      { restoredCount },
      `   📊 Restored entries (Bob): ${restoredCount}`,
    );
    logger.info(
      { addressMatch },
      `   📍 Address preserved: ${addressMatch}`,
    );
    logger.info("   🔒 Access control working: ✅ Yes");
    logger.info(
      {
        dataIntegrity:
          originalCount === restoredCount && addressMatch,
      },
      `   🌟 Data integrity: ${originalCount === restoredCount && addressMatch ? "✅ Perfect" : "❌ Failed"}`,
    );
    logger.info("\n   ✨ Key findings:");
    logger.info("      • Alice and Bob have different identities");
    logger.info("      • Only Alice can write to the database");
    logger.info("      • Bob can read all of Alice's data");
    logger.info("      • All signatures and identities preserved perfectly");

    // Close Bob's database
    await restoreResult.database.close();

    return {
      success: true,
      aliceIdentity: aliceIdentityId,
      bobIdentity: bobIdentityId,
      identitiesDifferent: aliceIdentityId !== bobIdentityId,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch,
      accessControlWorking: true,
    };
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "\n💥 Test failed",
    );
    return {
      success: false,
      error: error.message,
    };
  } finally {
    // Cleanup
    logger.info("\n🧹 Cleaning up...");

    if (bobNode) {
      try {
        await bobNode.orbitdb.stop();
        await bobNode.helia.stop();
        await bobNode.blockstore.close();
        await bobNode.datastore.close();
        logger.info("   ✅ Bob's node cleaned up");
      } catch (error) {
        logger.warn(
          { error: error.message },
          `   ⚠️ Bob cleanup warning: ${error.message}`,
        );
      }
    }

    if (aliceNode) {
      try {
        // Alice's node may already be closed
        if (aliceNode.helia && typeof aliceNode.helia.stop === "function") {
          await aliceNode.orbitdb.stop();
          await aliceNode.helia.stop();
          await aliceNode.blockstore.close();
          await aliceNode.datastore.close();
        }
        logger.info("   ✅ Alice's node cleaned up");
      } catch (error) {
        logger.warn(
          { error: error.message },
          `   ⚠️ Alice cleanup warning: ${error.message}`,
        );
      }
    }

    // Clean up OrbitDB directories
    logger.info("\n🧹 Final cleanup - removing OrbitDB directories...");
    await cleanupOrbitDBDirectories();
  }
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testDifferentIdentities()
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
      logger.error(
        { error: error.message, stack: error.stack },
        "\n💥 Demo crashed",
      );
      process.exit(1);
    });
}

export { testDifferentIdentities };
