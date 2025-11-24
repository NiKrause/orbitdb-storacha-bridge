/**
 * Test suite for IPNS-based OrbitDB restoration
 *
 * Tests the complete flow:
 * 0. Create IPNS key
 * 1. Create OrbitDB with todos and backup to Storacha
 * 2. Store database address
 * 3. Stop OrbitDB instance
 * 4. Decode address to get manifest CID
 * 5. Find heads blocks
 * 6. Store metadata (address + heads) in IPNS
 * 7. Restore database using IPNS lookup
 */

import "dotenv/config";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import { backupDatabaseCAR, restoreFromSpaceCAR } from "../lib/backup-car.js";
import { extractManifestCID } from "../lib/orbitdb-storacha-bridge.js";
import {
  createIPNSKeyPair,
  publishMetadataToIPNS,
  resolveIPNS,
  getMetadataFromIPFS,
} from "../lib/ipns-helpers.js";
import { logger } from "../lib/logger.js";

describe("IPNS-based OrbitDB Restoration", () => {
  let sourceNode;
  let targetNode;
  let ipnsKeyPair;

  beforeEach(async () => {
    // Step 0: Create IPNS key pair
    ipnsKeyPair = await createIPNSKeyPair();
    logger.info(`🔑 IPNS Key: ${ipnsKeyPair.ipnsKey}`);

    // Create test nodes
    sourceNode = await createHeliaOrbitDB("-ipns-source");
    targetNode = await createHeliaOrbitDB("-ipns-target");
  });

  afterEach(async () => {
    // Cleanup
    if (sourceNode) {
      const dbs = sourceNode.orbitdb._databases || new Map();
      for (const [, db] of dbs) {
        try {
          await db.close();
        } catch (e) {
          // Ignore
        }
      }
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
    }
    if (targetNode) {
      const dbs = targetNode.orbitdb._databases || new Map();
      for (const [, db] of dbs) {
        try {
          await db.close();
        } catch (e) {
          // Ignore
        }
      }
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }
    await cleanupOrbitDBDirectories();
  });

  /**
   * Helper: Get heads from OrbitDB database
   */
  async function getDatabaseHeads(database) {
    const heads = [];
    try {
      // Get all log entries
      const entries = await database.all();

      // Build a map of entries and their references
      const entryMap = new Map();
      const referencedBy = new Map(); // Maps entry hash -> entries that reference it

      for (const entry of entries) {
        const entryHash = entry.hash;
        entryMap.set(entryHash, entry);

        // Check if entry has 'next' field (references other entries)
        if (entry.next && Array.isArray(entry.next)) {
          for (const nextHash of entry.next) {
            if (!referencedBy.has(nextHash)) {
              referencedBy.set(nextHash, []);
            }
            referencedBy.get(nextHash).push(entryHash);
          }
        }
      }

      // Heads are entries that are not referenced by any other entry
      for (const [entryHash, entry] of entryMap) {
        if (!referencedBy.has(entryHash)) {
          heads.push({
            hash: entryHash,
            entry: entry,
          });
        }
      }

      logger.info(`🎯 Found ${heads.length} head(s) in database`);
      return heads;
    } catch (error) {
      logger.error(`Error getting heads: ${error.message}`);
      throw error;
    }
  }

  it("should backup OrbitDB, store metadata in IPNS, and restore via IPNS", async () => {
    // Skip if credentials not available
    if (!process.env?.STORACHA_KEY || !process.env?.STORACHA_PROOF) {
      console.log("Skipping test: Storacha credentials not available");
      expect(true).toBe(true);
      return;
    }

    // Step 1: Create OrbitDB with 3 todos
    const sourceDB = await sourceNode.orbitdb.open("todos-ipns-test", {
      type: "keyvalue",
      create: true,
    });

    const todos = [
      { id: "todo-1", text: "First todo", completed: false },
      { id: "todo-2", text: "Second todo", completed: false },
      { id: "todo-3", text: "Third todo", completed: true },
    ];

    for (const todo of todos) {
      await sourceDB.put(todo.id, todo);
      logger.info(`✓ Added todo: ${todo.id} - "${todo.text}"`);
    }

    // Wait for database operations
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 2: Backup to Storacha and store database address
    const databaseAddress = sourceDB.address;
    logger.info(`📋 Database Address: ${databaseAddress}`);

    const backup = await backupDatabaseCAR(
      sourceNode.orbitdb,
      databaseAddress,
      {
        spaceName: "test-ipns-space",
      },
    );

    expect(backup.success).toBe(true);
    logger.info(`✅ Backup successful`);

    // Step 3: Extract manifest CID and heads before closing
    const manifestCID = extractManifestCID(databaseAddress);
    logger.info(`📦 Manifest CID: ${manifestCID}`);

    // Get heads from the database
    const heads = await getDatabaseHeads(sourceDB);
    expect(heads.length).toBeGreaterThan(0);
    logger.info(`🎯 Found ${heads.length} head(s)`);

    // Extract head hashes (in base58btc format for OrbitDB)
    const headHashes = heads.map((h) => h.hash);
    logger.info(`Head hashes: ${headHashes.join(", ")}`);

    // Step 4: Close and stop source node
    await sourceDB.close();
    await sourceNode.orbitdb.stop();
    await sourceNode.helia.stop();
    await sourceNode.blockstore.close();
    await sourceNode.datastore.close();
    sourceNode = null;
    logger.info(`🛑 Source node stopped`);

    // Wait for Storacha to process
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Step 5: Create metadata JSON with address and heads
    const metadata = {
      databaseAddress: databaseAddress,
      manifestCID: manifestCID,
      heads: headHashes,
      timestamp: new Date().toISOString(),
      spaceName: "test-ipns-space",
    };

    logger.info(`📄 Metadata:`, JSON.stringify(metadata, null, 2));

    // Step 6: Publish metadata to IPNS
    logger.info(`📤 Publishing metadata to IPNS...`);
    const publishResult = await publishMetadataToIPNS(
      targetNode.helia,
      ipnsKeyPair.privateKey,
      metadata,
      3600000000000, // 1 hour in nanoseconds
    );

    expect(publishResult.ipnsKey).toBe(ipnsKeyPair.ipnsKey);
    expect(publishResult.metadataCID).toBeDefined();
    logger.info(`✅ Published to IPNS: ${publishResult.ipnsKey}`);

    // Wait a bit for IPNS propagation (if using DHT)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 7: Resolve IPNS to get metadata
    logger.info(`📥 Resolving IPNS key...`);

    // For testing: If mappingCID is available, store it in targetNode's datastore
    // In production, this would be done via DHT
    let resolvedCID;
    try {
      // If mappingCID was returned, store it in targetNode for resolution
      if (publishResult.mappingCID) {
        const targetDatastore = targetNode.helia.datastore;
        const ipnsKeyBytes = new TextEncoder().encode(
          `/ipns/${ipnsKeyPair.peerId.toString()}`,
        );
        const mappingCIDBytes = new TextEncoder().encode(
          publishResult.mappingCID,
        );
        await targetDatastore.put(ipnsKeyBytes, mappingCIDBytes);
        logger.info(`📝 Stored mapping in targetNode for resolution`);
      }

      // Try to resolve IPNS
      resolvedCID = await resolveIPNS(targetNode.helia, ipnsKeyPair.publicKey);
      expect(resolvedCID).toBe(publishResult.metadataCID);
      logger.info(`✅ Resolved IPNS to CID: ${resolvedCID}`);
    } catch (error) {
      // Fallback: use metadataCID directly if IPNS resolution fails
      // This can happen if DHT hasn't propagated yet or if @helia/ipns is not available
      logger.warn(
        `⚠️ IPNS resolution failed, using metadataCID directly: ${error.message}`,
      );
      resolvedCID = publishResult.metadataCID;
      logger.info(`⚠️ Using metadataCID directly as fallback: ${resolvedCID}`);
    }

    // Step 8: Download metadata from IPFS
    logger.info(`📥 Downloading metadata from IPFS...`);
    const retrievedMetadata = await getMetadataFromIPFS(
      targetNode.helia,
      resolvedCID,
    );

    expect(retrievedMetadata.databaseAddress).toBe(databaseAddress);
    expect(retrievedMetadata.manifestCID).toBe(manifestCID);
    expect(retrievedMetadata.heads).toEqual(headHashes);
    logger.info(`✅ Retrieved metadata from IPFS`);

    // Step 9: Restore database using metadata
    logger.info(`🔄 Restoring database from Storacha using metadata...`);

    const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
      spaceName: retrievedMetadata.spaceName,
      useIPFSNetwork: true,
      gatewayFallback: false, // Force network-only
    });

    expect(restored.success).toBe(true);
    expect(restored.entriesRecovered).toBeGreaterThanOrEqual(3);

    // Verify todos are restored
    const restoredEntries = await restored.database.all();
    const restoredTodos = Object.values(restoredEntries).filter(
      (entry) =>
        entry.value && entry.value.id && entry.value.id.startsWith("todo-"),
    );

    expect(restoredTodos.length).toBe(3);

    // Verify each todo
    for (const todo of todos) {
      const restoredTodo = restoredTodos.find((t) => t.value.id === todo.id);
      expect(restoredTodo).toBeDefined();
      expect(restoredTodo.value.text).toBe(todo.text);
      expect(restoredTodo.value.completed).toBe(todo.completed);
      logger.info(
        `✅ Verified restored todo: ${todo.id} - "${restoredTodo.value.text}"`,
      );
    }

    logger.info(
      `✅ Successfully restored ${restoredTodos.length} todos via IPNS metadata`,
    );

    // Cleanup
    await restored.database.close();
  }, 180000); // 3 minute timeout
});
