/**
 * @fileoverview CAR Storage Tests for OrbitDB Storacha Bridge
 *
 * This test suite validates the CAR (Content Addressable Archive) storage implementation
 * that provides persistent file-based storage for OrbitDB databases. It tests the core
 * functionality of storing, retrieving, and persisting OrbitDB data using CAR files,
 * as well as integration with OrbitDB's ComposedStorage system.
 *
 * @author @NiKrause
 * @requires ../lib/car-storage.js - CAR storage implementation
 */

/* global beforeAll, afterAll */
import { promises as fs } from "fs";
import { join } from "path";
import CARStorage from "../lib/car-storage.js";
import {
  createHeliaOrbitDB,
  cleanupOrbitDBDirectories,
  cleanupAllTestArtifacts,
} from "../lib/utils.js";
import { logger } from "../lib/logger.js";
// Import OrbitDB storage modules for integration tests
let ComposedStorage, MemoryStorage, LRUStorage;
try {
  const storageModules = await import("@orbitdb/core/src/storage/index.js");
  ComposedStorage = storageModules.ComposedStorage;
  MemoryStorage = storageModules.MemoryStorage;
  LRUStorage = storageModules.LRUStorage;
} catch (error) {
  logger.warn("OrbitDB storage modules not available for integration tests");
}

/**
 * ANSI color codes for test output
 */
