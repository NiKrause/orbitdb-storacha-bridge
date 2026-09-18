/**
 * OrbitDB Storacha Bridge - Simple Todo Restore Demo
 *
 * Demonstrates how to restore a simple-todo OrbitDB database from Storacha backup
 * connecting to specific relay nodes for peer-to-peer functionality
 *
 * This demo is customized to work with the simple-todo project structure
 */

import "dotenv/config";
import { restoreDatabaseFromSpace } from "../lib/orbitdb-storacha-bridge.js";
import { logger } from "../lib/logger.js";

// Import utilities for creating OrbitDB/Helia instances
import { createHeliaOrbitDB } from "../lib/utils.js";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { gossipsub } from "@libp2p/gossipsub";
import { createHelia } from "helia";
import { createOrbitDB } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import * as filters from "@libp2p/websockets/filters";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { bootstrap } from "@libp2p/bootstrap";

// Relay nodes from simple-todo project
const RELAY_BOOTSTRAP_ADDRESSES = [
  "/dns4/159-69-119-82.k51qzi5uqu5dmesgnxu1wjx2r2rk797fre6yxj284fqhcn2dekq3mar5sz63jx.libp2p.direct/tcp/4002/wss/p2p/12D3KooWSdmKqDDpRftU2ayyGH66svXd3P6zuyH7cMyFV1iXRR4p",
  "/dns6/2a01-4f8-c012-3e86--1.k51qzi5uqu5dmesgnxu1wjx2r2rk797fre6yxj284fqhcn2dekq3mar5sz63jx.libp2p.direct/tcp/4002/wss/p2p/12D3KooWSdmKqDDpRftU2ayyGH66svXd3P6zuyH7cMyFV1iXRR4p",
];

/**
 * Create a Helia/OrbitDB instance configured to connect to simple-todo relay nodes
 */
async function createSimpleTodoOrbitDB(suffix = "") {
  logger.info(
    "📡 Creating libp2p node with simple-todo relay configuration...",
  );

  const libp2pOptions = {
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0", "/ip4/127.0.0.1/tcp/0/ws"],
    },
    transports: [
      tcp(),
      webSockets({
        filter: filters.all,
      }),
      circuitRelayTransport({
        discoverRelays: 2,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: RELAY_BOOTSTRAP_ADDRESSES,
      }),
    ],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true,
      }),
    },
  };

  logger.info("🔧 Setting up Helia with persistent storage...");
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

  logger.info("🛸 Creating OrbitDB instance...");
  const orbitdb = await createOrbitDB({
    ipfs: helia,
    id: "simple-todo-restore-demo",
  });

  logger.info(
    { peerId: libp2p.peerId.toString() },
    `✅ Created OrbitDB instance with peer ID: ${libp2p.peerId.toString()}`,
  );

  return { helia, orbitdb, libp2p, blockstore, datastore };
}

