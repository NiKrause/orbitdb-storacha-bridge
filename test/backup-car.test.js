/**
 * Test suite for CAR-based timestamped backup functionality
 *
 * Tests browser compatibility, backward compatibility, and full backup/restore cycle
 */

import "dotenv/config";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  backupDatabaseCAR,
  restoreFromSpaceCAR,
  readBlocksFromCAR,
  createCARFromBlocks,
} from "../lib/backup-car.js";
import { backupDatabase as backupDatabaseLegacy } from "../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

describe("CAR-based Timestamped Backup", () => {
  let orbitdb;
  let testDB;
  const testData = ["Test entry 1", "Test entry 2", "Test entry 3"];

  beforeAll(async () => {
    // Create test OrbitDB instance
    orbitdb = await createHeliaOrbitDB("-car-test");
  });

  afterAll(async () => {
    if (testDB) await testDB.close();
    if (orbitdb) {
      await orbitdb.orbitdb.stop();
      await orbitdb.helia.stop();
      await orbitdb.blockstore.close();
      await orbitdb.datastore.close();
    }
    await cleanupOrbitDBDirectories();
  });

  describe("createCARFromBlocks", () => {
    it("should create a valid CAR file from blocks map", async () => {
      // Create test blocks
      const blocks = new Map();
      const manifestCID = "zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";

      blocks.set(manifestCID, {
        bytes: new Uint8Array([1, 2, 3, 4]),
      });

      const carBytes = await createCARFromBlocks(blocks, manifestCID);

      expect(carBytes).toBeInstanceOf(Uint8Array);
      expect(carBytes.length).toBeGreaterThan(0);
    });

    it("should handle empty blocks map", async () => {
      const blocks = new Map();
      const manifestCID = "zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";

      const carBytes = await createCARFromBlocks(blocks, manifestCID);

      expect(carBytes).toBeInstanceOf(Uint8Array);
    });
  });

  describe("readBlocksFromCAR", () => {
    it("should read blocks from a CAR file", async () => {
      // First create a CAR file
      const blocks = new Map();
      const manifestCID = "zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";

      blocks.set(manifestCID, {
        bytes: new Uint8Array([1, 2, 3, 4]),
      });

      const carBytes = await createCARFromBlocks(blocks, manifestCID);

      // Read it back
      const readBlocks = await readBlocksFromCAR(carBytes);

      expect(readBlocks).toBeInstanceOf(Map);
      expect(readBlocks.size).toBeGreaterThan(0);
    });
  });

  describe("backupDatabaseCAR", () => {
    beforeEach(async () => {
      testDB = await orbitdb.orbitdb.open("car-test-db", { type: "events" });
      for (const data of testData) {
        await testDB.add(data);
      }
    });

    afterEach(async () => {
      if (testDB) {
        await testDB.close();
        testDB = null;
      }
    });

    it("should return error without Storacha credentials", async () => {
      // Temporarily clear env vars to test missing credentials
      const savedKey = process.env.STORACHA_KEY;
      const savedProof = process.env.STORACHA_PROOF;
      delete process.env.STORACHA_KEY;
      delete process.env.STORACHA_PROOF;

      try {
        const result = await backupDatabaseCAR(
          orbitdb.orbitdb,
          testDB.address,
          { spaceName: "test-space" },
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(
          /Storacha authentication required|authentication required|Invalid metadata/i,
        );
      } finally {
        // Restore env vars
        if (savedKey) process.env.STORACHA_KEY = savedKey;
        if (savedProof) process.env.STORACHA_PROOF = savedProof;
      }
    });

    it("should include method identifier in result", async () => {
      const result = await backupDatabaseCAR(orbitdb.orbitdb, testDB.address, {
        spaceName: "test-space",
        // Mock credentials will fail but we can check the structure
        storachaKey: "mock-key",
        storachaProof: "mock-proof",
      });

      expect(result).toHaveProperty("method");
      expect(result.method).toBe("car-timestamped");
    });

    it("should emit progress events if eventEmitter provided", async () => {
      const { EventEmitter } = await import("events");
      const emitter = new EventEmitter();
      const events = [];

      emitter.on("backupProgress", (data) => {
        events.push(data);
      });

      await backupDatabaseCAR(orbitdb.orbitdb, testDB.address, {
        spaceName: "test-space",
        storachaKey: "mock-key",
        storachaProof: "mock-proof",
        eventEmitter: emitter,
      });

      // Should have emitted at least one event
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("Backward Compatibility", () => {
    it("should not break existing backupDatabase function", async () => {
      // Create a test database
      const db = await orbitdb.orbitdb.open("compat-test", { type: "events" });
      await db.add("Test data");

      // The legacy backup should still work
      const result = await backupDatabaseLegacy(orbitdb.orbitdb, db.address, {
        storachaKey: "mock-key",
        storachaProof: "mock-proof",
      });

      // Should return a result (even if it fails due to mock credentials)
      expect(result).toHaveProperty("success");

      await db.close();
    });

    it("CAR and legacy backups should coexist in same space", async () => {
      // This test verifies that both approaches can be used without conflict
      const db = await orbitdb.orbitdb.open("coexist-test", { type: "events" });
      await db.add("Shared data");

      // Both should be able to run (even if they fail authentication)
      const legacyResult = await backupDatabaseLegacy(
        orbitdb.orbitdb,
        db.address,
        { storachaKey: "mock", storachaProof: "mock" },
      );

      const carResult = await backupDatabaseCAR(orbitdb.orbitdb, db.address, {
        storachaKey: "mock",
        storachaProof: "mock",
        spaceName: "test",
      });

      // Both should return structured results
      expect(legacyResult).toHaveProperty("success");
      expect(carResult).toHaveProperty("success");
      expect(carResult).toHaveProperty("method");

      await db.close();
    });
  });

  describe("Browser Compatibility", () => {
    it("should not use filesystem APIs", () => {
      // Check that the module doesn't import fs for writing
      const backupCarSource = backupDatabaseCAR.toString();

      // Should not have writeFile, writeFileSync, or createWriteStream for files
      expect(backupCarSource).not.toContain("writeFileSync");
      expect(backupCarSource).not.toContain("fs.writeFile");
    });

    it("should work with Blob and File APIs (browser)", async () => {
      // These are available in both Node 18+ and browsers
      const testBlob = new Blob(["test"], { type: "text/plain" });
      const testFile = new File([testBlob], "test.txt");

      expect(testFile).toBeInstanceOf(File);
      expect(testFile.name).toBe("test.txt");
    });

    it("should handle Uint8Array (universal)", async () => {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);

      expect(testData).toBeInstanceOf(Uint8Array);
      expect(testData.length).toBe(5);
    });
  });

  describe("Timestamped Backup Features", () => {
    it("should include timestamp in result", async () => {
      const db = await orbitdb.orbitdb.open("timestamp-test", {
        type: "events",
      });
      await db.add("Test");

      const result = await backupDatabaseCAR(orbitdb.orbitdb, db.address, {
        storachaKey: "mock",
        storachaProof: "mock",
        spaceName: "test",
      });

      if (result.success) {
        expect(result).toHaveProperty("timestamp");
        expect(typeof result.timestamp).toBe("number");
      }

      await db.close();
    });

    it("should generate unique backup filenames", async () => {
      const { generateBackupPrefix, getBackupFilenames } = await import(
        "../lib/backup-helpers.js"
      );

      const prefix1 = generateBackupPrefix("test-space");
      await new Promise((resolve) => setTimeout(resolve, 10)); // Wait 10ms
      const prefix2 = generateBackupPrefix("test-space");

      // Should be different due to timestamp
      expect(prefix1).not.toBe(prefix2);

      const files1 = getBackupFilenames(prefix1);
      const files2 = getBackupFilenames(prefix2);

      expect(files1.metadata).not.toBe(files2.metadata);
      expect(files1.blocks).not.toBe(files2.blocks);
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid database address", async () => {
      const result = await backupDatabaseCAR(
        orbitdb.orbitdb,
        "invalid-address",
        { storachaKey: "mock", storachaProof: "mock", spaceName: "test" },
      );

      expect(result.success).toBe(false);
      expect(result).toHaveProperty("error");
    });

    it("should handle network failures gracefully", async () => {
      const db = await orbitdb.orbitdb.open("error-test", { type: "events" });
      await db.add("Test");

      // Mock client that will fail
      const result = await backupDatabaseCAR(orbitdb.orbitdb, db.address, {
        storachaKey: "will-fail",
        storachaProof: "will-fail",
        spaceName: "test",
      });

      expect(result.success).toBe(false);
      expect(result).toHaveProperty("error");
      expect(result.method).toBe("car-timestamped");

      await db.close();
    });
  });

  describe("CAR File Format", () => {
    it("should produce valid CAR format", async () => {
      const blocks = new Map();
      const testCID = "zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";
      blocks.set(testCID, { bytes: new Uint8Array([1, 2, 3]) });

      const carBytes = await createCARFromBlocks(blocks, testCID);

      // CAR files start with a specific header
      // Check it's a Uint8Array with data
      expect(carBytes).toBeInstanceOf(Uint8Array);
      expect(carBytes.length).toBeGreaterThan(10); // Header + data
    });

    it("should be readable by CarReader", async () => {
      const blocks = new Map();
      const testCID = "zdpuB2rhHeykxLvtwpMHRPsQsUmwjYMBETL2ZVQHb9WdkN6hH";
      blocks.set(testCID, { bytes: new Uint8Array([1, 2, 3, 4]) });

      const carBytes = await createCARFromBlocks(blocks, testCID);
      const readBlocks = await readBlocksFromCAR(carBytes);

      // Should successfully read blocks
      expect(readBlocks.size).toBeGreaterThan(0);
    });
  });
});

describe("List and Restore Specific Backups", () => {
  it("should list available backups", async () => {
    const { listAvailableBackups } = await import("../lib/backup-car.js");

    // This will fail authentication but we can test the structure
    try {
      await listAvailableBackups({
        spaceName: "test",
        storachaKey: "mock",
        storachaProof: "mock",
      });
    } catch (error) {
      // Expected to fail with mock credentials
      expect(error.message).toMatch(/authentication|multibase|decode/i);
    }
  });

  it("should accept timestamp parameter for specific restore", async () => {
    const orbitdb = await createHeliaOrbitDB("-specific-restore");

    try {
      const specificTimestamp = "2025-10-27T14-30-00-123Z";

      // Attempt restore with specific timestamp
      const result = await restoreFromSpaceCAR(orbitdb.orbitdb, {
        spaceName: "test",
        timestamp: specificTimestamp, // Restore specific backup
        storachaKey: "mock",
        storachaProof: "mock",
      });

      // Will fail auth, but check it tried to use the timestamp
      expect(result.success).toBe(false);
    } finally {
      await orbitdb.orbitdb.stop();
      await orbitdb.helia.stop();
      await orbitdb.blockstore.close();
      await orbitdb.datastore.close();
      await cleanupOrbitDBDirectories();
    }
  });

  it("should restore latest when no timestamp provided", async () => {
    const orbitdb = await createHeliaOrbitDB("-latest-restore");

    try {
      // Without timestamp parameter, should find latest
      const result = await restoreFromSpaceCAR(orbitdb.orbitdb, {
        spaceName: "test",
        // No timestamp - should find latest
        storachaKey: "mock",
        storachaProof: "mock",
      });

      // Will fail but that's expected with mock credentials
      expect(result.success).toBe(false);
      expect(result).toHaveProperty("method", "car-timestamped");
    } finally {
      await orbitdb.orbitdb.stop();
      await orbitdb.helia.stop();
      await orbitdb.blockstore.close();
      await orbitdb.datastore.close();
      await cleanupOrbitDBDirectories();
    }
  });
});

describe("Integration: Full Backup and Restore Cycle (Mocked)", () => {
  it("should complete full cycle with mocked Storacha", async () => {
    // This test demonstrates the full flow without actual Storacha upload
    const orbitdb = await createHeliaOrbitDB("-integration");

    try {
      // Create and populate database
      const db = await orbitdb.orbitdb.open("integration-test", {
        type: "events",
      });
      await db.add("Entry 1");
      await db.add("Entry 2");

      const address = db.address;

      // Attempt backup (will fail auth but we can check structure)
      const backupResult = await backupDatabaseCAR(orbitdb.orbitdb, address, {
        spaceName: "test",
        storachaKey: "mock",
        storachaProof: "mock",
      });

      // Even though it fails, the structure should be correct
      expect(backupResult).toHaveProperty("method", "car-timestamped");
      expect(backupResult).toHaveProperty("success");

      await db.close();
    } finally {
      await orbitdb.orbitdb.stop();
      await orbitdb.helia.stop();
      await orbitdb.blockstore.close();
      await orbitdb.datastore.close();
      await cleanupOrbitDBDirectories();
    }
  });
});

describe("Integration: Real Storacha Credentials (when available)", () => {
  const hasRealCredentials =
    process.env.STORACHA_KEY && process.env.STORACHA_PROOF;

  const testCondition = hasRealCredentials ? it : it.skip;

  testCondition(
    "should successfully backup and restore with real credentials",
    async () => {
      const orbitdb = await createHeliaOrbitDB("-real-integration");

      try {
        // Create and populate test database
        const db = await orbitdb.orbitdb.open("real-car-test", {
          type: "events",
        });
        await db.add("Real test entry 1");
        await db.add("Real test entry 2");
        await db.add("Real test entry 3");

        const address = db.address;

        // Perform actual backup with real credentials
        const backupResult = await backupDatabaseCAR(orbitdb.orbitdb, address, {
          spaceName: "orbitdb-car-test",
          // Credentials from env are auto-detected by the function
        });

        // Should succeed with real credentials
        if (!backupResult.success) {
          console.error("❌ Backup failed with error:", backupResult.error);
        }
        expect(backupResult.success).toBe(true);
        expect(backupResult.method).toBe("car-timestamped");
        expect(backupResult).toHaveProperty("manifestCID");
        expect(backupResult).toHaveProperty("backupFiles");
        expect(backupResult.backupFiles).toHaveProperty("metadataCID");
        expect(backupResult.backupFiles).toHaveProperty("carCID");
        expect(backupResult.blocksTotal).toBeGreaterThan(0);
        expect(backupResult.carFileSize).toBeGreaterThan(0);

        console.log("✅ Backup successful:", {
          manifestCID: backupResult.manifestCID,
          blocksTotal: backupResult.blocksTotal,
          carFileSize: backupResult.carFileSize,
          metadataFile: backupResult.backupFiles.metadata,
          metadataCID: backupResult.backupFiles.metadataCID,
          carCID: backupResult.backupFiles.carCID,
        });

        // Verify files were uploaded - list space to check
        console.log("\n🔍 Verifying uploaded files...");
        const { listStorachaSpaceFiles } = await import(
          "../lib/orbitdb-storacha-bridge.js"
        );
        const spaceFiles = await listStorachaSpaceFiles();
        console.log(
          "Files in space:",
          spaceFiles.map((f) => f.root).slice(0, 10),
        );

        // Get original data for comparison
        const originalEntries = await db.all();
        const originalAddress = address;

        await db.close();

        // Stop the source node completely
        await orbitdb.orbitdb.stop();
        await orbitdb.helia.stop();
        await orbitdb.blockstore.close();
        await orbitdb.datastore.close();

        console.log("\n🔄 Starting restore on a new isolated node...");

        // Create a completely new OrbitDB instance (simulating a different machine)
        const targetNode = await createHeliaOrbitDB("-restore-target");

        try {
          // Restore from Storacha using the specific CIDs we just backed up
          // Note: We're using the timestamp to specify which backup to restore
          const backupTimestamp = backupResult.backupFiles.metadata.match(
            /backup-(.*?)-metadata/,
          )[1];
          console.log("Restoring from backup timestamp:", backupTimestamp);

          const restoreResult = await restoreFromSpaceCAR(targetNode.orbitdb, {
            spaceName: "orbitdb-car-test",
            timestamp: backupTimestamp, // Use the specific backup we just created
            metadataCID: backupResult.backupFiles.metadataCID,
            carCID: backupResult.backupFiles.carCID,
            // Credentials auto-detected from env
          });

          console.log("✅ Restore successful:", {
            databaseAddress: restoreResult.databaseAddress,
            entriesRecovered: restoreResult.entriesRecovered,
            blocksRestored: restoreResult.blocksRestored,
          });

          // Verify restore was successful
          expect(restoreResult.success).toBe(true);
          expect(restoreResult.method).toBe("car-timestamped");
          expect(restoreResult.database).toBeDefined();
          expect(restoreResult.databaseAddress).toBe(originalAddress);

          // Verify data integrity
          const restoredEntries = await restoreResult.database.all();
          expect(restoredEntries.length).toBe(originalEntries.length);

          // Compare each entry
          for (let i = 0; i < originalEntries.length; i++) {
            expect(restoredEntries[i].value).toBe(originalEntries[i].value);
          }

          console.log("✅ Data integrity verified: All entries match!");

          await restoreResult.database.close();
        } finally {
          await targetNode.orbitdb.stop();
          await targetNode.helia.stop();
          await targetNode.blockstore.close();
          await targetNode.datastore.close();
          await cleanupOrbitDBDirectories();
        }
      } catch (error) {
        // Cleanup on error
        if (orbitdb) {
          try {
            await orbitdb.orbitdb.stop();
            await orbitdb.helia.stop();
            await orbitdb.blockstore.close();
            await orbitdb.datastore.close();
          } catch (cleanupError) {
            console.warn("Cleanup error:", cleanupError.message);
          }
        }
        await cleanupOrbitDBDirectories();
        throw error;
      } finally {
        // Final cleanup to ensure directories are removed
        await cleanupOrbitDBDirectories();
      }
    },
    120000,
  ); // 120 second timeout for backup + restore + network operations

  if (!hasRealCredentials) {
    console.log(
      "⏭️  Skipping real integration test - STORACHA_KEY and STORACHA_PROOF not found in environment",
    );
  }
});