const colors = {
  bright: "\x1b[1m",
  cyan: "\x1b[96m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  reset: "\x1b[0m",
};

/**
 * @namespace CARStorageTests
 * @description Test suite for CAR storage functionality
 */
describe("CAR Storage", () => {
  /** @type {string} Test directory for CAR files */
  const testDir = "./test-car-storage-bridge";
  /** @type {Object|null} Storage instance under test */
  let storage;

  /**
   * @function beforeAll
   * @description Global setup that cleans all test artifacts before running tests
   */
  beforeAll(async () => {
    logger.info(
      `${colors.bright}${colors.cyan}🧹 Global cleanup: Removing all test artifacts before test suite...${colors.reset}`,
    );
    await cleanupAllTestArtifacts();
    logger.info(
      `${colors.bright}${colors.green}✅ Global cleanup completed${colors.reset}`,
    );
  });

  /**
   * @function afterAll
   * @description Global cleanup that removes all test artifacts after all tests complete
   */
  afterAll(async () => {
    logger.info(
      `${colors.bright}${colors.cyan}🧹 Global cleanup: Removing all test artifacts after test suite...${colors.reset}`,
    );
    await cleanupAllTestArtifacts();
    logger.info(
      `${colors.bright}${colors.green}✅ Final cleanup completed${colors.reset}`,
    );
  });

  /**
   * @function beforeEach
   * @description Pre-test setup that cleans up test directory
   */
  beforeEach(async () => {
    logger.info(
      `${colors.bright}${colors.cyan}🧹 Setting up CAR storage test environment...${colors.reset}`,
    );

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  });

  /**
   * @function afterEach
   * @description Post-test cleanup that closes storage and removes test files
   */
  afterEach(async () => {
    if (storage) {
      try {
        await storage.close();
      } catch (error) {
        logger.warn("Storage cleanup warning:", error.message);
      }
      storage = null;
    }

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }

    logger.info(
      `${colors.bright}${colors.green}✅ CAR storage test cleanup completed${colors.reset}`,
    );
  });

  /**
   * @test BasicStorageOperations
   * @description Tests fundamental storage operations (create, put, get, delete)
   */
  describe("Basic Storage Operations", () => {
    /**
     * @test CARStorageCreation
     * @description Validates CAR storage instance creation with proper interface
     */
    test("should create a CAR storage instance", async () => {
      storage = await CARStorage({
        path: testDir,
        name: "test-storage",
        autoFlush: false,
      });

      expect(storage).toBeTruthy();
      expect(typeof storage.put).toBe("function");
      expect(typeof storage.get).toBe("function");
      expect(typeof storage.del).toBe("function");
      expect(typeof storage.iterator).toBe("function");
      expect(typeof storage.persist).toBe("function");
      expect(typeof storage.close).toBe("function");

      logger.info(
        `${colors.green}✅ CAR storage instance created with all required methods${colors.reset}`,
      );
    });

    /**
     * @test DataPutAndGet
     * @description Tests basic data storage and retrieval
     */
    test("should put and get data", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      const testKey = "test-key-1";
      const testData = new TextEncoder().encode("Hello, CAR Storage!");

      await storage.put(testKey, testData);
      const retrieved = await storage.get(testKey);

      expect(retrieved).toBeTruthy();
      expect(retrieved).toEqual(testData);

      logger.info(
        `${colors.green}✅ Data storage and retrieval successful${colors.reset}`,
      );
    });

    /**
     * @test StringDataHandling
     * @description Tests string data conversion to Uint8Array
     */
    test("should handle string data conversion", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      const testKey = "string-test";
      const testString = "This is a test string for CAR storage";

      // Convert string to Uint8Array before storing (CAR storage doesn't auto-convert)
      const testData = new TextEncoder().encode(testString);

      await storage.put(testKey, testData);
      const retrieved = await storage.get(testKey);

      expect(retrieved).toBeInstanceOf(Uint8Array);

      const retrievedString = new TextDecoder().decode(retrieved);
      expect(retrievedString).toBe(testString);

      logger.info(
        `${colors.green}✅ String data conversion handled correctly${colors.reset}`,
      );
    });

    /**
     * @test DataDeletion
     * @description Tests data deletion functionality
     */
    test("should delete data", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      const testKey = "delete-test";
      const testData = new TextEncoder().encode("To be deleted");

      await storage.put(testKey, testData);
      expect(await storage.get(testKey)).toBeTruthy();

      await storage.del(testKey);
      expect(await storage.get(testKey)).toBeUndefined();

      logger.info(`${colors.green}✅ Data deletion successful${colors.reset}`);
    });

    /**
     * @test DataIteration
     * @description Tests iteration over stored data
     */
    test("should iterate over stored data", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      const testData = [
        ["key1", "value1"],
        ["key2", "value2"],
        ["key3", "value3"],
        ["zdpuAtest123hash", "OrbitDB hash format test"],
      ];

      // Add test data - convert strings to Uint8Array
      for (const [key, value] of testData) {
        await storage.put(key, new TextEncoder().encode(value));
      }

      // Collect all entries from iterator
      const entries = [];
      for await (const [key, value] of storage.iterator()) {
        entries.push([key, new TextDecoder().decode(value)]);
      }

      expect(entries.length).toBe(testData.length);

      // Verify all data is present
      for (const [expectedKey, expectedValue] of testData) {
        const found = entries.find(
          ([key, value]) => key === expectedKey && value === expectedValue,
        );
        expect(found).toBeTruthy();
      }

      logger.info(
        `${colors.green}✅ Data iteration over ${entries.length} entries successful${colors.reset}`,
      );
    });
  });

  /**
   * @test CARFilePersistence
   * @description Tests CAR file creation, persistence, and recovery
   */
  describe("CAR File Persistence", () => {
    /**
     * @test PersistenceToCAR
     * @description Tests data persistence to CAR files
     */
    test("should persist data to CAR file", async () => {
      const carPath = join(testDir, "test-data.car");

      storage = await CARStorage({
        path: testDir,
        name: "test-data",
        autoFlush: false,
      });

      // Add some data including OrbitDB hash format
      await storage.put("persistent-key", "persistent-value");
      await storage.put(
        "zdpuAtest123hash",
        new TextEncoder().encode("OrbitDB hash format test"),
      );

      // Force persistence
      await storage.persist();

      // Check that CAR file was created
      const stats = await fs.stat(carPath);
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);

      logger.info(
        `${colors.green}✅ CAR file created with ${stats.size} bytes${colors.reset}`,
      );
    });

    /**
     * @test RecoveryFromCAR
     * @description Tests data recovery from existing CAR files
     */
    test("should load data from existing CAR file", async () => {
      const testKey = "recovery-test";
      const testValue = "This should be recovered from CAR file";

      // Create storage and add data
      storage = await CARStorage({
        path: testDir,
        name: "recovery-test",
        autoFlush: false,
      });

      await storage.put(testKey, new TextEncoder().encode(testValue));
      await storage.persist();
      await storage.close();

      // Create new storage instance - should load from CAR file
      storage = await CARStorage({
        path: testDir,
        name: "recovery-test",
        autoFlush: false,
      });

      const recovered = await storage.get(testKey);
      expect(recovered).toBeTruthy();

      const recoveredValue = new TextDecoder().decode(recovered);
      expect(recoveredValue).toBe(testValue);

      logger.info(
        `${colors.green}✅ Data recovery from CAR file successful${colors.reset}`,
      );
    });

    /**
     * @test AutoFlushThreshold
     * @description Tests automatic flushing based on operation threshold
     */
    test("should handle auto-flush based on threshold", async () => {
      const carPath = join(testDir, "auto-flush-test.car");

      storage = await CARStorage({
        path: testDir,
        name: "auto-flush-test",
        autoFlush: true,
        flushThreshold: 3,
      });

      // Add data below threshold - should not create CAR file yet
      await storage.put("key1", "value1");
      await storage.put("key2", "value2");

      let carFileExists = false;
      try {
        await fs.stat(carPath);
        carFileExists = true;
      } catch (error) {
        // File doesn't exist
      }
      expect(carFileExists).toBe(false);

      // Add one more - should trigger auto-flush
      await storage.put("key3", "value3");

      // Give it a moment to flush
      await new Promise((resolve) => setTimeout(resolve, 200));

      const stats = await fs.stat(carPath);
      expect(stats.isFile()).toBe(true);

      logger.info(
        `${colors.green}✅ Auto-flush triggered at threshold, CAR file: ${stats.size} bytes${colors.reset}`,
      );
    });
  });

  /**
   * @test OrbitDBIntegration
   * @description Tests integration with OrbitDB storage system
   */
  describe("Integration with OrbitDB ComposedStorage", () => {
    /**
     * @test ComposedStorageHybrid
     * @description Tests CAR storage with ComposedStorage for hybrid storage
     */
    test("should work with ComposedStorage for hybrid storage", async () => {
      // Skip if OrbitDB storage modules not available
      if (!ComposedStorage || !MemoryStorage) {
        logger.info(
          `${colors.yellow}⚠️ Skipping ComposedStorage test - OrbitDB modules not available${colors.reset}`,
        );
        return;
      }

      const carStorage = await CARStorage({
        path: testDir,
        name: "composed-test",
        autoFlush: false,
      });

      const memoryStorage = await MemoryStorage();
      const composedStorage = await ComposedStorage(memoryStorage, carStorage);

      // Add data through composed storage
      const testKey = "composed-key";
      const testData = new TextEncoder().encode("Composed storage test");

      await composedStorage.put(testKey, testData);

      // Data should be available immediately from memory
      const fromMemory = await memoryStorage.get(testKey);
      expect(fromMemory).toBeTruthy();

      // Data should also be in CAR storage
      const fromCAR = await carStorage.get(testKey);
      expect(fromCAR).toBeTruthy();

      // Should retrieve from composed storage
      const fromComposed = await composedStorage.get(testKey);
      expect(fromComposed).toBeTruthy();
      expect(fromComposed).toEqual(testData);

      logger.info(
        `${colors.green}✅ ComposedStorage integration successful${colors.reset}`,
      );
    });

    /**
     * @test LRUCARComposition
     * @description Tests LRU cache + CAR storage composition
     */
    test("should demonstrate LRU + CAR composition", async () => {
      // Skip if OrbitDB storage modules not available
      if (!ComposedStorage || !LRUStorage) {
        logger.info(
          `${colors.yellow}⚠️ Skipping LRU+CAR test - OrbitDB modules not available${colors.reset}`,
        );
        return;
      }

      const carStorage = await CARStorage({
        path: testDir,
        name: "lru-car-test",
        autoFlush: false,
      });

      const lruStorage = await LRUStorage({ size: 2 });
      const composedStorage = await ComposedStorage(lruStorage, carStorage);

      // Add data that exceeds LRU capacity - convert strings to Uint8Array
      await composedStorage.put("key1", new TextEncoder().encode("value1"));
      await composedStorage.put("key2", new TextEncoder().encode("value2"));
      await composedStorage.put("key3", new TextEncoder().encode("value3")); // Should evict key1 from LRU

      // key1 should not be in LRU but should be in CAR
      const key1FromLRU = await lruStorage.get("key1");
      expect(key1FromLRU).toBeUndefined();

      const key1FromCAR = await carStorage.get("key1");
      expect(key1FromCAR).toBeTruthy();

      // Should still be accessible through composed storage (will load from CAR to LRU)
      const key1FromComposed = await composedStorage.get("key1");
      expect(key1FromComposed).toBeTruthy();

      const value = new TextDecoder().decode(key1FromComposed);
      expect(value).toBe("value1");

      logger.info(
        `${colors.green}✅ LRU + CAR composition with cache eviction successful${colors.reset}`,
      );
    });
  });

  /**
   * @test ErrorHandlingAndValidation
   * @description Tests error conditions and input validation
   */
  describe("Error Handling and Validation", () => {
    /**
     * @test RequiredPathParameter
     * @description Tests that path parameter is required
     */
    test("should require path parameter", async () => {
      await expect(CARStorage()).rejects.toThrow("path parameter");
    });

    /**
     * @test EmptyHashValidation
     * @description Tests validation of hash parameter in put operation
     */
    test("should handle empty hash in put operation", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      await expect(storage.put("", "some-value")).rejects.toThrow(
        "Hash is required",
      );
    });

    /**
     * @test NonExistentKeyHandling
     * @description Tests get operation for non-existent keys
     */
    test("should handle get operation for non-existent key", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      const result = await storage.get("non-existent-key");
      expect(result).toBeUndefined();
    });

    /**
     * @test InvalidStorageMerge
     * @description Tests merge operation with invalid storage
     */
    test("should handle merge with invalid storage", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      await expect(storage.merge(null)).rejects.toThrow("iterator method");
    });
  });

  /**
   * @test AdvancedOperations
   * @description Tests advanced storage operations and configurations
   */
  describe("Advanced Operations", () => {
    /**
     * @test ClearOperation
     * @description Tests clear operation and CAR file removal
     */
    test("should handle clear operation", async () => {
      storage = await CARStorage({
        path: testDir,
        name: "clear-test",
        autoFlush: false,
      });

      // Add some data
      await storage.put("key1", "value1");
      await storage.put("key2", "value2");
      await storage.persist();

      // Verify data exists
      expect(await storage.get("key1")).toBeTruthy();

      // Clear storage
      await storage.clear();

      // Verify data is gone
      expect(await storage.get("key1")).toBeUndefined();
      expect(await storage.get("key2")).toBeUndefined();

      // CAR file should be removed
      const carPath = join(testDir, "clear-test.car");
      await expect(fs.stat(carPath)).rejects.toThrow();

      logger.info(
        `${colors.green}✅ Clear operation removed all data and CAR file${colors.reset}`,
      );
    });

    /**
     * @test MergeOperation
     * @description Tests merge operation between storage instances
     */
    test("should handle merge operation", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      // Skip if MemoryStorage not available
      if (!MemoryStorage) {
        logger.info(
          `${colors.yellow}⚠️ Skipping merge test - MemoryStorage not available${colors.reset}`,
        );
        return;
      }

      const sourceStorage = await MemoryStorage();
      await sourceStorage.put(
        "merge-key1",
        new TextEncoder().encode("merge-value1"),
      );
      await sourceStorage.put(
        "merge-key2",
        new TextEncoder().encode("merge-value2"),
      );

      await storage.merge(sourceStorage);

      // Verify merged data
      const value1 = await storage.get("merge-key1");
      const value2 = await storage.get("merge-key2");

      expect(value1).toBeTruthy();
      expect(value2).toBeTruthy();

      expect(new TextDecoder().decode(value1)).toBe("merge-value1");
      expect(new TextDecoder().decode(value2)).toBe("merge-value2");

      logger.info(
        `${colors.green}✅ Merge operation successful${colors.reset}`,
      );
    });

    /**
     * @test IteratorOptions
     * @description Tests iterator with amount and reverse options
     */
    test("should handle iterator with options", async () => {
      storage = await CARStorage({
        path: testDir,
        autoFlush: false,
      });

      // Add test data
      for (let i = 1; i <= 5; i++) {
        await storage.put(`key${i}`, `value${i}`);
      }

      // Test amount limit
      const limitedEntries = [];
      for await (const [key, _value] of storage.iterator({ amount: 3 })) {
        limitedEntries.push(key);
      }
      expect(limitedEntries.length).toBe(3);

      // Test reverse order
      const allKeys = [];
      for await (const [key, _value] of storage.iterator()) {
        allKeys.push(key);
      }

      const reversedKeys = [];
      for await (const [key, _value] of storage.iterator({ reverse: true })) {
        reversedKeys.push(key);
      }

      expect(reversedKeys).toEqual(allKeys.reverse());

      logger.info(
        `${colors.green}✅ Iterator options (amount: 3, reverse) working correctly${colors.reset}`,
      );
    });
  });

  /**
   * @test OrbitDBHashFormatHandling
   * @description Tests handling of OrbitDB-specific hash formats
   */
  describe("OrbitDB Hash Format Handling", () => {
    /**
     * @test OrbitDBHashPersistence
     * @description Tests persistence and recovery of OrbitDB hash formats
     */
    test("should handle OrbitDB hash formats (zdpu prefixed)", async () => {
      storage = await CARStorage({
        path: testDir,
        name: "orbitdb-hash-test",
        autoFlush: false,
      });

      const orbitdbHashes = [
        "zdpuAtest123hashExample1",
        "zdpuBtest456hashExample2",
        "zdpuCtest789hashExample3",
      ];

      const testData = [
        "OrbitDB entry data 1",
        "OrbitDB entry data 2",
        "OrbitDB entry data 3",
      ];

      // Store data with OrbitDB hash keys - convert strings to Uint8Array
      for (let i = 0; i < orbitdbHashes.length; i++) {
        await storage.put(
          orbitdbHashes[i],
          new TextEncoder().encode(testData[i]),
        );
      }

      // Persist to CAR file
      await storage.persist();
      await storage.close();

      // Create new storage instance and verify recovery
      storage = await CARStorage({
        path: testDir,
        name: "orbitdb-hash-test",
        autoFlush: false,
      });

      // Verify all OrbitDB hashes are recovered
      for (let i = 0; i < orbitdbHashes.length; i++) {
        const recovered = await storage.get(orbitdbHashes[i]);
        expect(recovered).toBeTruthy();

        const recoveredValue = new TextDecoder().decode(recovered);
        expect(recoveredValue).toBe(testData[i]);
      }

      logger.info(
        `${colors.green}✅ OrbitDB hash format handling: ${orbitdbHashes.length} hashes persisted and recovered${colors.reset}`,
      );
    });
  });

  /**
   * @test PerformanceAndScalability
   * @description Tests performance characteristics and scalability
   */
  describe("Performance and Scalability", () => {
    /**
     * @test LargeDatasetHandling
     * @description Tests handling of larger datasets
     */
    test("should handle larger datasets efficiently", async () => {
      storage = await CARStorage({
        path: testDir,
        name: "performance-test",
        autoFlush: false,
        flushThreshold: 100,
      });

      const startTime = Date.now();
      const entryCount = 100;

      // Add a larger dataset
      for (let i = 0; i < entryCount; i++) {
        const key = `performance-key-${i.toString().padStart(3, "0")}`;
        const value = `Performance test data entry ${i} with some additional content to make it more realistic`;
        await storage.put(key, value);
      }

      const putTime = Date.now() - startTime;

      // Test iteration performance
      const iterStartTime = Date.now();
      let iteratedCount = 0;
      for await (const [_key, _value] of storage.iterator()) {
        iteratedCount++;
      }
      const iterTime = Date.now() - iterStartTime;

      // Test persistence performance
      const persistStartTime = Date.now();
      await storage.persist();
      const persistTime = Date.now() - persistStartTime;

      expect(iteratedCount).toBe(entryCount);

      logger.info(
        `${colors.green}✅ Performance test completed:${colors.reset}`,
      );
      logger.info(
        `   📊 ${entryCount} entries: PUT ${putTime}ms, ITERATE ${iterTime}ms, PERSIST ${persistTime}ms`,
      );
      logger.info(
        `   ⚡ Average: ${(putTime / entryCount).toFixed(2)}ms per PUT operation`,
      );

      // Basic performance expectations (these are quite generous)
      expect(putTime).toBeLessThan(5000); // 5 seconds for 100 puts
      expect(iterTime).toBeLessThan(1000); // 1 second to iterate
      expect(persistTime).toBeLessThan(3000); // 3 seconds to persist
    }, 15000); // 15 second timeout for performance test
  });
}, 15000); // 15 second timeout for performance test

