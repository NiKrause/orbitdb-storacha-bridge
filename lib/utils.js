/**
 * OrbitDB Storage Bridge - Utility Functions
 *
 * Common utility functions for OrbitDB operations and cleanup
 */

import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { bootstrap } from "@libp2p/bootstrap";
import { gossipsub } from "@libp2p/gossipsub";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { createOrbitDB } from "@orbitdb/core";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { logger, createLogger } from "./logger.js";

const HELIA_LOGGER = createLogger("helia");
const HELIA_COLOR = "\x1b[95m";
const COLOR_RESET = "\x1b[0m";

function logHelia(message) {
  HELIA_LOGGER(`${HELIA_COLOR}${message}${COLOR_RESET}`);
}

function attachHeliaLogging(libp2p, label) {
  const prefix = label ? `[${label}] ` : "";
  const safePeer = (peer) =>
    typeof peer?.toString === "function" ? peer.toString() : `${peer ?? ""}`;

  libp2p.addEventListener("peer:connect", (evt) => {
    logHelia(`${prefix}peer:connect ${safePeer(evt?.detail)}`);
  });
  libp2p.addEventListener("peer:disconnect", (evt) => {
    logHelia(`${prefix}peer:disconnect ${safePeer(evt?.detail)}`);
  });
  libp2p.addEventListener("peer:discovery", (evt) => {
    logHelia(`${prefix}peer:discovery ${safePeer(evt?.detail?.id)}`);
  });
  libp2p.addEventListener("connection:open", (evt) => {
    logHelia(`${prefix}connection:open ${safePeer(evt?.detail?.remotePeer)}`);
  });
  libp2p.addEventListener("connection:close", (evt) => {
    logHelia(`${prefix}connection:close ${safePeer(evt?.detail?.remotePeer)}`);
  });
}

/**
 * Bootstrap nodes for connecting to the public IPFS network
 * Based on working implementation from commit 556736f
 */
const BOOTSTRAP_NODES = [
  // Official IPFS bootstrap nodes
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  // Direct IP bootstrap (more reliable in restricted networks)
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
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
 * Enhanced with bootstrap nodes for connecting to the public IPFS network
 * @param {string} suffix - Suffix for directory names
 * @param {Object} options - Configuration options
 * @param {boolean} options.dhtClientMode - If true, use DHT in client-only mode (default: true).
 *                                          Client mode works better behind NAT. Set to false for
 *                                          full DHT server mode (requires public IP).
 */
export async function createHeliaOrbitDB(suffix = "", options = {}) {
  const {
    dhtClientMode = true,
    useBootstrap = true,
    useDHT = true,
    maxConnections = 30,
  } = options; // Default to client mode for better NAT compatibility

  const listenAddresses = process.env.LIBP2P_LISTEN_ADDRS
    ? process.env.LIBP2P_LISTEN_ADDRS.split(",").map((addr) => addr.trim())
    : process.env.JEST_WORKER_ID || process.env.NODE_ENV === "test"
      ? ["/ip4/127.0.0.1/tcp/0"]
      : ["/ip4/0.0.0.0/tcp/0"];

  const services = {
    identify: identify(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    ping: ping(),
  };
  if (useDHT) {
    services.dht = kadDHT({
      clientMode: dhtClientMode,
    });
  }
  // Bootstrapping is peer discovery, not a service.
  const peerDiscovery = useBootstrap
    ? [
        bootstrap({
          list: BOOTSTRAP_NODES,
          tagName: "bootstrap",
          tagValue: 50,
          tagTTL: 120000, // 2 minutes
        }),
      ]
    : [];

  // Helia 7 builds the libp2p node itself, from these options — it does not
  // take a node built elsewhere. Every key left out is filled from Helia's own
  // defaults, which dial the public network (mDNS, public bootstrap peers,
  // UPnP, a relay server), so each key this node depends on is spelled out,
  // peerDiscovery included, even when it is empty.
  const libp2pOptions = {
    addresses: {
      listen: listenAddresses,
    },
    transports: [
      tcp({
        // Enable connection limits - reduced to prevent excessive connections
        maxConnections: {
          inbound: 20,
          outbound: 20,
        },
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      // Limit total connections to prevent excessive network usage
      maxConnections,
    },
    peerDiscovery,
    services,
  };

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const blockstore = new LevelBlockstore(
    `./orbitdb-bridge-${uniqueId}${suffix}`,
  );
  const datastore = new LevelDatastore(
    `./orbitdb-bridge-${uniqueId}${suffix}-data`,
  );

  const helia = await createHelia({
    libp2p: libp2pOptions,
    blockstore,
    datastore,
  }).start();
  const libp2p = helia.libp2p;
  attachHeliaLogging(libp2p, suffix || "orbitdb");
  const fs = unixfs(helia);
  const orbitdb = await createOrbitDB({
    ipfs: helia,
    directory: `./orbitdb-bridge-${uniqueId}${suffix}-orbitdb`,
  });

  return { helia, orbitdb, libp2p, blockstore, datastore, unixfs: fs };
}
