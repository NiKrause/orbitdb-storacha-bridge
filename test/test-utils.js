/**
 * Test Utilities for OrbitDB Storacha Bridge
 *
 * Utility functions for testing, including cleanup and test data management
 */

import logger from "../lib/logger.js";

/**
 * Clean up all test-related directories and CAR files
 * This function removes all common test artifacts created during testing
 */
export async function cleanupAllTestArtifacts() {
  const fs = await import("fs");

  logger.info("Starting comprehensive test cleanup...");

  // Test directories to clean up
  const testDirectories = [
    "./test-car-storage-bridge",
    "./test-orbitdb-car-integration",
    "./test-preservation",
    "./test-advanced",
    "./test-data",
    "./test-hash-preservation",
    "./orbitdb-todo-restored",
    "./orbitdb-todo-source",
    "./helia-car-demo",
    "./storage-demo",
  ];

  let cleanedDirs = 0;
  let cleanedFiles = 0;

  // Clean up test directories
  for (const dir of testDirectories) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      logger.info(`Removed test directory: ${dir}`);
      cleanedDirs++;
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.warn(`Could not remove ${dir}: ${error.message}`);
      }
    }
  }

  // Clean up CAR files
  try {
    const entries = await fs.promises.readdir(".", { withFileTypes: true });
    const carFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".car"),
    );

    for (const carFile of carFiles) {
      try {
        await fs.promises.unlink(carFile.name);
        logger.info(`Removed CAR file: ${carFile.name}`);
        cleanedFiles++;
      } catch (error) {
        logger.warn(`Could not remove ${carFile.name}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.warn(`Error scanning for CAR files: ${error.message}`);
  }

  // Also clean up OrbitDB directories
  const { cleanupOrbitDBDirectories } = await import("../lib/utils.js");
  await cleanupOrbitDBDirectories();

  logger.success(
    `Comprehensive cleanup completed: ${cleanedDirs} directories, ${cleanedFiles} CAR files`,
  );
}

/**
 * Clean up specific test directory and associated CAR files
 * @param {string} testDir - The test directory path
 * @param {string} [carPrefix] - Optional prefix for CAR files to clean
 */
export async function cleanupSpecificTest(testDir, carPrefix = null) {
  const fs = await import("fs");

  logger.info(`Cleaning up specific test: ${testDir}`);

  // Clean up the test directory
  try {
    await fs.promises.rm(testDir, { recursive: true, force: true });
    logger.info(`Removed test directory: ${testDir}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(`Could not remove ${testDir}: ${error.message}`);
    }
  }

  // Clean up associated CAR files if prefix provided
  if (carPrefix) {
    try {
      const entries = await fs.promises.readdir(".", { withFileTypes: true });
      const carFiles = entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".car") &&
          entry.name.startsWith(carPrefix),
      );

      for (const carFile of carFiles) {
        try {
          await fs.promises.unlink(carFile.name);
          logger.info(`Removed CAR file: ${carFile.name}`);
        } catch (error) {
          logger.warn(`Could not remove ${carFile.name}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.warn(`Error scanning for CAR files: ${error.message}`);
    }
  }
}

/**
 * Generate test todo data for demos and testing
 * @param {string} createdBy - The creator identifier
 * @returns {Array} Array of test todo objects
 */
export function generateTestTodos(createdBy = "alice") {
  return [
    {
      id: `test_todo_1_${Date.now()}`,
      text: "Buy groceries for the week",
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy,
    },
    {
      id: `test_todo_2_${Date.now()}`,
      text: "Walk the dog in the park",
      completed: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      createdBy,
    },
    {
      id: `test_todo_3_${Date.now()}`,
      text: "Finish the OrbitDB project",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      createdBy,
    },
  ];
}

/**
 * Generate test replication todos for P2P testing
 * @param {string} createdBy - The creator identifier
 * @returns {Array} Array of test todo objects for replication testing
 */
export function generateReplicationTestTodos(createdBy = "alice") {
  return [
    {
      id: `replication_todo_1_${Date.now()}`,
      text: "Test P2P replication with Alice & Bob",
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy,
    },
    {
      id: `replication_todo_2_${Date.now()}`,
      text: "Backup database to Storacha",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      createdBy,
    },
    {
      id: `replication_todo_3_${Date.now()}`,
      text: "Restore and maintain replication",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      createdBy,
    },
  ];
}
