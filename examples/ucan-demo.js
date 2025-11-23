/**
 * OrbitDB Storacha Bridge UCAN Demo
 *
 * This comprehensive demonstration showcases the complete OrbitDB database backup and restoration
 * workflow via Storacha/Filecoin using UCAN (User Controlled Authorization Networks) authentication.
 *
 * Key Features:
 * - UCAN-based authentication: Uses UCAN delegation tokens instead of traditional API keys or proofs
 * - Complete backup workflow: Creates an OrbitDB database, adds sample data, and backs it up to Storacha
 * - Full restoration process: Restores the database from Storacha space with data integrity verification
 * - Dual interface support: Demonstrates both function-based and class-based API usage
 * - UCAN validation: Validates and displays detailed information about UCAN credentials including:
 *   - Issuer and audience DIDs
 *   - Capabilities and permissions
 *   - Expiration dates and validity status
 *   - Space and agent DID matching
 * - Flexible credential loading: Supports loading UCAN from:
 *   - CAR files (via STORACHA_UCAN_FILE or --from-files)
 *   - Base64-encoded tokens (via STORACHA_UCAN_TOKEN or delegation-token.txt)
 *   - Environment variables or local files
 * - Progress tracking: Real-time upload/download progress events
 * - Data integrity verification: Validates that all entries are restored correctly and database
 *   addresses are preserved
 *
 * Usage:
 *   node examples/ucan-demo.js              # Uses .env variables
 *   node examples/ucan-demo.js --from-files # Uses recipient-key.txt and delegation-token.txt
 *
 * Prerequisites:
 *   - Valid UCAN delegation token or CAR file
 *   - Recipient key (if using token-based authentication)
 *   - Storacha space access configured via UCAN
 *
 *   To create UCAN credentials, use:
 *     node examples/create-proper-ucan.js
 *
 *   This will generate:
 *     - ucan-delegation.car (CAR file format)
 *     - delegation-token.txt (base64 token format)
 *     - recipient-key.txt (recipient identity key)
 */

import "dotenv/config";
import {
  backupDatabaseWithUCAN,
  restoreDatabaseFromSpaceWithUCAN,
  OrbitDBStorachaBridgeUCAN,
} from "../lib/ucan-bridge.js";
import { logger } from "../lib/logger.js";
import * as Delegation from "@ucanto/core/delegation";
import * as Proof from "@storacha/client/proof";
import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { promises as fs } from "fs";
import readline from "readline";

// Import utilities
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

/**
 * Test complete OrbitDB backup and restore workflow using UCAN
 * @param {Object} [options={}] - UCAN authentication options
 * @param {string} [options.ucanFile] - Path to UCAN delegation CAR file
 * @param {string} [options.ucanToken] - Base64-encoded UCAN delegation token
 * @param {string} [options.recipientKey] - Recipient key for UCAN delegation
 * @param {string} [options.agentDID] - Agent DID (optional, can be auto-detected)
 * @param {string} [options.spaceDID] - Space DID (optional, can be auto-detected)
 * @returns {Promise<Object>} Test result object with success status, manifest CID, entry counts, and other metadata
 */
