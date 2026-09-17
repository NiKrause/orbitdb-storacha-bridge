/**
 * OrbitDB Storacha Bridge Demo - Shared Identities Edition
 *
 * Demonstrates:
 * - Creating both Alice and Bob identities upfront
 * - Both identities known to both OrbitDB nodes
 * - Alice creates database with both identities in write access
 * - Testing if Bob can read Alice's data
 */

// Import dotenv for Node.js environment variable handling
import "dotenv/config";
import {
  backupDatabase,
  restoreDatabaseFromSpace,
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

/**
 * Create shared identities directory and identities
 */
async function createSharedIdentities() {
  const sharedIdentitiesPath = "./orbitdb-shared-identities";
  const identities = await Identities({ path: sharedIdentitiesPath });

  // Create Alice's identity
  const aliceIdentity = await identities.createIdentity({ id: "alice" });
  logger.info(
    { aliceIdentity: aliceIdentity.id },
    `   👩 Created Alice's identity: ${aliceIdentity.id}`,
  );

  // Create Bob's identity
  const bobIdentity = await identities.createIdentity({ id: "bob" });
  logger.info(
    { bobIdentity: bobIdentity.id },
    `   👨 Created Bob's identity: ${bobIdentity.id}`,
  );

  return { identities, aliceIdentity, bobIdentity, sharedIdentitiesPath };
}

/**
 * Create a Helia/OrbitDB instance with specific identity
 */
async function createHeliaOrbitDBWithIdentity(
  suffix = "",
  identity,
  identities,
) {
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

  // Create OrbitDB with the provided identity
  const orbitdb = await createOrbitDB({
    ipfs: helia,
    identity: identity,
    identities: identities, // Share the identities store
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`,
  });

  return { helia, orbitdb, libp2p, blockstore, datastore };
}

/**
 * Test OrbitDB with shared identities
 */
async function testSharedIdentities() {
  logger.info("🚀 Testing OrbitDB Storacha Bridge - Shared Identities Edition");
  logger.info("=".repeat(60));

  let aliceNode, bobNode, sharedIdentities;

  try {
    // Step 1: Create both identities upfront
    logger.info("\n🔑 Step 1: Creating shared identities...");
    sharedIdentities = await createSharedIdentities();
    const { identities, aliceIdentity, bobIdentity, sharedIdentitiesPath } =
      sharedIdentities;

    logger.info(
      { sharedIdentitiesPath },
      `\n   ✅ Both identities created in shared store: ${sharedIdentitiesPath}`,
    );
    logger.info(
      { aliceIdentity: aliceIdentity.id },
      `   👩 Alice: ${aliceIdentity.id}`,
    );
    logger.info(
      { bobIdentity: bobIdentity.id },
      `   👨 Bob: ${bobIdentity.id}`,
    );

    // Step 2: Create Alice's node with her identity
    logger.info("\n👩 Step 2: Creating Alice's node with her identity...");
    aliceNode = await createHeliaOrbitDBWithIdentity(
      "-alice",
      aliceIdentity,
      identities,
    );
    logger.info("   ✅ Alice's OrbitDB created");
    logger.info(
      { aliceOrbitdbIdentity: aliceNode.orbitdb.identity.id },
      `   📋 Alice's OrbitDB identity: ${aliceNode.orbitdb.identity.id}`,
    );

    // Step 3: Create database with BOTH Alice and Bob in write access
    logger.info("\n📊 Step 3: Creating database with write access for BOTH...");
    logger.info("   🔒 Access control: Both Alice AND Bob can write");

    const sourceDB = await aliceNode.orbitdb.open("bridge-demo", {
      type: "events",
      AccessController: IPFSAccessController({
        write: [
          aliceIdentity.id, // Alice can write
          bobIdentity.id, // Bob can also write
        ],
      }),
    });

    logger.info(
      { databaseAddress: sourceDB.address },
      `   ✅ Database created: ${sourceDB.address}`,
    );
    logger.info(
      { accessController: sourceDB.access.address },
      `   🔐 Access controller: ${sourceDB.access.address}`,
    );
    logger.info("   📝 Write access list: [Alice, Bob]");

    // Step 4: Alice adds sample data
    logger.info("\n📝 Step 4: Alice adding data...");
    const sampleData = [
      "Hello from Alice!",
      "Alice's data - Bob should be able to read this",
      "Both have write access",
      "Testing shared access",
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

    // Step 5: Backup database to Storacha
    logger.info("\n📤 Step 5: Backing up Alice's database to Storacha...");

    const backupResult = await backupDatabase(
      aliceNode.orbitdb,
      sourceDB.address,
      {
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
      },
    );

    if (!backupResult.success) {
      throw new Error(`Backup failed: ${backupResult.error}`);
    }

    logger.info("✅ Backup completed successfully!");
    logger.info(
      { manifestCID: backupResult.manifestCID },
      `   📋 Manifest CID: ${backupResult.manifestCID}`,
    );
    logger.info(
      {
        uploaded: backupResult.blocksUploaded,
        total: backupResult.blocksTotal,
      },
      `   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`,
    );

    // Close Alice's database and node
    await sourceDB.close();
    await aliceNode.orbitdb.stop();
    await aliceNode.helia.stop();
    await aliceNode.blockstore.close();
    await aliceNode.datastore.close();

    logger.info("\n🧹 Alice's node closed");

    // Step 6: Create Bob's node with his identity (using same identities store)
    logger.info("\n👨 Step 6: Creating Bob's node with his identity...");
    bobNode = await createHeliaOrbitDBWithIdentity(
      "-bob",
      bobIdentity,
      identities,
    );
    logger.info("   ✅ Bob's OrbitDB created");
    logger.info(
      { bobOrbitdbIdentity: bobNode.orbitdb.identity.id },
      `   📋 Bob's OrbitDB identity: ${bobNode.orbitdb.identity.id}`,
    );

    // Verify identities are different
    logger.info("\n🔍 Step 7: Verifying identities...");
    logger.info(
      { aliceIdentity: aliceIdentity.id },
      `   👩 Alice's identity: ${aliceIdentity.id}`,
    );
    logger.info(
      { bobIdentity: bobIdentity.id },
      `   👨 Bob's identity: ${bobIdentity.id}`,
    );
    logger.info(
      { different: aliceIdentity.id !== bobIdentity.id },
      `   📊 Identities are different: ${aliceIdentity.id !== bobIdentity.id ? "✅ Yes" : "❌ No"}`,
    );
    logger.info("   🔑 Both identities in shared store: ✅ Yes");
    logger.info("   🔐 Bob's identity in write list: ✅ Yes");

    // Step 8: Restore database from Storacha
    logger.info("\n📥 Step 8: Bob restoring database from Storacha...");

    const restoreResult = await restoreDatabaseFromSpace(bobNode.orbitdb, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
    });

    if (!restoreResult.success) {
      throw new Error(`Restore failed: ${restoreResult.error}`);
    }

    logger.info("✅ Restore completed successfully!");
    logger.info(
      { name: restoreResult.name },
      `   📋 Restored database: ${restoreResult.name}`,
    );
    logger.info(
      { address: restoreResult.address },
      `   📍 Address: ${restoreResult.address}`,
    );
    logger.info(
      { entriesRecovered: restoreResult.entriesRecovered },
      `   📊 Entries recovered: ${restoreResult.entriesRecovered}`,
    );
    logger.info(
      { blocksRestored: restoreResult.blocksRestored },
      `   🔄 Blocks restored: ${restoreResult.blocksRestored}`,
    );

    // Step 9: Verify identity block restoration
    logger.info("\n🔐 Step 9: Verifying identity block restoration...");

    if (restoreResult.analysis && restoreResult.analysis.identityBlocks) {
      logger.info(
        { count: restoreResult.analysis.identityBlocks.length },
        `   ✅ Identity blocks restored: ${restoreResult.analysis.identityBlocks.length}`,
      );

      if (restoreResult.analysis.identityBlocks.length > 0) {
        logger.info("   📋 Identity preservation verified!");
        restoreResult.analysis.identityBlocks.forEach((block, i) => {
          logger.info(
            { index: i + 1, cid: block.cid },
            `      ${i + 1}. ${block.cid} (Identity block)`,
          );
        });
        logger.info(
          "   🎯 This ensures Alice's identity is preserved across nodes",
        );
      } else {
        logger.warn(
          "   ⚠️  No identity blocks found - this could affect cross-node access",
        );
        logger.info(
          "   📚 Without identity blocks, Bob may not be able to verify Alice's identity",
        );
      }
    } else {
      logger.warn("   ❌ No analysis data available for identity verification");
      logger.info(
        "   📊 This suggests the restore process may not have captured identity metadata",
      );
    }

    // Also check access controller blocks
    if (
      restoreResult.analysis &&
      restoreResult.analysis.accessControllerBlocks
    ) {
      logger.info(
        { count: restoreResult.analysis.accessControllerBlocks.length },
        `   🔒 Access controller blocks: ${restoreResult.analysis.accessControllerBlocks.length}`,
      );
      if (restoreResult.analysis.accessControllerBlocks.length > 0) {
        logger.info("   ✅ Access control configuration preserved!");
      }
    }

    // Step 10: Check if Bob can see the entries
    logger.info("\n📄 Step 10: Bob viewing restored entries...");

    if (restoreResult.entries.length === 0) {
      logger.info("   ⚠️ Bob sees 0 entries");
      logger.info("   🤔 Even though Bob is in the write list!");
      logger.info("   📊 This reveals the actual reason for the issue...");

      // Check the raw log
      const logEntries = await restoreResult.database.log.values();
      logger.info(
        { logEntriesCount: logEntries.length },
        `   📝 Raw log entries: ${logEntries.length}`,
      );

      if (logEntries.length > 0) {
        logger.info("   ✅ Entries exist in log!");
        logger.info(
          { firstEntryAuthor: logEntries[0].identity },
          "   🔍 First entry author",
        );
        logger.info(
          "   📚 Issue is likely in database.all() layer, not access control",
        );
      }
    } else {
      logger.info(
        { entriesCount: restoreResult.entries.length },
        `   ✅ Bob sees ${restoreResult.entries.length} entries!`,
      );
      for (let i = 0; i < restoreResult.entries.length; i++) {
        const entry = restoreResult.entries[i];
        logger.info(
          { index: i + 1, value: entry.value },
          `   ${i + 1}. 👁️  Bob reads: "${entry.value}"`,
        );
      }
    }

    // Step 11: Test if Bob can write
    logger.info("\n✍️  Step 11: Testing if Bob can write...");

    try {
      const bobEntry = await restoreResult.database.add("Message from Bob");
      logger.info("   ✅ Bob successfully wrote an entry!");
      logger.info(
        { entryHash: bobEntry.substring(0, 16) },
        `   📝 Bob's entry hash: ${bobEntry.substring(0, 16)}...`,
      );

      const allEntriesNow = await restoreResult.database.all();
      logger.info(
        { totalEntries: allEntriesNow.length },
        `   📊 Total entries now: ${allEntriesNow.length}`,
      );
    } catch (error) {
      logger.warn(
        { error: error.message },
        `   ❌ Bob could not write: ${error.message}`,
      );
    }

    // Close Bob's database
    await restoreResult.database.close();

    // Final summary
    const originalCount = sampleData.length;
    const restoredCount = restoreResult.entriesRecovered;

    logger.info("\n🎉 Test Completed!");
    logger.info("=".repeat(60));
    logger.info(
      { aliceIdentity: aliceIdentity.id },
      `   👩 Alice's identity: ${aliceIdentity.id}`,
    );
    logger.info(
      { bobIdentity: bobIdentity.id },
      `   👨 Bob's identity: ${bobIdentity.id}`,
    );
    logger.info("   📊 Identities different: ✅ Yes");
    logger.info("   🔑 Identities shared: ✅ Yes");
    logger.info({ originalCount }, `   📊 Alice's entries: ${originalCount}`);
    logger.info({ restoredCount }, `   📊 Bob can see: ${restoredCount}`);
    logger.info(
      { addressMatch: restoreResult.addressMatch },
      `   📍 Address preserved: ${restoreResult.addressMatch}`,
    );
    logger.info("   🔒 Both in write list: ✅ Yes");
    logger.info("\n   ✨ Key findings:");
    logger.info("      • Alice and Bob have different identities");
    logger.info("      • Both identities stored in shared keystore");
    logger.info("      • Both identities in write access list");
    logger.info("      • This tests if shared identities solve the issue");

    // Close identities keystore
    await identities.keystore.close();

    return {
      success: true,
      aliceIdentity: aliceIdentity.id,
      bobIdentity: bobIdentity.id,
      identitiesDifferent: true,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      sharedIdentities: true,
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
  testSharedIdentities()
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

export { testSharedIdentities };
