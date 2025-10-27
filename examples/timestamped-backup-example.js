/**
 * Example implementation showing how to use timestamped backup files
 * NOTE: This is a placeholder example - not a complete working implementation
 */

/* eslint-disable no-undef */
import { Readable } from "stream";
import { CarReader } from "@ipld/car";
import { Signer } from "@storacha/client/principal/ed25519";
import CARStorage from "./car-storage.js";

// Helper function to generate backup prefix
function generateBackupPrefix(spaceName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${spaceName}/backup-${timestamp}`;
}

// Helper function to get backup filenames
function getBackupFilenames(prefix) {
  return {
    metadata: `${prefix}-metadata.json`,
    blocks: `${prefix}-blocks.car`,
  };
}

// Helper function to find latest backup
function findLatestBackup(spaceFiles) {
  const backupFiles = spaceFiles
    .map((f) => f.root.toString())
    .filter((f) => f.match(/backup-.*-(metadata|blocks)\./))
    .sort((a, b) => b.localeCompare(a)); // Sort descending

  const latestMetadata = backupFiles.find((f) => f.endsWith("metadata.json"));
  const latestBlocks = backupFiles.find((f) => f.endsWith("blocks.car"));

  return latestMetadata && latestBlocks
    ? { metadata: latestMetadata, blocks: latestBlocks }
    : null;
}

// Example backup function
async function createBackup(spaceName, databases, options = {}) {
  // Create storage and extract blocks as before
  const storage = await CARStorage({
    path: ".",
    name: "backup-temp",
    autoFlush: false,
  });

  // Extract blocks and create metadata as before
  const { blocks, blockSources } = await extractDatabaseBlocks(databases[0]);
  const metadata = {
    timestamp: Date.now(),
    databaseCount: databases.length,
    // ... other metadata
  };

  // Generate backup paths with timestamp
  const backupPrefix = generateBackupPrefix(spaceName);
  const backupFiles = getBackupFilenames(backupPrefix);

  // Write backup files with timestamp in name
  await Signer.writeFile(
    backupFiles.metadata,
    JSON.stringify(metadata, null, 2),
  );

  await storage.persist();
  const reader = await CarReader.fromIterable(storage.iterator());
  const stream = Readable.from(reader.blocks());

  await stream.pipe(
    await createWritableCarReader({
      name: backupFiles.blocks,
      comment: `OrbitDB backup blocks (created at ${new Date().toISOString()})`,
      space: spaceName,
    }),
  );

  return {
    success: true,
    metadata: backupFiles.metadata,
    blocks: backupFiles.blocks,
  };
}

// Example restore function
async function restoreBackup(spaceName, options = {}) {
  // List all files in the space
  const spaceFiles = await listStorachaSpaceFiles(options);

  // Find the latest backup files
  const latestBackup = findLatestBackup(spaceFiles);
  if (!latestBackup) {
    throw new Error("No complete backup found in space");
  }

  // Read metadata and blocks from latest backup
  const metadata = JSON.parse(
    await Signer.readFile(`${spaceName}/${latestBackup.metadata}`),
  );
  const carStream = await Signer.readStream(
    `${spaceName}/${latestBackup.blocks}`,
  );

  // Rest of restore process as before...
  return {
    success: true,
    backupTimestamp: metadata.timestamp,
    // ... other restore results
  };
}
