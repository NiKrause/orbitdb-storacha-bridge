/**
 * Test for timestamped backup feature (CAR-based backups)
 */
import "dotenv/config";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import {
  backupDatabaseCAR,
  restoreFromSpaceCAR,
  listAvailableBackups,
} from "../lib/backup-car.js";

describe("Timestamped backups", () => {
  let sourceNode, targetNode;

  beforeEach(async () => {
    // Create test nodes
    sourceNode = await createHeliaOrbitDB("-source");
    targetNode = await createHeliaOrbitDB("-target");
  });

  afterEach(async () => {
    // Wait for any pending operations
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    // Cleanup
    if (sourceNode) {
      // Close all open databases first
      const dbs = sourceNode.orbitdb._databases || new Map();
      for (const [, db] of dbs) {
        try {
          await db.close();
        } catch (e) {
          // Ignore errors if already closed
        }
      }
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
    }
    if (targetNode) {
      // Close all open databases first
      const dbs = targetNode.orbitdb._databases || new Map();
      for (const [, db] of dbs) {
        try {
          await db.close();
        } catch (e) {
          // Ignore errors if already closed
        }
      }
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }
    await cleanupOrbitDBDirectories();
  });

  test("should create timestamped backup files", async () => {
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
    const backup2 = await backupDatabaseCAR(sourceNode.orbitdb, sourceDB.address, {
      spaceName: "test-space",
    });
    expect(backup2.success).toBe(true);
    expect(backup2.method).toBe("car-timestamped");

    // Wait for Storacha to process uploads (eventual consistency)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // List available backups
    const backups = await listAvailableBackups({
      spaceName: "test-space",
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
    
    // Close source database before cleanup
    await sourceDB.close();
  }, 120000); // Long timeout for backup operations + Storacha API calls

  test("should restore from timestamped backup", async () => {
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
    });
    
    expect(backup.success).toBe(true);
    await sourceDB.close();
    
    // Wait longer for Storacha to process and avoid rate limiting
    // When running multiple tests, we need more time to avoid 429 errors
    await new Promise((resolve) => setTimeout(resolve, 8000));

    // Restore to target node
    const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
      spaceName: "test-restore-space",
    });

    expect(restored.success).toBe(true);
    expect(restored.entriesRecovered).toBe(3);
    expect(restored.method).toBe("car-timestamped");
    expect(restored.database).toBeDefined();

    // Verify restored data
    const restoredEntries = await restored.database.all();
    expect(restoredEntries.length).toBe(3);
    expect(restoredEntries.map(e => e.value)).toEqual(
      expect.arrayContaining(["Entry 1", "Entry 2", "Entry 3"])
    );

    // Cleanup
    await restored.database.close();
  }, 120000); // Long timeout for backup + wait + restore operations + rate limit handling
});
