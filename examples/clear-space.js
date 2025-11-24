#!/usr/bin/env node

/**
 * Clear Storacha Space Script
 *
 * This script clears all files from your Storacha space using the library's
 * clearStorachaSpace function. Useful for manual cleanup during development.
 *
 * Usage:
 *   node scripts/clear-space.js [--batch-size=N]
 *
 * Options:
 *   --batch-size=N  Process deletions in batches of N files (default: 10)
 */

import "dotenv/config";
import { clearStorachaSpace } from "../lib/orbitdb-storacha-bridge.js";
import { logger } from "../lib/logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let batchSize = 10; // Default batch size

  for (const arg of args) {
    if (arg.startsWith("--batch-size=")) {
      const size = parseInt(arg.split("=")[1]);
      if (size > 0) {
        batchSize = size;
      } else {
        logger.error("❌ Invalid batch size. Must be a positive number.");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      logger.info("Usage: node scripts/clear-space.js [--batch-size=N]");
      logger.info("Options:");
      logger.info(
        "  --batch-size=N  Process deletions in batches of N files (default: 10)",
      );
      process.exit(0);
    }
  }

  return { batchSize };
}

async function main() {
  const { batchSize } = parseArgs();

  logger.info("🚀 Starting Storacha Space Cleanup");
  logger.info("=".repeat(50));
  logger.info(`📦 Batch size: ${batchSize} files per batch`);

  if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
    logger.error("❌ Missing Storacha credentials!");
    logger.error(
      "   Please set STORACHA_KEY and STORACHA_PROOF in your .env file",
    );
    process.exit(1);
  }

  try {
    const result = await clearStorachaSpace({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      batchSize,
    });

    if (result.success) {
      logger.info("\\n🎉 Space cleared successfully!");
      process.exit(0);
    } else {
      logger.warn("\\n⚠️ Space clearing completed with some failures");
      // In CI, partial success is acceptable - some files may be locked
      // Only fail if we're in strict mode or if no files were deleted at all
      const hasPartialSuccess = result.totalRemoved > 0;
      if (hasPartialSuccess) {
        logger.info(
          `   ℹ️  Removed ${result.totalRemoved} files, continuing...`,
        );
        process.exit(0); // Partial success is OK
      } else {
        logger.error("   ❌ No files were removed");
        process.exit(1); // Complete failure
      }
    }
  } catch (error) {
    logger.error("\\n💥 Space clearing failed:", error.message);
    process.exit(1);
  }
}

main();