/**
 * @test FullOrbitDBIntegration
 * @description Tests complete OrbitDB integration with CAR storage persistence
 */
describe("Full OrbitDB Integration with Persistence", () => {
  const testDir = "./test-orbitdb-car-integration";

  /**
   * @function beforeAll
   * @description Setup for OrbitDB integration tests
   */
  beforeAll(async () => {
    logger.info(
      `${colors.bright}${colors.cyan}🧹 OrbitDB Integration: Initial cleanup...${colors.reset}`,
    );
    await cleanupAllTestArtifacts();
  });

  /**
   * @function afterAll
   * @description Cleanup after OrbitDB integration tests
   */
  afterAll(async () => {
    logger.info(
      `${colors.bright}${colors.cyan}🧹 OrbitDB Integration: Final cleanup...${colors.reset}`,
    );
    await cleanupAllTestArtifacts();
  });

  /**
   * @test OrbitDBTodoPersistence
   * @description Creates OrbitDB with CAR storage, adds todos, closes, reopens, and verifies persistence
   */
  test("should persist and recover OrbitDB todos using CAR storage", async () => {
    // Skip if OrbitDB storage modules not available
    if (!ComposedStorage || !MemoryStorage) {
      logger.info(
        `${colors.yellow}⚠️ Skipping full OrbitDB test - storage modules not available${colors.reset}`,
      );
      return;
    }

    logger.info(
      `${colors.bright}${colors.cyan}🚀 Starting full OrbitDB + CAR storage integration test...${colors.reset}`,
    );

    const dbName = "todos-test";
    const carStoragePath = testDir;
    let orbitdbInstance1, orbitdbInstance2;
    let heliaInstance1, heliaInstance2;

    try {
      // Phase 1: Create OrbitDB with CAR storage for all storage types
      logger.info(
        `${colors.cyan}📝 Phase 1: Creating OrbitDB with CAR storage...${colors.reset}`,
      );

      // Create CAR storage instances for each OrbitDB storage type
      const entryCarStorage1 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-entries",
        autoFlush: false,
      });

      const headsCarStorage1 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-heads",
        autoFlush: false,
      });

      const indexCarStorage1 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-index",
        autoFlush: false,
      });

      // Create composed storage for each type (Memory + CAR)
      const entryMemory1 = await MemoryStorage();
      const headsMemory1 = await MemoryStorage();
      const indexMemory1 = await MemoryStorage();

      const entryStorage1 = await ComposedStorage(
        entryMemory1,
        entryCarStorage1,
      );
      const headsStorage1 = await ComposedStorage(
        headsMemory1,
        headsCarStorage1,
      );
      const indexStorage1 = await ComposedStorage(
        indexMemory1,
        indexCarStorage1,
      );

      const { helia: helia1, orbitdb: orbitdb1 } =
        await createHeliaOrbitDB("-todos-1");
      heliaInstance1 = helia1;
      orbitdbInstance1 = orbitdb1;

      // Create keyvalue database with custom storage configuration
      const todosDb1 = await orbitdb1.open(dbName, {
        type: "keyvalue",
        entryStorage: entryStorage1,
        headsStorage: headsStorage1,
        indexStorage: indexStorage1,
      });

      // Add some todos
      const todos = [
        {
          id: "todo1",
          text: "Learn OrbitDB",
          completed: false,
          priority: "high",
        },
        {
          id: "todo2",
          text: "Implement CAR storage",
          completed: true,
          priority: "medium",
        },
        {
          id: "todo3",
          text: "Write comprehensive tests",
          completed: false,
          priority: "high",
        },
        {
          id: "todo4",
          text: "Deploy to production",
          completed: false,
          priority: "low",
        },
      ];

      logger.info(
        `${colors.cyan}📝 Adding ${todos.length} todos to OrbitDB...${colors.reset}`,
      );
      for (const todo of todos) {
        await todosDb1.put(todo.id, todo);
      }

      // Verify todos are in the database
      const retrievedTodos = [];
      for (const todo of todos) {
        const retrieved = await todosDb1.get(todo.id);
        expect(retrieved).toBeTruthy();
        expect(retrieved.text).toBe(todo.text);
        retrievedTodos.push(retrieved);
      }

      logger.info(
        `${colors.green}✅ Phase 1: ${retrievedTodos.length} todos added and verified in OrbitDB${colors.reset}`,
      );

      // Force persistence to CAR storage
      await entryCarStorage1.persist();
      await headsCarStorage1.persist();
      await indexCarStorage1.persist();
      logger.info(
        `${colors.cyan}💾 Phase 1: Data persisted to CAR storage (entries, heads, index)${colors.reset}`,
      );

      // Close first database and OrbitDB instance
      await todosDb1.close();
      await orbitdb1.stop();
      await helia1.stop();

      logger.info(
        `${colors.cyan}🔒 Phase 1: Database and OrbitDB instance closed${colors.reset}`,
      );

      // Phase 2: Create new OrbitDB instance with same CAR storage configuration
      logger.info(
        `${colors.cyan}🔄 Phase 2: Creating new OrbitDB instance with same CAR storage...${colors.reset}`,
      );

      // Create new CAR storage instances with same names (should load existing data)
      const entryCarStorage2 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-entries",
        autoFlush: false,
      });

      const headsCarStorage2 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-heads",
        autoFlush: false,
      });

      const indexCarStorage2 = await CARStorage({
        path: carStoragePath,
        name: "orbitdb-index",
        autoFlush: false,
      });

      // Create new composed storage instances
      const entryMemory2 = await MemoryStorage();
      const headsMemory2 = await MemoryStorage();
      const indexMemory2 = await MemoryStorage();

      const entryStorage2 = await ComposedStorage(
        entryMemory2,
        entryCarStorage2,
      );
      const headsStorage2 = await ComposedStorage(
        headsMemory2,
        headsCarStorage2,
      );
      const indexStorage2 = await ComposedStorage(
        indexMemory2,
        indexCarStorage2,
      );

      const { helia: helia2, orbitdb: orbitdb2 } =
        await createHeliaOrbitDB("-todos-2");
      heliaInstance2 = helia2;
      orbitdbInstance2 = orbitdb2;

      // Open same database with new storage instances
      const todosDb2 = await orbitdb2.open(dbName, {
        type: "keyvalue",
        entryStorage: entryStorage2,
        headsStorage: headsStorage2,
        indexStorage: indexStorage2,
      });

      logger.info(
        `${colors.cyan}🔍 Phase 2: Verifying todos recovered from CAR storage...${colors.reset}`,
      );

      // Verify all todos are recovered
      const recoveredTodos = [];
      for (const originalTodo of todos) {
        const recovered = await todosDb2.get(originalTodo.id);
        expect(recovered).toBeTruthy();
        expect(recovered.text).toBe(originalTodo.text);
        expect(recovered.completed).toBe(originalTodo.completed);
        expect(recovered.priority).toBe(originalTodo.priority);
        recoveredTodos.push(recovered);
      }

      logger.info(
        `${colors.green}✅ Phase 2: ${recoveredTodos.length} todos successfully recovered from CAR storage${colors.reset}`,
      );

      // Test adding new todo to verify database is fully functional
      const newTodo = {
        id: "todo5",
        text: "Celebrate successful persistence!",
        completed: false,
        priority: "high",
      };
      await todosDb2.put(newTodo.id, newTodo);

      const retrievedNewTodo = await todosDb2.get(newTodo.id);
      expect(retrievedNewTodo).toBeTruthy();
      expect(retrievedNewTodo.text).toBe(newTodo.text);

      logger.info(
        `${colors.green}✅ Phase 2: New todo added successfully, database fully functional${colors.reset}`,
      );

      // Verify data persistence across all storage layers
      logger.info(
        `${colors.cyan}🔍 Verifying data in CAR storage layers...${colors.reset}`,
      );

      // Check that data exists in the CAR storage layers
      let entryCount = 0;
      for await (const [_key, _value] of entryCarStorage2.iterator()) {
        entryCount++;
      }

      let headsCount = 0;
      for await (const [_key, _value] of headsCarStorage2.iterator()) {
        headsCount++;
      }

      let indexCount = 0;
      for await (const [_key, _value] of indexCarStorage2.iterator()) {
        indexCount++;
      }

      logger.info(
        `${colors.green}✅ CAR storage verification: ${entryCount} entries, ${headsCount} heads, ${indexCount} index items${colors.reset}`,
      );

      // Close second database
      await todosDb2.close();
      await orbitdb2.stop();
      await helia2.stop();

      logger.info(
        `${colors.bright}${colors.green}🎉 Full OrbitDB + CAR storage integration test completed successfully!${colors.reset}`,
      );
      logger.info(
        `${colors.green}   📊 Summary: ${todos.length + 1} todos persisted and recovered across OrbitDB restarts${colors.reset}`,
      );
      logger.info(
        `${colors.green}   🗃️ Storage layers: entries, heads, and index all persisted to CAR files${colors.reset}`,
      );
    } catch (error) {
      logger.error(
        `${colors.red}❌ OrbitDB integration test failed: ${error.message}${colors.reset}`,
      );
      throw error;
    } finally {
      // Cleanup
      if (orbitdbInstance1) {
        try {
          await orbitdbInstance1.stop();
        } catch (e) {
          logger.warn("Error stopping orbitdb1:", e.message);
        }
      }
      if (orbitdbInstance2) {
        try {
          await orbitdbInstance2.stop();
        } catch (e) {
          logger.warn("Error stopping orbitdb2:", e.message);
        }
      }
      if (heliaInstance1) {
        try {
          await heliaInstance1.stop();
        } catch (e) {
          logger.warn("Error stopping helia1:", e.message);
        }
      }
      if (heliaInstance2) {
        try {
          await heliaInstance2.stop();
        } catch (e) {
          logger.warn("Error stopping helia2:", e.message);
        }
      }

      // Clean up OrbitDB directories
      await cleanupOrbitDBDirectories();
    }
  }, 30000); // 30 second timeout for full integration test
});