async function runSimpleTodoRestoreDemo() {
  logger.info("🔄 Simple Todo OrbitDB Storacha Bridge - Restore Demo");
  logger.info("=".repeat(60));

  // Check for required environment variables
  if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
    logger.error("❌ Missing Storacha credentials!");
    logger.error(
      "   Please set STORACHA_KEY and STORACHA_PROOF in your .env file",
    );
    logger.info("\n💡 Example .env file:");
    logger.info("   STORACHA_KEY=your_private_key");
    logger.info("   STORACHA_PROOF=your_delegation_proof");
    process.exit(1);
  }

  logger.info("📋 Using relay nodes:");
  RELAY_BOOTSTRAP_ADDRESSES.forEach((addr, i) => {
    logger.info({ index: i + 1, address: addr }, `   ${i + 1}. ${addr}`);
  });

  let targetNode;

  try {
    // Step 1: Create target OrbitDB instance connected to simple-todo relays
    logger.info(
      "\n📡 Creating target OrbitDB instance connected to simple-todo relays...",
    );
    targetNode = await createSimpleTodoOrbitDB("-simple-todo-restore");

    logger.info("\n📋 Restore parameters:");
    logger.info("   Using credentials from .env file");
    logger.info("   Database type: keyvalue (simple-todo format)");
    logger.info("   Expected database name: simple-todos");
    logger.info("   Will discover all files in Storacha space automatically");

    // Give some time for relay connections to establish
    logger.info("\n⏳ Waiting for relay connections to establish...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check connections
    const connections = targetNode.libp2p.getConnections();
    logger.info(
      { connectionCount: connections.length },
      `🔗 Current connections: ${connections.length}`,
    );
    connections.forEach((conn, i) => {
      logger.info(
        { index: i + 1, remoteAddr: conn.remoteAddr.toString() },
        `   ${i + 1}. ${conn.remoteAddr.toString()}`,
      );
    });

    // Step 2: Restore from Storacha using space discovery
    logger.info("\n💾 Starting restore from Storacha space...");
    const restoreResult = await restoreDatabaseFromSpace(targetNode.orbitdb, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      timeout: 120000, // 2 minutes timeout
    });

    if (restoreResult.success) {
      logger.info("\n🎉 Restore completed successfully!");
      logger.info(
        { databaseName: restoreResult.database.name },
        `📋 Database Name: ${restoreResult.database.name}`,
      );
      logger.info(
        { databaseAddress: restoreResult.database.address },
        `📋 Database Address: ${restoreResult.database.address}`,
      );
      logger.info(
        { entriesRecovered: restoreResult.entriesRecovered },
        `📊 Entries recovered: ${restoreResult.entriesRecovered}`,
      );
      logger.info(
        { blocksRestored: restoreResult.blocksRestored },
        `📊 Blocks restored: ${restoreResult.blocksRestored}`,
      );
      logger.info(
        { addressMatch: restoreResult.addressMatch },
        `🔗 Address match: ${restoreResult.addressMatch ? "✅ Perfect" : "❌ Different"}`,
      );

      if (restoreResult.blockSummary) {
        logger.info("📈 Block breakdown:");
        for (const [type, count] of Object.entries(
          restoreResult.blockSummary,
        )) {
          logger.info({ type, count }, `   ${type}: ${count} blocks`);
        }
      }

      // Step 3: Verify restored database with simple-todo structure
      logger.info("\n🔍 Verifying restored simple-todo database...");

      try {
        const restoredDB = await targetNode.orbitdb.open(
          restoreResult.database.address,
        );
        const allEntries = await restoredDB.all();

        logger.info("\n📊 Database verification:");
        logger.info({ name: restoredDB.name }, `   Name: ${restoredDB.name}`);
        logger.info({ type: restoredDB.type }, `   Type: ${restoredDB.type}`);
        logger.info(
          { address: restoredDB.address },
          `   Address: ${restoredDB.address}`,
        );
        logger.info(
          { totalEntries: allEntries.length },
          `   Total entries: ${allEntries.length}`,
        );

        if (allEntries.length > 0) {
          logger.info("\n📄 Sample todo entries:");
          for (const [index, entry] of allEntries.slice(0, 3).entries()) {
            const todo = entry.value || entry;
            logger.info(
              {
                index: index + 1,
                hash: entry.hash.slice(0, 8),
                text: todo.text || "No text",
              },
              `   ${index + 1}. [${entry.hash.slice(0, 8)}...] "${todo.text || "No text"}"`,
            );
            if (todo.completed !== undefined) {
              logger.info(
                { completed: todo.completed },
                `      Status: ${todo.completed ? "✅ Completed" : "⏳ Pending"}`,
              );
            }
            if (todo.createdAt) {
              logger.info(
                { createdAt: new Date(todo.createdAt).toLocaleString() },
                `      Created: ${new Date(todo.createdAt).toLocaleString()}`,
              );
            }
            if (todo.createdBy) {
              logger.info(
                { createdBy: todo.createdBy.slice(0, 12) },
                `      Created by: ${todo.createdBy.slice(0, 12)}...`,
              );
            }
          }

          if (allEntries.length > 3) {
            logger.info(
              { remainingTodos: allEntries.length - 3 },
              `   ... and ${allEntries.length - 3} more todos`,
            );
          }

          // Count completed vs pending
          const completed = allEntries.filter((entry) => {
            const todo = entry.value || entry;
            return todo.completed === true;
          }).length;
          const pending = allEntries.length - completed;

          logger.info("\n📈 Todo statistics:");
          logger.info({ completed }, `   ✅ Completed: ${completed}`);
          logger.info({ pending }, `   ⏳ Pending: ${pending}`);
          logger.info(
            { total: allEntries.length },
            `   📊 Total: ${allEntries.length}`,
          );
        } else {
          logger.warn(
            "   ⚠️  No todos found - database might be empty or restore incomplete",
          );
        }

        // Step 4: Test simple database operations (if it's a keyvalue store)
        logger.info("\n🧪 Testing simple-todo database operations...");

        if (restoredDB.type === "keyvalue") {
          const testTodoId = `test_todo_${Date.now()}`;
          const testTodo = {
            text: `Test todo added after restore - ${new Date().toISOString()}`,
            completed: false,
            createdBy: targetNode.libp2p.peerId.toString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          await restoredDB.put(testTodoId, testTodo);
          logger.info({ testTodoId }, `   ✅ Added test todo: ${testTodoId}`);

          const retrievedTodo = await restoredDB.get(testTodoId);
          logger.info(
            { retrievedText: retrievedTodo.value.text },
            `   ✅ Retrieved test todo: "${retrievedTodo.value.text}"`,
          );

          const updatedEntries = await restoredDB.all();
          logger.info(
            { totalAfterTest: updatedEntries.length },
            `   ✅ Total todos after test: ${updatedEntries.length}`,
          );
        } else {
          logger.info(
            { databaseType: restoredDB.type },
            `   ℹ️  Database type '${restoredDB.type}' - skipping simple-todo specific tests`,
          );
        }
      } catch (error) {
        logger.error(
          { error: error.message },
          "   ❌ Database verification failed",
        );
      }
    } else {
      logger.error({ error: restoreResult.error }, "\n❌ Restore failed");

      if (
        restoreResult.error?.includes("not found") ||
        restoreResult.error?.includes("404")
      ) {
        logger.info("\n💡 Troubleshooting tips:");
        logger.info(
          "   • Make sure you have backed up a simple-todo database to your Storacha space",
        );
        logger.info("   • Try running a backup from the simple-todo app first");
        logger.info("   • Verify your Storacha credentials are correct");
        logger.info(
          "   • Check that your Storacha space contains OrbitDB backup files",
        );
        logger.info("   • Ensure the simple-todo relay nodes are accessible");
      }

      process.exit(1);
    }
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "\n💥 Demo failed",
    );

    if (
      error.message.includes("credentials") ||
      error.message.includes("auth")
    ) {
      logger.info(
        "\n💡 Make sure your .env file contains valid Storacha credentials:",
      );
      logger.info("   STORACHA_KEY=your_private_key");
      logger.info("   STORACHA_PROOF=your_delegation_proof");
    } else if (
      error.message.includes("connection") ||
      error.message.includes("network")
    ) {
      logger.info("\n💡 Network troubleshooting:");
      logger.info("   • Check that the relay nodes are accessible");
      logger.info("   • Verify your internet connection");
      logger.info("   • Try running the demo again in a few minutes");
    }

    process.exit(1);
  } finally {
    // Cleanup
    if (targetNode) {
      try {
        logger.info("\n🧹 Cleaning up connections and storage...");
        await targetNode.orbitdb.stop();
        await targetNode.helia.stop();
        await targetNode.blockstore.close();
        await targetNode.datastore.close();
        logger.info("✅ Cleanup completed");
      } catch (error) {
        logger.warn({ error: error.message }, "⚠️ Cleanup warning");
      }
    }
  }
}

