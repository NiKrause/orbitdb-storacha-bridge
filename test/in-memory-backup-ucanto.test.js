/**
 * Integration Test: OrbitDB Backup with Direct UCANTO Invocations
 * 
 * Tests backup functionality using direct UCANTO capability invocations
 * instead of @storacha/client, bypassing JWT encoding issues.
 */

import "dotenv/config";
import {
  setupTestUploadService,
  teardownTestUploadService,
  createUCANTOConfig,
} from "./helpers/test-upload-service.js";
import { backupDatabaseWithUCANTO } from "../lib/backup-ucanto.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import logger from "../lib/logger.js";

describe("OrbitDB Backup with Direct UCANTO", () => {
  let testService;
  let sourceNode;

  beforeAll(async () => {
    // Setup in-memory upload service (no HTTP server needed for UCANTO)
    testService = await setupTestUploadService({ withHTTP: false });
    logger.info("✅ In-memory upload service ready");
  });

  afterAll(async () => {
    await teardownTestUploadService(testService);
    await cleanupOrbitDBDirectories();
  });

  beforeEach(async () => {
    sourceNode = await createHeliaOrbitDB("-test-source");
  });

  afterEach(async () => {
    if (sourceNode) {
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
    }
  });

  test("should backup database using direct UCANTO invocations", async () => {
    // Create UCANTO config
    const { connection, invocationConfig } = await createUCANTOConfig(testService);

    logger.info("📝 Creating test database...");
    const sourceDB = await sourceNode.orbitdb.open("test-events", {
      type: "events",
    });

    // Add test data
    await sourceDB.add("Event 1");
    await sourceDB.add("Event 2");
    await sourceDB.add("Event 3");

    const sourceEntries = await sourceDB.all();
    logger.info(`✅ Created database with ${sourceEntries.length} entries`);

    // Backup using direct UCANTO
    logger.info("📤 Starting backup with direct UCANTO...");
    const backupResult = await backupDatabaseWithUCANTO(
      sourceNode.orbitdb,
      sourceDB.address,
      {
        connection,
        invocationConfig,
      }
    );

    console.log("Backup result:", JSON.stringify(backupResult, null, 2));

    expect(backupResult.success).toBe(true);
    expect(backupResult.blocksUploaded).toBeGreaterThan(0);
    logger.info(`✅ Backup completed: ${backupResult.blocksUploaded} blocks uploaded`);

    await sourceDB.close();
  });

  test("should backup key-value database with UCANTO", async () => {
    const { connection, invocationConfig } = await createUCANTOConfig(testService);

    const sourceDB = await sourceNode.orbitdb.open("test-kv", {
      type: "keyvalue",
    });

    await sourceDB.put("key1", "value1");
    await sourceDB.put("key2", "value2");
    await sourceDB.put("key3", { nested: "object" });

    const sourceData = await sourceDB.all();
    const sourceKeys = Object.keys(sourceData);

    const backupResult = await backupDatabaseWithUCANTO(
      sourceNode.orbitdb,
      sourceDB.address,
      {
        connection,
        invocationConfig,
      }
    );

    expect(backupResult.success).toBe(true);
    expect(backupResult.blocksUploaded).toBeGreaterThan(0);
    logger.info(`✅ KV backup: ${backupResult.blocksUploaded} blocks`);

    await sourceDB.close();
  });

  test("should handle empty database", async () => {
    const { connection, invocationConfig } = await createUCANTOConfig(testService);

    const sourceDB = await sourceNode.orbitdb.open("empty-db", {
      type: "events",
    });

    const backupResult = await backupDatabaseWithUCANTO(
      sourceNode.orbitdb,
      sourceDB.address,
      {
        connection,
        invocationConfig,
      }
    );

    // Should succeed with manifest/identity blocks
    expect(backupResult.success).toBe(true);
    expect(backupResult.blocksUploaded).toBeGreaterThan(0);

    await sourceDB.close();
  });
});