async function testOrbitDBStorachaBridgeUCAN(options = {}) {
  logger.info("�� Testing OrbitDB Storacha Bridge with UCAN Authentication");
  logger.info("=".repeat(70));

  let sourceNode, targetNode;

  try {
    // Step 1: Create source database with sample data
    logger.info("\\n📡 Step 1: Creating source database...");
    sourceNode = await createHeliaOrbitDB("-ucan-source");

    const sourceDB = await sourceNode.orbitdb.open("ucan-bridge-demo", {
      type: "events",
    });

    // Add sample data
    const sampleData = [
      "Hello from OrbitDB with UCAN!",
      "This data will survive UCAN backup and restore",
      "Perfect hash preservation with UCAN test",
      "UCAN-based identity recovery demonstration",
      "Decentralized authorization without API keys!",
    ];

    for (const content of sampleData) {
      const hash = await sourceDB.add(content);
      logger.info(`   📝 Added: ${hash.substring(0, 16)}... - "${content}"`);
    }

    logger.info(`\\n📊 Source database created:`);
    logger.info(`   Name: ${sourceDB.name}`);
    logger.info(`   Address: ${sourceDB.address}`);
    logger.info(`   Entries: ${(await sourceDB.all()).length}`);

    // Step 2: Backup database to Storacha using UCAN
    logger.info("\\n📤 Step 2: Backing up database to Storacha with UCAN...");

    const backupOptions = {
      // UCAN authentication options
      ucanFile: options.ucanFile,
      ucanToken: options.ucanToken,
      recipientKey: options.recipientKey,
      agentDID: options.agentDID,
      spaceDID: options.spaceDID,
    };

    const backupResult = await backupDatabaseWithUCAN(
      sourceNode.orbitdb,
      sourceDB.address,
      backupOptions,
    );

    if (!backupResult.success) {
      throw new Error(`UCAN Backup failed: ${backupResult.error}`);
    }

    logger.info(`✅ UCAN Backup completed successfully!`);
    logger.info(`   📋 Manifest CID: ${backupResult.manifestCID}`);
    logger.info(
      `   📊 Blocks uploaded: ${backupResult.blocksUploaded}/${backupResult.blocksTotal}`,
    );
    logger.info(`   📦 Block types:`, backupResult.blockSummary);

    // Close source database
    await sourceDB.close();
    await sourceNode.orbitdb.stop();
    await sourceNode.helia.stop();
    await sourceNode.blockstore.close();
    await sourceNode.datastore.close();

    logger.info("\\n🧹 Source database closed and cleaned up");

    // Step 3: Create target node and restore from space using UCAN
    logger.info("\\n🔄 Step 3: Creating target node...");
    targetNode = await createHeliaOrbitDB("-ucan-target");

    logger.info(
      "\\n📥 Step 4: Restoring database from Storacha space with UCAN...",
    );

    const restoreOptions = {
      // UCAN authentication options
      ucanFile: options.ucanFile,
      ucanToken: options.ucanToken,
      recipientKey: options.recipientKey,
      agentDID: options.agentDID,
      spaceDID: options.spaceDID,
    };

    const restoreResult = await restoreDatabaseFromSpaceWithUCAN(
      targetNode.orbitdb,
      restoreOptions,
    );

    if (!restoreResult.success) {
      throw new Error(`UCAN Restore failed: ${restoreResult.error}`);
    }

    logger.info(`✅ UCAN Restore completed successfully!`);
    logger.info(`   📋 Restored database: ${restoreResult.name}`);
    logger.info(`   📍 Address: ${restoreResult.address}`);
    logger.info(`   📊 Entries recovered: ${restoreResult.entriesRecovered}`);
    logger.info(`   🔄 Blocks restored: ${restoreResult.blocksRestored}`);
    logger.info(`   🎯 Address match: ${restoreResult.addressMatch}`);

    // Display restored entries
    logger.info("\\n📄 Restored entries:");
    for (let i = 0; i < restoreResult.entries.length; i++) {
      const entry = restoreResult.entries[i];
      logger.info(
        `   ${i + 1}. ${entry.hash.substring(0, 16)}... - "${entry.value}"`,
      );
    }

    const originalCount = sampleData.length;
    const restoredCount = restoreResult.entriesRecovered;

    logger.info("\\n🎉 SUCCESS! OrbitDB Storacha Bridge UCAN test completed!");
    logger.info(`   📊 Original entries: ${originalCount}`);
    logger.info(`   📊 Restored entries: ${restoredCount}`);
    logger.info(`   📋 Manifest CID: ${restoreResult.manifestCID}`);
    logger.info(`   📍 Address preserved: ${restoreResult.addressMatch}`);
    logger.info(
      `   🌟 100% data integrity: ${originalCount === restoredCount && restoreResult.addressMatch}`,
    );
    logger.info(`   🔐 UCAN Authentication: ✅ SUCCESS`);

    return {
      success: true,
      manifestCID: restoreResult.manifestCID,
      originalEntries: originalCount,
      restoredEntries: restoredCount,
      addressMatch: restoreResult.addressMatch,
      blocksUploaded: backupResult.blocksUploaded,
      blocksRestored: restoreResult.blocksRestored,
      authMethod: "UCAN",
    };
  } catch (error) {
    logger.error("\\n💥 UCAN Test failed:", error.message);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    // Cleanup
    logger.info("\\n🧹 Cleaning up...");

    if (targetNode) {
      try {
        await targetNode.orbitdb.stop();
        await targetNode.helia.stop();
        await targetNode.blockstore.close();
        await targetNode.datastore.close();
        logger.info("   ✅ Target node cleaned up");
      } catch (error) {
        logger.warn(`   ⚠️ Target cleanup warning: ${error.message}`);
      }
    }

    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop();
        await sourceNode.helia.stop();
        await sourceNode.blockstore.close();
        await sourceNode.datastore.close();
        logger.info("   ✅ Source node cleaned up");
      } catch (error) {
        logger.warn(`   ⚠️ Source cleanup warning: ${error.message}`);
      }
    }

    // Clean up OrbitDB directories
    logger.info("\\n🧹 Final cleanup - removing OrbitDB directories...");
    await cleanupOrbitDBDirectories();
  }
}