// Show usage information
function showUsage() {
  logger.info("\n📚 Simple Todo OrbitDB Storacha Bridge - Restore Demo");
  logger.info(
    "\nThis demo shows how to restore a simple-todo OrbitDB database from Storacha backup.",
  );
  logger.info(
    "It connects to the simple-todo relay nodes for peer-to-peer functionality.",
  );
  logger.info("\nUsage:");
  logger.info("  node simple-todo-restore-demo.js");
  logger.info("\nPrerequisites:");
  logger.info("  1. Set up your .env file with Storacha credentials");
  logger.info(
    "  2. Have a simple-todo database backed up in your Storacha space",
  );
  logger.info("\nRelay nodes used:");
  RELAY_BOOTSTRAP_ADDRESSES.forEach((addr, i) => {
    logger.info({ index: i + 1, address: addr }, `  ${i + 1}. ${addr}`);
  });
  logger.info("\nWhat this demo does:");
  logger.info(
    "  • Creates OrbitDB instance connected to simple-todo relay nodes",
  );
  logger.info(
    "  • Automatically discovers backup files in your Storacha space",
  );
  logger.info(
    "  • Downloads and reconstructs the database with perfect hash preservation",
  );
  logger.info("  • Verifies simple-todo data structure and functionality");
  logger.info("  • Tests basic todo database operations");
}

// Handle help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  showUsage();
  process.exit(0);
}

// Run demo
runSimpleTodoRestoreDemo();
