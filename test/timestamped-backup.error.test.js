/**
 * Error handling tests for timestamped backup feature
 */
import "dotenv/config";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import {
  backupDatabase,
  restoreDatabaseFromSpace,
  listStorachaSpaceFiles,
  findLatestBackup,
  clearStorachaSpace,
} from "../lib/orbitdb-storacha-bridge.js";
import * as Signer from "@storacha/client/principal/ed25519";

describe("Timestamped backups error handling", () => {
  let sourceNode, targetNode;
  const TEST_SPACE = "test-backup-errors";
  const AUTH = {
    storachaKey: process.env.STORACHA_KEY,
    storachaProof: process.env.STORACHA_PROOF,
    spaceName: TEST_SPACE,
  };

  beforeEach(async () => {
    // Create test nodes
    sourceNode = await createHeliaOrbitDB("-source");
    targetNode = await createHeliaOrbitDB("-target");

    // Clean test space
    await clearStorachaSpace(AUTH);
  });

  afterEach(async () => {
    // Cleanup
    if (sourceNode) {
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
    }
    if (targetNode) {
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }
    await cleanupOrbitDBDirectories();
    await clearStorachaSpace(AUTH);
  });

  test("should migrate old backup format", async () => {
    // Create and populate test database
    const sourceDB = await sourceNode.orbitdb.open("test-old-format", {
      type: "events",
    });
    await sourceDB.add("Old format test");

    // Create backup in old format (backup.json + blocks.car)
    const oldMetadata = {
      version: "1",
      timestamp: Date.now(),
      databaseCount: 1,
      databases: [
        {
          root: sourceDB.address.root,
          path: sourceDB.address.path,
        },
      ],
    };

    await Signer.writeFile(
      `${TEST_SPACE}/backup.json`,
      JSON.stringify(oldMetadata, null, 2),
    );

    // Test restore with old format
    const restored = await restoreDatabaseFromSpace(targetNode.orbitdb, AUTH);

    // Should auto-migrate and work
    expect(restored.success).toBe(true);
    expect(restored.entries.length).toBe(1);
    expect(restored.entries[0].value).toBe("Old format test");

    // Old files should be backed up with .bak extension
    const spaceFiles = await listStorachaSpaceFiles(AUTH);
    const backupFiles = spaceFiles
      .map((f) => f.root.toString())
      .filter((f) => f.endsWith(".bak"));
    expect(backupFiles.length).toBe(2);
  }, 60000);

  test("should handle incomplete backups gracefully", async () => {
    // Create incomplete backup (only metadata, no blocks)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const incompleteMetadata = {
      version: "1",
      timestamp: Date.now(),
      incomplete: true,
    };

    await Signer.writeFile(
      `${TEST_SPACE}/backup-${timestamp}-metadata.json`,
      JSON.stringify(incompleteMetadata, null, 2),
    );

    // Should skip incomplete backup
    const spaceFiles = await listStorachaSpaceFiles(AUTH);
    const latestBackup = findLatestBackup(spaceFiles);
    expect(latestBackup).toBe(null); // No valid backup found
  }, 60000);

  test("should handle corrupted metadata", async () => {
    // Create backup with corrupted metadata
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Write corrupted JSON
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${timestamp}-metadata.json`,
      "{ this is not valid json }",
    );

    // Create valid blocks file to complete the pair
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${timestamp}-blocks.car`,
      "dummy content",
    );

    // Should skip corrupted backup
    const spaceFiles = await listStorachaSpaceFiles(AUTH);
    const latestBackup = findLatestBackup(spaceFiles);
    expect(latestBackup).toBe(null); // No valid backup found
  }, 60000);

  test("should handle multiple invalid backups and use latest valid one", async () => {
    // Create and populate test database
    const sourceDB = await sourceNode.orbitdb.open("test-multiple", {
      type: "events",
    });
    await sourceDB.add("Test entry");

    // Create first valid backup
    const backup1 = await backupDatabase(
      sourceNode.orbitdb,
      sourceDB.address,
      AUTH,
    );
    expect(backup1.success).toBe(true);

    // Create corrupted backup with newer timestamp
    const newerTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${newerTimestamp}-metadata.json`,
      "{ corrupted json }",
    );

    // Create incomplete backup with even newer timestamp
    const newestTimestamp = new Date(Date.now() + 1000)
      .toISOString()
      .replace(/[:.]/g, "-");
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${newestTimestamp}-metadata.json`,
      JSON.stringify({ incomplete: true }, null, 2),
    );

    // Should restore from the oldest but valid backup
    const restored = await restoreDatabaseFromSpace(targetNode.orbitdb, AUTH);
    expect(restored.success).toBe(true);
    expect(restored.entries.length).toBe(1);
    expect(restored.entries[0].value).toBe("Test entry");
  }, 60000);

  test("should warn about orphaned files", async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Create orphaned metadata file (no corresponding blocks file)
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${timestamp}-metadata.json`,
      JSON.stringify({ test: true }, null, 2),
    );

    // Create orphaned blocks file (no corresponding metadata)
    const otherTimestamp = new Date(Date.now() + 1000)
      .toISOString()
      .replace(/[:.]/g, "-");
    await Signer.writeFile(
      `${TEST_SPACE}/backup-${otherTimestamp}-blocks.car`,
      "dummy content",
    );

    // Should detect and warn about orphaned files
    const spaceFiles = await listStorachaSpaceFiles(AUTH);
    const warnings = [];
    const latestBackup = findLatestBackup(spaceFiles, {
      onWarning: (msg) => warnings.push(msg),
    });

    expect(latestBackup).toBe(null); // No complete backup
    expect(warnings.length).toBe(2); // Two orphaned files
  }, 60000);
});