/**
 * Test UCAN Bridge Class Interface
 * @param {Object} [options={}] - UCAN authentication options
 * @param {string} [options.ucanFile] - Path to UCAN delegation CAR file
 * @param {string} [options.ucanToken] - Base64-encoded UCAN delegation token
 * @param {string} [options.recipientKey] - Recipient key for UCAN delegation
 * @param {string} [options.agentDID] - Agent DID (optional, can be auto-detected)
 * @param {string} [options.spaceDID] - Space DID (optional, can be auto-detected)
 * @returns {Promise<Object>} Test result object with success status, method type, and entry count
 */
async function testUCANBridgeClass(options = {}) {
  logger.info("\\n🔧 Testing UCAN Bridge Class Interface");
  logger.info("=".repeat(50));

  let sourceNode, targetNode;

  try {
    // Initialize UCAN Bridge
    const bridge = new OrbitDBStorachaBridgeUCAN({
      ucanFile: options.ucanFile,
      ucanToken: options.ucanToken,
      recipientKey: options.recipientKey,
      agentDID: options.agentDID,
      spaceDID: options.spaceDID,
    });

    // Listen for progress events
    bridge.on("uploadProgress", (progress) => {
      logger.info(
        `   📤 Upload Progress: ${progress.percentage}% (${progress.current}/${progress.total})`,
      );
    });

    bridge.on("downloadProgress", (progress) => {
      logger.info(
        `   📥 Download Progress: ${progress.percentage}% (${progress.current}/${progress.total})`,
      );
    });

    // Create source database
    sourceNode = await createHeliaOrbitDB("-ucan-class-source");
    const sourceDB = await sourceNode.orbitdb.open("ucan-class-demo", {
      type: "keyvalue",
    });

    await sourceDB.set("greeting", "Hello UCAN World!");
    await sourceDB.set("framework", "OrbitDB with Storacha");
    await sourceDB.set("auth", "UCAN-based authentication");

    logger.info(`📊 Source database: ${sourceDB.address}`);

    // Backup using class interface
    logger.info("\\n📤 Backing up with UCAN Bridge class...");
    const backupResult = await bridge.backup(
      sourceNode.orbitdb,
      sourceDB.address,
    );

    if (!backupResult.success) {
      throw new Error(`Class backup failed: ${backupResult.error}`);
    }

    logger.info(
      `✅ Class backup successful: ${backupResult.blocksUploaded} blocks`,
    );

    // Close source
    await sourceDB.close();
    await sourceNode.orbitdb.stop();
    await sourceNode.helia.stop();
    await sourceNode.blockstore.close();
    await sourceNode.datastore.close();

    // Create target and restore
    targetNode = await createHeliaOrbitDB("-ucan-class-target");

    logger.info("\\n📥 Restoring with UCAN Bridge class...");
    const restoreResult = await bridge.restoreFromSpace(targetNode.orbitdb);

    if (!restoreResult.success) {
      throw new Error(`Class restore failed: ${restoreResult.error}`);
    }

    logger.info(
      `✅ Class restore successful: ${restoreResult.entriesRecovered} entries`,
    );
    logger.info(`   📍 Restored to: ${restoreResult.address}`);

    return {
      success: true,
      method: "class-interface",
      entries: restoreResult.entriesRecovered,
    };
  } catch (error) {
    logger.error("❌ Class test failed:", error.message);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    // Cleanup nodes
    if (sourceNode) {
      try {
        await sourceNode.orbitdb.stop();
        await sourceNode.helia.stop();
        await sourceNode.blockstore.close();
        await sourceNode.datastore.close();
      } catch (error) {
        logger.warn(`Source cleanup warning: ${error.message}`);
      }
    }

    if (targetNode) {
      try {
        await targetNode.orbitdb.stop();
        await targetNode.helia.stop();
        await targetNode.blockstore.close();
        await targetNode.datastore.close();
      } catch (error) {
        logger.warn(`Target cleanup warning: ${error.message}`);
      }
    }
  }
}

