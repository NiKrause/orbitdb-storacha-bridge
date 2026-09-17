/**
 * @fileoverview Timestamped CAR backup tests.
 *
 * Uses the in-memory Storacha service by default to validate timestamped
 * CAR backup listing and restore behavior. Set USE_PRODUCTION_STORACHA=1 with
 * STORACHA_KEY/STORACHA_PROOF to run against production Storacha.
 */
import "dotenv/config";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import {
  backupDatabaseCAR,
  restoreFromSpaceCAR,
  listAvailableBackups,
} from "../lib/backup-car.js";
import {
  startInMemoryStorachaService,
  stopInMemoryStorachaService,
} from "./helpers/in-memory-storacha.js";

describe("Timestamped backups", () => {
  let sourceNode;
  let targetNode;
  let storachaKey;
  let storachaProof;
  let serviceConf;
  let receiptsEndpoint;
  let inMemoryStoracha;
  let useInMemoryStoracha = false;
  let useProductionStoracha = false;

  const getStorachaOptions = () => ({
    storachaKey,
    storachaProof,
    serviceConf,
    receiptsEndpoint,
    gateway:
      useInMemoryStoracha && inMemoryStoracha?.gatewayUrl
        ? inMemoryStoracha.gatewayUrl
        : undefined,
  });

  const getHeliaOptions = () =>
    useInMemoryStoracha
      ? {
          useBootstrap: false,
          useDHT: false,
          autoDial: true,
          minConnections: 1,
          maxConnections: 5,
        }
      : {};

  const connectToInMemoryHelia = async (node, label) => {
    if (!useInMemoryStoracha || !inMemoryStoracha) {
      return;
    }
    const { heliaPeerId, heliaTcpMultiaddr } = inMemoryStoracha;
    if (!heliaPeerId || !heliaTcpMultiaddr) {
      return;
    }

    try {
      const { peerIdFromString } = await import("@libp2p/peer-id");
      const { multiaddr } = await import("@multiformats/multiaddr");
      const { KEEP_ALIVE } = await import("@libp2p/interface");
      const peerId = peerIdFromString(heliaPeerId);
      await node.helia.libp2p.peerStore.patch(peerId, {
        multiaddrs: [multiaddr(heliaTcpMultiaddr)],
        tags: {
          [`${KEEP_ALIVE}-in-memory`]: {
            value: 100,
          },
        },
      });
      await node.helia.libp2p.dial(peerId);
      console.log(
        `🟣 Connected ${label} Helia to in-memory Helia peer ${heliaPeerId}`,
      );
    } catch (error) {
      console.log(
        `🟣 Failed to connect ${label} Helia to in-memory peer: ${error.message}`,
      );
    }
  };

  const closeNode = async (node) => {
    if (!node) {
      return;
    }
    const dbs = node.orbitdb?._databases || new Map();
    for (const [, db] of dbs) {
      try {
        await db.close();
      } catch {
        // Ignore errors if already closed
      }
    }
    if (node.orbitdb) {
      await node.orbitdb.stop();
    }
    if (node.helia) {
      await node.helia.stop();
    }
    if (node.blockstore) {
      await node.blockstore.close();
    }
    if (node.datastore) {
      await node.datastore.close();
    }
  };

  beforeAll(() => {
    useProductionStoracha =
      process.env.USE_PRODUCTION_STORACHA === "1" ||
      process.env.USE_PRODUCTION_STORACHA === "true";
    if (!useProductionStoracha) {
      useInMemoryStoracha = true;
    }
  });

  beforeEach(async () => {
    if (useProductionStoracha) {
      storachaKey = process.env?.STORACHA_KEY;
      storachaProof = process.env?.STORACHA_PROOF;
    } else {
      inMemoryStoracha = await startInMemoryStorachaService();
      storachaKey = inMemoryStoracha.storachaKey;
      storachaProof = inMemoryStoracha.storachaProof;
      serviceConf = inMemoryStoracha.serviceConf;
      receiptsEndpoint = inMemoryStoracha.receiptsEndpoint;
    }

    // Create test nodes
    sourceNode = await createHeliaOrbitDB("-source", getHeliaOptions());
    targetNode = await createHeliaOrbitDB("-target", getHeliaOptions());
    await connectToInMemoryHelia(sourceNode, "source");
    await connectToInMemoryHelia(targetNode, "target");
  });

  afterEach(async () => {
    // Wait for any pending operations
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Cleanup
    await closeNode(sourceNode);
    await closeNode(targetNode);
    await stopInMemoryStorachaService(inMemoryStoracha);
    inMemoryStoracha = null;
    await cleanupOrbitDBDirectories();
  });

  /**
   * @test TimestampedBackupListAndRestore
   * @description Ensures CAR backups are timestamped, discoverable, and restorable
   * without relying on external CID mappings.
   *
   * **Goal:** prove that multiple backups for the same space are uniquely
   * timestamped and that we can restore from the latest metadata CID.
   *
   * **How it works:**
   * 1. Create a source events database and add entries.
   * 2. Extract all OrbitDB blocks (manifest, log entries, access controller,
   *    identity blocks) and write them into a single CAR file.
   * 3. Generate a metadata JSON file that references the CAR CID and includes
   *    `spaceName`, `manifestCID`, and entry counts.
   * 4. Upload both the CAR and metadata to Storacha with timestamped names.
   * 5. List uploads in the space, detect metadata JSON by content, and pick
   *    the newest timestamp to restore from.
   * 6. Restore using the latest metadata CID and verify data was recovered.
   */
  test("should create timestamped backup files", async () => {
    if (useProductionStoracha && (!storachaKey || !storachaProof)) {
      return;
    }

    // Create and populate test database
    const sourceDB = await sourceNode.orbitdb.open("test-backup", {
      type: "events",
    });
    await sourceDB.add("Test entry 1");
    await sourceDB.add("Test entry 2");

    // Wait for database operations to complete and flush to storage
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Save the address
    const dbAddress = sourceDB.address;

    // Create first backup with CAR
    const backup1 = await backupDatabaseCAR(sourceNode.orbitdb, dbAddress, {
      spaceName: "test-space",
      ...getStorachaOptions(),
    });

    // Database is still open - backup function doesn't close it
    expect(backup1.success).toBe(true);
    expect(backup1.method).toBe("car-timestamped");
    expect(backup1.backupFiles).toHaveProperty("metadata");
    expect(backup1.backupFiles).toHaveProperty("blocks");

    // Wait a bit to ensure different timestamps and for operations to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Add more data and create second backup
    await sourceDB.add("Test entry 3");
    const backup2 = await backupDatabaseCAR(
      sourceNode.orbitdb,
      sourceDB.address,
      {
        spaceName: "test-space",
        ...getStorachaOptions(),
      },
    );
    expect(backup2.success).toBe(true);
    expect(backup2.method).toBe("car-timestamped");

    // Wait for Storacha to process uploads (eventual consistency)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // List available backups
    const backups = await listAvailableBackups({
      spaceName: "test-space",
      ...getStorachaOptions(),
    });

    // Should have at least 2 backups (may have more from previous test runs)
    expect(backups.length).toBeGreaterThanOrEqual(2);

    // Check that backups have the correct structure
    for (const backup of backups) {
      expect(backup.metadata).toBeDefined();
      expect(backup.metadataCID).toBeDefined();
      expect(backup.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
      expect(backup.date).toBeDefined();
      expect(backup.metadata.spaceName).toBe("test-space");
    }

    // After listing backups, also verify we can restore from one
    if (backups.length > 0) {
      const latestBackup = backups[0];

      // Create a new node to restore to
      const restoreNode = await createHeliaOrbitDB(
        "-restore-verify",
        getHeliaOptions(),
      );
      await connectToInMemoryHelia(restoreNode, "restore");

      // Restore from the latest backup - use metadataCID instead of timestamp
      // OR find the backup by timestamp first
      const restored = await restoreFromSpaceCAR(restoreNode.orbitdb, {
        spaceName: "test-space",
        // Use metadataCID directly, or let it find latest (don't use timestamp)
        metadataCID: latestBackup.metadataCID,
        reconnectToInMemoryHelia: () =>
          connectToInMemoryHelia(restoreNode, "restore"),
        ...getStorachaOptions(),
      });

      expect(restored.success).toBe(true);

      // Verify restored data matches what we backed up
      const restoredEntries = await restored.database.all();
      expect(restoredEntries.length).toBeGreaterThanOrEqual(2); // At least 2 entries from first backup

      // Cleanup
      await restored.database.close();
      await closeNode(restoreNode);
    }

    // Close source database before cleanup
    await sourceDB.close();
  }, 120000); // Long timeout for backup operations + Storacha API calls

  /**
   * @test TimestampedBackupRestoreLatest
   * @description Restores the most recent timestamped CAR backup from a space.
   *
   * **Goal:** verify that restore locates the newest backup in a space and
   * rebuilds the database with full entry integrity.
   *
   * **How it works:**
   * 1. Create a source events database with known entries.
   * 2. Create a CAR snapshot + metadata JSON and upload both.
   * 3. Restore to a separate target node by space name (latest metadata).
   * 4. Compare restored entries to the original values.
   */
  test("should restore from timestamped backup", async () => {
    if (useProductionStoracha && (!storachaKey || !storachaProof)) {
      return;
    }

    // Create and populate test database
    const sourceDB = await sourceNode.orbitdb.open("test-restore", {
      type: "events",
    });
    await sourceDB.add("Entry 1");
    await sourceDB.add("Entry 2");
    await sourceDB.add("Entry 3");

    // Wait for database operations to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const dbAddress = sourceDB.address;

    // Create backup
    const backup = await backupDatabaseCAR(sourceNode.orbitdb, dbAddress, {
      spaceName: "test-restore-space",
      ...getStorachaOptions(),
    });

    expect(backup.success).toBe(true);
    await sourceDB.close();

    // Wait longer for Storacha to process and avoid rate limiting
    // When running multiple tests, we need more time to avoid 429 errors
    await new Promise((resolve) => setTimeout(resolve, 8000));

    // Restore to target node
    const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
      spaceName: "test-restore-space",
      reconnectToInMemoryHelia: () =>
        connectToInMemoryHelia(targetNode, "target"),
      ...getStorachaOptions(),
    });

    expect(restored.success).toBe(true);
    expect(restored.entriesRecovered).toBe(3);
    expect(restored.method).toBe("car-timestamped");
    expect(restored.database).toBeDefined();

    // Verify restored data
    const restoredEntries = await restored.database.all();

    // Check exact count
    expect(restoredEntries.length).toBe(3);

    // Get original entries for comparison
    const originalEntries = ["Entry 1", "Entry 2", "Entry 3"];

    // Extract values and sort for comparison (order may vary)
    const restoredValues = restoredEntries.map((e) => e.value).sort();
    const expectedValues = [...originalEntries].sort();

    // Verify exact match (same values, same count, no extras)
    expect(restoredValues).toEqual(expectedValues);

    // Verify entry structure (each entry should have proper OrbitDB structure)
    restoredEntries.forEach((entry) => {
      expect(entry).toHaveProperty("value");
      expect(entry).toHaveProperty("hash");
      // Events databases don't have 'id' property, they have 'hash' instead
      // Remove the id check for events databases
      expect(typeof entry.value).toBe("string");
      expect(originalEntries).toContain(entry.value);
      // Verify hash format (OrbitDB format)
      expect(entry.hash).toMatch(/^zdpu/);
    });

    // Verify no duplicates
    const uniqueValues = new Set(restoredValues);
    expect(uniqueValues.size).toBe(restoredValues.length);

    // Cleanup
    await restored.database.close();
  }, 120000); // Long timeout for backup + wait + restore operations + rate limit handling
});
