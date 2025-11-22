/**
 * OrbitDB Storacha Bridge - Utility Functions
 *
 * Common utility functions for OrbitDB operations and cleanup
 */

import { createLibp2p } from "libp2p";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { bootstrap } from "@libp2p/bootstrap";
import { createHelia } from "helia";
import { createOrbitDB } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { logger } from "./logger.js";

/**
 * Default IPFS bootstrap nodes (public IPFS network)
 * Enhanced list with both DNS and direct IP addresses for better connectivity
 */
const DEFAULT_BOOTSTRAP_NODES = [
  // Official IPFS bootstrap nodes (DNS)
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  // Direct IP bootstrap (more reliable in restricted networks)
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  '/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];

/**
 * Clean up OrbitDB directories
 */
export async function cleanupOrbitDBDirectories() {
  const fs = await import("fs");

  try {
    const entries = await fs.promises.readdir(".", { withFileTypes: true });
    const orbitdbDirs = entries.filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith("orbitdb-bridge-") ||
          entry.name.includes("orbitdb-bridge-")),
    );

    for (const dir of orbitdbDirs) {
      try {
        await fs.promises.rm(dir.name, { recursive: true, force: true });
        logger.info(`Cleaned up: ${dir.name}`);
        logger.info({ directory: dir.name }, `🧹 Cleaned up: ${dir.name}`);
      } catch (error) {
        logger.warn(`Could not clean up ${dir.name}: ${error.message}`);
      }
    }

    if (orbitdbDirs.length === 0) {
      logger.info("🧹 No OrbitDB directories to clean up");
    } else {
      logger.info(`Cleaned up ${orbitdbDirs.length} OrbitDB directories`);
    }
  } catch (error) {
    logger.warn(`Cleanup warning: ${error.message}`);
  }
}

/**
 * Clean up all test-related directories and CAR files
 * This function removes all common test artifacts created during testing
 */
export async function cleanupAllTestArtifacts() {
  const fs = await import("fs");
  // const path = await import('path') // Currently unused

  logger.info("🧹 Starting comprehensive test cleanup...");

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

  // CAR files to clean up (common patterns)
  // const carFilePatterns = [
  //   'test-*.car',
  //   '*-test.car',
  //   'todos-backup.car',
  //   'storacha-hash-preservation-test.car'
  // ]

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
  await cleanupOrbitDBDirectories();

  logger.info(
    `Comprehensive cleanup completed: ${cleanedDirs} directories, ${cleanedFiles} CAR files`,
  );
}

/**
 * Clean up specific test directory and associated CAR files
 * @param {string} testDir - The test directory path
 * @param {string} [carPrefix] - Optional prefix for CAR files to clean
 */
export async function cleanupTestDirectory(testDir, carPrefix = "") {
  const fs = await import("fs");

  try {
    // Remove test directory
    await fs.promises.rm(testDir, { recursive: true, force: true });
    logger.info(`Removed test directory: ${testDir}`);

    // Remove associated CAR files if prefix provided
    if (carPrefix) {
      try {
        const entries = await fs.promises.readdir(".", { withFileTypes: true });
        const carFiles = entries.filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".car") &&
            entry.name.includes(carPrefix),
        );

        for (const carFile of carFiles) {
          await fs.promises.unlink(carFile.name);
          logger.info(`Removed CAR file: ${carFile.name}`);
        }
      } catch (error) {
        logger.warn(
          `Error cleaning CAR files with prefix ${carPrefix}: ${error.message}`,
        );
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(
        `Could not clean up test directory ${testDir}: ${error.message}`,
      );
    }
  }
}

/**
 * Create a Helia/OrbitDB instance with specified suffix
 * @param {string} suffix - Suffix for directory names
 * @param {boolean} connectToPublicNetwork - Whether to connect to public IPFS network (default: false for tests)
 * 
 * Enhanced with improved connectivity based on helia-examples patterns
 */
export async function createHeliaOrbitDB(suffix = "", connectToPublicNetwork = false) {
  const libp2pConfig = {
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0"],
    },
    transports: [
      tcp({
        // Enable connection limits - these are REQUIRED for proper peer management
        maxConnections: 300,
        closeServerOnMaxConnections: {
          closeAbove: 300,
          listenBelow: 250
        }
      })
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ 
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        // Enable peer exchange for better connectivity
        doPX: true,
        // Faster heartbeat for quicker peer discovery
        heartbeatInterval: 1000
      }),
    },
    connectionManager: {
      minConnections: 25,
      maxConnections: 300,
      // Auto-dial known peers for better connectivity
      autoDial: true,
      autoDialInterval: 10000
    },
  };

  // Add enhanced bootstrap configuration for public network
  if (connectToPublicNetwork) {
    libp2pConfig.peerDiscovery = [
      bootstrap({
        list: DEFAULT_BOOTSTRAP_NODES,
      }),
    ];
    
    logger.info('🌐 Configuring Helia to connect to public IPFS network');
  }

  const libp2p = await createLibp2p(libp2pConfig);

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const blockstore = new LevelBlockstore(
    `./orbitdb-bridge-${uniqueId}${suffix}`,
  );
  const datastore = new LevelDatastore(
    `./orbitdb-bridge-${uniqueId}${suffix}-data`,
  );

  const helia = await createHelia({ libp2p, blockstore, datastore });
  const orbitdb = await createOrbitDB({ 
    ipfs: helia,
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`
  });

  // Wait for peer discovery if connecting to public network
  // This gives the connection manager and bootstrap time to establish connections
  if (connectToPublicNetwork) {
    logger.info('⏳ Waiting for peer discovery...');
    
    // Use event-based peer discovery instead of polling
    const peerCount = await new Promise((resolve) => {
      let count = 0;
      const timeout = setTimeout(() => {
        resolve(count);
      }, 9000); // 9 second timeout
      
      const onPeerConnect = () => {
        count++;
        logger.info(`🔍 Connected to ${count} peer${count !== 1 ? 's' : ''}`);
        if (count === 1) {
          // Resolve after first peer connects
          clearTimeout(timeout);
          resolve(count);
        }
      };
      
      libp2p.addEventListener('peer:connect', onPeerConnect);
      
      // Check if already connected
      const currentPeers = libp2p.getPeers().length;
      if (currentPeers > 0) {
        clearTimeout(timeout);
        libp2p.removeEventListener('peer:connect', onPeerConnect);
        resolve(currentPeers);
      }
    });
    
    logger.info(`🌐 Connected to ${peerCount} peer${peerCount !== 1 ? 's' : ''}`);
  }

  return { helia, orbitdb, libp2p, blockstore, datastore };
}