/**
 * Load and validate UCAN credentials, displaying detailed information
 * @param {Object} options - UCAN options from environment
 * @param {string} [options.ucanFile] - Path to UCAN delegation CAR file
 * @param {string} [options.ucanToken] - Base64-encoded UCAN delegation token
 * @param {string} [options.recipientKey] - Recipient key for UCAN delegation
 * @param {string} [options.agentDID] - Agent DID for validation (optional)
 * @param {string} [options.spaceDID] - Space DID for validation (optional)
 * @returns {Promise<Object>} Loaded UCAN delegation object
 * @throws {Error} If UCAN file or token is missing, invalid, or cannot be parsed
 */
async function validateAndDisplayUCAN(options) {
  logger.info("\\n🔍 Validating UCAN Credentials");
  logger.info("=".repeat(70));

  let delegation = null;
  let source = "";

  try {
    // Try loading from file first
    if (options.ucanFile) {
      logger.info(`📁 Loading UCAN from file: ${options.ucanFile}`);
      source = `file: ${options.ucanFile}`;

      try {
        const carBytes = await fs.readFile(options.ucanFile);
        const result = await Delegation.extract(carBytes);

        if (result.ok) {
          delegation = result.ok;
          logger.info("   ✅ Successfully loaded UCAN from file");
        } else {
          throw new Error("Failed to extract delegation from CAR file");
        }
      } catch (fileError) {
        logger.error(`   ❌ Failed to load from file: ${fileError.message}`);
        throw fileError;
      }
    }
    // Try loading from token
    else if (options.ucanToken) {
      logger.info("🎫 Loading UCAN from token");
      source = "token (base64)";

      try {
        // Clean and normalize the token
        let cleanedToken = options.ucanToken.trim().replace(/\s+/g, "");
        cleanedToken = cleanedToken.replace(/-/g, "+").replace(/_/g, "/");

        while (cleanedToken.length % 4 !== 0) {
          cleanedToken += "=";
        }

        const tokenBytes = Buffer.from(cleanedToken, "base64");

        // Try @ucanto/core/delegation first
        try {
          const result = await Delegation.extract(tokenBytes);
          if (result.ok) {
            delegation = result.ok;
            logger.info(
              "   ✅ Successfully loaded UCAN from token (ucanto/core)",
            );
          } else {
            // result.ok is falsy, try alternative method
            throw new Error("Delegation.extract returned non-ok result");
          }
        } catch (ucantoError) {
          // Try @web3-storage/w3up-client/proof
          try {
            delegation = await Proof.parse(cleanedToken);
            logger.info(
              "   ✅ Successfully loaded UCAN from token (w3up-client/proof)",
            );
          } catch (proofError) {
            throw new Error(
              `Both parsing methods failed. ucanto: ${ucantoError.message}, proof: ${proofError.message}`,
            );
          }
        }
      } catch (tokenError) {
        logger.error(`   ❌ Failed to load from token: ${tokenError.message}`);
        throw tokenError;
      }
    } else {
      throw new Error("No UCAN file or token provided");
    }

    // Check if delegation was successfully loaded
    if (!delegation) {
      throw new Error("Failed to load UCAN delegation - delegation is null");
    }

    // Display UCAN information
    logger.info("\\n📋 UCAN Information:");
    logger.info("=".repeat(70));

    // Basic info
    logger.info(`   📍 Source: ${source}`);

    if (delegation.cid) {
      logger.info(`   🆔 CID: ${delegation.cid.toString()}`);
    }

    if (delegation.issuer) {
      logger.info(`   🔑 Issuer: ${delegation.issuer.did()}`);
    }

    if (delegation.audience) {
      logger.info(`   🎯 Audience: ${delegation.audience.did()}`);
    }

    // Capabilities
    if (delegation.capabilities && delegation.capabilities.length > 0) {
      logger.info(`\\n   📋 Capabilities (${delegation.capabilities.length}):`);

      for (let i = 0; i < delegation.capabilities.length; i++) {
        const cap = delegation.capabilities[i];
        logger.info(`      ${i + 1}. ${cap.can || "unknown"}`);

        if (cap.with) {
          logger.info(`         └─ With: ${cap.with}`);
        }

        if (cap.nb) {
          logger.info(`         └─ Not Before: ${cap.nb}`);
        }

        if (cap.exp) {
          try {
            // Handle Infinity (never expires) as a special case
            if (cap.exp === Infinity || cap.exp === Number.POSITIVE_INFINITY) {
              logger.info(`         └─ Expiration: Never expires`);
              logger.info(`            ✅ Valid (permanent)`);
            } else {
              // Handle different expiration formats
              let expTimestamp = cap.exp;

              // If it's already a Date object, get the timestamp
              if (expTimestamp instanceof Date) {
                expTimestamp = expTimestamp.getTime() / 1000; // Convert to seconds
              }
              // If it's a string, try to parse it
              else if (typeof expTimestamp === "string") {
                const parsed = Date.parse(expTimestamp);
                if (!isNaN(parsed)) {
                  expTimestamp = Math.floor(parsed / 1000); // Convert to seconds
                }
              }
              // If it's a number, check if it's in seconds or milliseconds
              else if (typeof expTimestamp === "number") {
                // Check for Infinity first
                if (!isFinite(expTimestamp)) {
                  logger.info(`         └─ Expiration: Never expires`);
                  logger.info(`            ✅ Valid (permanent)`);
                  continue; // Skip to next capability
                }
                // If it's greater than a reasonable timestamp in seconds (year 2100), it's likely in milliseconds
                if (expTimestamp > 4102444800) {
                  // Jan 1, 2100 in seconds
                  expTimestamp = Math.floor(expTimestamp / 1000); // Convert from milliseconds to seconds
                }
              }

              // Validate the timestamp
              if (!expTimestamp || isNaN(expTimestamp) || expTimestamp <= 0) {
                logger.warn(
                  `         └─ Expiration: Invalid format (${cap.exp})`,
                );
              } else {
                const expDate = new Date(expTimestamp * 1000);
                const now = new Date();

                // Check if date is valid
                if (isNaN(expDate.getTime())) {
                  logger.warn(
                    `         └─ Expiration: Invalid date (${cap.exp})`,
                  );
                } else {
                  const isValid = expDate > now;
                  const timeLeft = Math.floor(
                    (expDate - now) / 1000 / 60 / 60 / 24,
                  ); // days

                  logger.info(
                    `         └─ Expiration: ${expDate.toISOString()}`,
                  );
                  logger.info(
                    `            ${isValid ? "✅" : "❌"} ${isValid ? `Valid (${timeLeft} days left)` : "EXPIRED"}`,
                  );
                }
              }
            }
          } catch (expError) {
            logger.warn(
              `         └─ Expiration: Error parsing (${expError.message})`,
            );
          }
        }
      }
    } else {
      logger.warn("   ⚠️  No capabilities found");
    }

    // Check expiration from root UCAN if available
    if (delegation.expiration) {
      try {
        // Handle Infinity (never expires) as a special case
        if (
          delegation.expiration === Infinity ||
          delegation.expiration === Number.POSITIVE_INFINITY
        ) {
          logger.info(
            `\\n   ⏰ Overall Expiration: Never expires (no expiration set)`,
          );
          logger.info(`      ✅ Valid (permanent)`);
        } else {
          // Handle different expiration formats
          let expTimestamp = delegation.expiration;

          // If it's already a Date object, get the timestamp
          if (expTimestamp instanceof Date) {
            expTimestamp = expTimestamp.getTime() / 1000; // Convert to seconds
          }
          // If it's a string, try to parse it
          else if (typeof expTimestamp === "string") {
            const parsed = Date.parse(expTimestamp);
            if (!isNaN(parsed)) {
              expTimestamp = Math.floor(parsed / 1000); // Convert to seconds
            }
          }
          // If it's a number, check if it's in seconds or milliseconds
          else if (typeof expTimestamp === "number") {
            // Check for Infinity first
            if (!isFinite(expTimestamp)) {
              logger.info(
                `\\n   ⏰ Overall Expiration: Never expires (no expiration set)`,
              );
              logger.info(`      ✅ Valid (permanent)`);
              return; // Exit early for Infinity case
            }
            // If it's greater than a reasonable timestamp in seconds (year 2100), it's likely in milliseconds
            if (expTimestamp > 4102444800) {
              // Jan 1, 2100 in seconds
              expTimestamp = Math.floor(expTimestamp / 1000); // Convert from milliseconds to seconds
            }
          }

          // Validate the timestamp
          if (!expTimestamp || isNaN(expTimestamp) || expTimestamp <= 0) {
            logger.warn(
              `\\n   ⏰ Overall Expiration: Invalid format (${delegation.expiration})`,
            );
          } else {
            const expDate = new Date(expTimestamp * 1000);
            const now = new Date();

            // Check if date is valid
            if (isNaN(expDate.getTime())) {
              logger.warn(
                `\\n   ⏰ Overall Expiration: Invalid date (${delegation.expiration})`,
              );
            } else {
              const isValid = expDate > now;
              const timeLeft = Math.floor(
                (expDate - now) / 1000 / 60 / 60 / 24,
              ); // days

              logger.info(
                `\\n   ⏰ Overall Expiration: ${expDate.toISOString()}`,
              );
              logger.info(
                `      ${isValid ? "✅" : "❌"} ${isValid ? `Valid (${timeLeft} days left)` : "EXPIRED"}`,
              );
            }
          }
        }
      } catch (expError) {
        logger.warn(
          `\\n   ⏰ Overall Expiration: Error parsing (${expError.message})`,
        );
      }
    }

    // Try to validate by creating a test client
    logger.info("\\n🔬 Validation Test:");
    logger.info("=".repeat(70));

    try {
      // Check if audience is a proper principal object
      // If it's just a DID string, we can't create a client without a signer
      if (
        delegation.audience &&
        typeof delegation.audience.did === "function"
      ) {
        const store = new StoreMemory();
        const testClient = await Client.create({
          principal: delegation.audience,
          store,
        });

        const testSpace = await testClient.addSpace(delegation);
        await testClient.setCurrentSpace(testSpace.did());

        logger.info("   ✅ UCAN is valid and can be used with Storacha");
        logger.info(`   🚀 Test Space DID: ${testSpace.did()}`);

        if (options.spaceDID) {
          const spaceMatch = testSpace.did() === options.spaceDID;
          logger.info(
            `   ${spaceMatch ? "✅" : "⚠️"} Space DID match: ${spaceMatch ? "YES" : "NO"}`,
          );
          if (!spaceMatch) {
            logger.info(`      Expected: ${options.spaceDID}`);
            logger.info(`      Got: ${testSpace.did()}`);
          }
        }

        if (options.agentDID) {
          const agentMatch = delegation.audience.did() === options.agentDID;
          logger.info(
            `   ${agentMatch ? "✅" : "⚠️"} Agent DID match: ${agentMatch ? "YES" : "NO"}`,
          );
          if (!agentMatch) {
            logger.info(`      Expected: ${options.agentDID}`);
            logger.info(`      Got: ${delegation.audience.did()}`);
          }
        }
      } else {
        logger.info(
          "   ⚠️  Cannot perform full client validation (audience is not a signer principal)",
        );
        logger.info("   ✅ UCAN structure is valid (parsed successfully)");
        logger.info(
          `   🎯 Audience DID: ${delegation.audience?.did ? delegation.audience.did() : delegation.audience}`,
        );

        if (options.agentDID) {
          const audienceDID = delegation.audience?.did
            ? delegation.audience.did()
            : delegation.audience;
          const agentMatch = audienceDID === options.agentDID;
          logger.info(
            `   ${agentMatch ? "✅" : "⚠️"} Agent DID match: ${agentMatch ? "YES" : "NO"}`,
          );
          if (!agentMatch) {
            logger.info(`      Expected: ${options.agentDID}`);
            logger.info(`      Got: ${audienceDID}`);
          }
        }
      }
    } catch (validationError) {
      // Don't fail validation if client creation fails - the UCAN structure is still valid
      logger.warn(
        `   ⚠️  Client validation test failed: ${validationError.message}`,
      );
      logger.info("   ✅ UCAN structure is valid (parsed successfully)");
      logger.info(
        `   🎯 Audience DID: ${delegation.audience?.did ? delegation.audience.did() : delegation.audience}`,
      );
      logger.info(
        "   ℹ️  Note: Full client validation requires a signer principal, but UCAN structure is valid",
      );

      if (options.agentDID) {
        const audienceDID = delegation.audience?.did
          ? delegation.audience.did()
          : delegation.audience;
        const agentMatch = audienceDID === options.agentDID;
        logger.info(
          `   ${agentMatch ? "✅" : "⚠️"} Agent DID match: ${agentMatch ? "YES" : "NO"}`,
        );
        if (!agentMatch) {
          logger.info(`      Expected: ${options.agentDID}`);
          logger.info(`      Got: ${audienceDID}`);
        }
      }
    }

    logger.info("\\n" + "=".repeat(70));

    return delegation;
  } catch (error) {
    logger.error("\\n❌ UCAN Validation Failed:");
    logger.error(`   ${error.message}`);
    throw error;
  }
}

/**
 * Wait for user input to proceed
 * @returns {Promise<void>}
 */
function waitForUserInput() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      "\n⏸️  Press Enter to proceed with the demo, or Ctrl+C to exit... ",
      () => {
        rl.close();
        resolve();
      },
    );
  });
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info("🔐 OrbitDB Storacha Bridge - UCAN Authentication Demo");
  logger.info("=".repeat(70));

  // Check for command line argument to use files
  const useFiles =
    process.argv.includes("--from-files") ||
    process.argv.includes("--files") ||
    process.argv.includes("-f");

  let ucanOptions = {};

  if (useFiles) {
    logger.info("📁 Reading UCAN credentials from files...");

    try {
      // Read recipient key from file
      const recipientKeyPath = "recipient-key.txt";
      const recipientKeyContent = await fs.readFile(recipientKeyPath, "utf-8");
      const recipientKey = recipientKeyContent.trim();

      // Read delegation token from file
      const delegationTokenPath = "delegation-token.txt";
      const delegationTokenContent = await fs.readFile(
        delegationTokenPath,
        "utf-8",
      );
      const delegationToken = delegationTokenContent.trim();

      logger.info(`   ✅ Loaded recipient key from: ${recipientKeyPath}`);
      logger.info(`   ✅ Loaded delegation token from: ${delegationTokenPath}`);

      ucanOptions = {
        ucanToken: delegationToken,
        recipientKey: recipientKey,
        // agentDID and spaceDID can be auto-detected from the UCAN
        agentDID: process.env.STORACHA_AGENT_DID,
        spaceDID: process.env.STORACHA_SPACE_DID,
      };

      logger.info("🔐 UCAN Configuration (from files):");
      logger.info(`   📁 Recipient Key: ✅ (from ${recipientKeyPath})`);
      logger.info(`   🎫 Delegation Token: ✅ (from ${delegationTokenPath})`);
      logger.info(`   🤖 Agent DID: ${ucanOptions.agentDID || "auto-detect"}`);
      logger.info(`   🚀 Space DID: ${ucanOptions.spaceDID || "auto-detect"}`);
    } catch (fileError) {
      logger.error("❌ Failed to read UCAN files:");
      logger.error(`   ${fileError.message}`);
      logger.error(
        "   Make sure recipient-key.txt and delegation-token.txt exist in the current directory",
      );
      process.exit(1);
    }
  } else {
    // Use .env values as before
    const hasUCANFile = !!process.env.STORACHA_UCAN_FILE;
    const hasUCANToken = !!process.env.STORACHA_UCAN_TOKEN;

    if (!hasUCANFile && !hasUCANToken) {
      logger.error("❌ Missing UCAN credentials!");
      logger.error(
        "   Set either STORACHA_UCAN_FILE or STORACHA_UCAN_TOKEN in your .env file",
      );
      logger.error(
        "   Or use --from-files to read from recipient-key.txt and delegation-token.txt",
      );
      logger.error("   See docs/UCAN_SETUP.md for instructions");
      process.exit(1);
    }

    logger.info("🔐 UCAN Configuration (from .env):");
    logger.info(`   📁 UCAN File: ${hasUCANFile ? "✅" : "❌"}`);
    logger.info(`   🎫 UCAN Token: ${hasUCANToken ? "✅" : "❌"}`);
    logger.info(
      `   🤖 Agent DID: ${process.env.STORACHA_AGENT_DID || "auto-detect"}`,
    );
    logger.info(
      `   🚀 Space DID: ${process.env.STORACHA_SPACE_DID || "auto-detect"}`,
    );

    ucanOptions = {
      ucanFile: process.env.STORACHA_UCAN_FILE,
      ucanToken: process.env.STORACHA_UCAN_TOKEN,
      agentDID: process.env.STORACHA_AGENT_DID,
      spaceDID: process.env.STORACHA_SPACE_DID,
    };
  }

  // Validate UCAN credentials and wait for user confirmation
  try {
    await validateAndDisplayUCAN(ucanOptions);
    await waitForUserInput();
  } catch (error) {
    logger.error("\\n💥 Failed to validate UCAN credentials:");
    logger.error(`   ${error.message}`);
    process.exit(1);
  }

  // Run both tests
  Promise.resolve()
    .then(async () => {
      // Update the test functions to use the same options
      const functionResult = await testOrbitDBStorachaBridgeUCAN(ucanOptions);
      const classResult = await testUCANBridgeClass(ucanOptions);

      logger.info("\\n🏁 Final Results:");
      logger.info(
        `   Function Interface: ${functionResult.success ? "✅" : "❌"}`,
      );
      logger.info(`   Class Interface: ${classResult.success ? "✅" : "❌"}`);

      const overallSuccess = functionResult.success && classResult.success;

      if (overallSuccess) {
        logger.info("\\n🎉 UCAN Demo completed successfully!");
        process.exit(0);
      } else {
        logger.error("\\n❌ UCAN Demo failed!");
        process.exit(1);
      }
    })
    .catch((error) => {
      logger.error("\\n💥 UCAN Demo crashed:", error.message);
      process.exit(1);
    });
}

export { testOrbitDBStorachaBridgeUCAN, testUCANBridgeClass };
