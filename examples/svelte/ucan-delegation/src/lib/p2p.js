/**
 * LibP2P Configuration and Relay Management
 *
 * Handles dynamic relay configuration, peer discovery, and circuit relay setup
 * for both local development and production environments.
 */

import { createLibp2p } from "libp2p";
import { createHelia } from "helia";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { webSockets } from "@libp2p/websockets";
import { webRTC } from "@libp2p/webrtc";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { dcutr } from "@libp2p/dcutr";
import { autoNAT } from "@libp2p/autonat";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { bootstrap } from "@libp2p/bootstrap";
import { logger } from "../../../lib/logger.js";
import { all } from "@libp2p/websockets/filters";

// Local relay configuration (your relay)
const LOCAL_RELAY_ADDRESSES = [
  "/ip4/127.0.0.1/tcp/4101/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip4/192.168.178.110/tcp/4101/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip6/::1/tcp/4101/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip6/fd6b:da00:55cf:0:c83:76ad:153a:f465/tcp/4101/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip4/127.0.0.1/tcp/4102/ws/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip4/192.168.178.110/tcp/4102/ws/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip6/::1/tcp/4102/ws/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
  "/ip6/fd6b:da00:55cf:0:c83:76ad:153a:f465/tcp/4102/ws/p2p/12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD",
];

// Production relay configuration (kept commented out as requested)
// const RELAY_BOOTSTRAP_ADDR_PROD = [
//   '/dns4/159-69-119-82.k51qzi5uqu5dmexampleadr.libp2p.direct/tcp/4002/wss/p2p/12D3ExampleProductionRelay',
// ];

const PUBSUB_TOPICS = ["todo._peer-discovery._p2p._pubsub"];

// Global relay configuration
let RELAY_BOOTSTRAP_ADDR = null;
let RELAY_PEER_ID = null;

// Environment configuration
const USE_LOCAL_RELAY = import.meta.env.VITE_USE_LOCAL_RELAY === "true";
const LOCAL_RELAY_HEALTH_URL = "http://localhost:3000/health";

/**
 * Fetch local relay peer ID dynamically from health endpoint
 * @returns {Promise<string|null>} Local relay peer ID or null if unavailable
 */
export async function getLocalRelayInfo() {
  if (!USE_LOCAL_RELAY) return null;

  try {
    const [healthResponse, multiaddrsResponse] = await Promise.all([
      fetch(LOCAL_RELAY_HEALTH_URL),
      fetch("http://localhost:3000/multiaddrs"),
    ]);

    if (healthResponse.ok && multiaddrsResponse.ok) {
      const health = await healthResponse.json();
      const multiaddrs = await multiaddrsResponse.json();

      logger.info("🏠 Local relay discovered:", {
        peerId: health.peerId,
        uptime: health.uptime,
        totalAddresses: multiaddrs.addressInfo?.totalAddresses,
      });

      // Use the websocket addresses from the relay
      const websocketAddresses = multiaddrs.byTransport?.websocket || [];
      const bestWebsocketAddr = multiaddrs.best?.websocket;

      logger.info("🔌 Available websocket addresses:", websocketAddresses);
      logger.info("🎯 Best websocket address:", bestWebsocketAddr);

      return {
        peerId: health.peerId,
        websocketAddresses,
        bestWebsocketAddr,
        health,
        multiaddrs,
      };
    }
  } catch (error) {
    logger.warn({ error: error.message }, "⚠️ Local relay not available:");
  }
  return null;
}

/**
 * Initialize relay configuration based on environment
 * Checks for local relay availability and falls back to production relays
 */
export async function initializeRelayConfig() {
  if (RELAY_BOOTSTRAP_ADDR) {
    logger.info("✅ Relay configuration already initialized");
    return RELAY_BOOTSTRAP_ADDR;
  }

  if (USE_LOCAL_RELAY) {
    logger.info("🏠 Development mode: Attempting to use local relay...");
    const localRelayInfo = await getLocalRelayInfo();

    if (localRelayInfo) {
      RELAY_PEER_ID = localRelayInfo.peerId;

      // Use all available websocket addresses from the relay
      const websocketAddresses = localRelayInfo.websocketAddresses;

      if (websocketAddresses && websocketAddresses.length > 0) {
        RELAY_BOOTSTRAP_ADDR = websocketAddresses;
        logger.info("✅ Using local relay websocket addresses:");
        websocketAddresses.forEach((addr, i) => {
          logger.info(`   ${i + 1}. ${addr}`);
        });
        return RELAY_BOOTSTRAP_ADDR;
      } else {
        logger.info(
          "⚠️ Local relay found but no websocket addresses available",
        );
      }
    } else {
      logger.info(
        "⚠️ Local relay not available, falling back to static local addresses",
      );
    }

    // Fallback to static local relay addresses when dynamic discovery fails
    RELAY_BOOTSTRAP_ADDR = LOCAL_RELAY_ADDRESSES;
    RELAY_PEER_ID = "12D3KooWFWHLsJT7ADZ2xZGxVpnEAmb3rXVBhCGhiqtVJ9A4VuMD";
    logger.info("✅ Using static local relay addresses:");
    LOCAL_RELAY_ADDRESSES.forEach((addr, i) => {
      logger.info(`   ${i + 1}. ${addr}`);
    });
    return RELAY_BOOTSTRAP_ADDR;
  }

  // No relays configured - return empty array for no-bootstrap mode
  RELAY_BOOTSTRAP_ADDR = [];
  logger.info("⚠️ No relay configuration available");
  logger.info(
    "   📡 Running in no-bootstrap mode (peer discovery via pubsub only)",
  );

  return RELAY_BOOTSTRAP_ADDR;
}

/**
 * Get current relay configuration
 * @returns {Array<string>} Array of relay multiaddresses
 */
export function getRelayAddresses() {
  return RELAY_BOOTSTRAP_ADDR || [];
}

/**
 * Check if using local relay
 * @returns {boolean} True if using local relay
 */
export function isUsingLocalRelay() {
  return USE_LOCAL_RELAY && RELAY_PEER_ID !== null;
}

/**
 * Create libp2p configuration with enhanced relay support
 * @param {Object} options - Configuration options
 * @param {Uint8Array} [options.privateKey] - Private key for the node
 * @param {boolean} [options.enablePeerConnections=true] - Enable peer discovery
 * @param {boolean} [options.enableNetworkConnection=true] - Enable network connections
 * @param {boolean} [options.enableReservations=true] - Enable circuit relay reservations
 * @returns {Promise<Object>} LibP2P configuration object
 */
export async function createLibp2pConfig(options = {}) {
  const {
    privateKey = null,
    enablePeerConnections = true,
    enableNetworkConnection = true,
    enableReservations = true,
  } = options;

  await initializeRelayConfig();
  logger.info("🔧 Creating libp2p configuration...");
  logger.info(
    `   🔗 Network connections: ${enableNetworkConnection ? "enabled" : "disabled"}`,
  );
  logger.info(
    `   👥 Peer discovery: ${enablePeerConnections ? "enabled" : "disabled"}`,
  );
  logger.info(
    `   🔄 Circuit relay reservations: ${enableReservations ? "enabled" : "disabled"}`,
  );

  // Configure peer discovery services
  const peerDiscoveryServices = [];
  if (enablePeerConnections && enableNetworkConnection) {
    logger.info("🔍 Enabling enhanced peer discovery...");
    logger.info(`   📬 Pubsub topics: ${PUBSUB_TOPICS.join(", ")}`);

    peerDiscoveryServices.push(
      pubsubPeerDiscovery({
        interval: 3000, // More frequent broadcasting for faster discovery
        topics: PUBSUB_TOPICS,
        listenOnly: false,
        emitSelf: false, // Don't emit to self, focus on finding other peers
      }),
    );

    logger.info("✅ Pubsub peer discovery configured");
    logger.info(
      `   🔄 Broadcasting every 3 seconds on topics: ${PUBSUB_TOPICS}`,
    );
  }

  // Configure services based on network connection preference
  const services = {
    identify: identify(),
    pubsub: gossipsub({
      emitSelf: true, // Enable to see our own messages
      allowPublishToZeroTopicPeers: true,
    }),
  };

  // Only add bootstrap service if network connections are enabled
  if (enableNetworkConnection && RELAY_BOOTSTRAP_ADDR?.length > 0) {
    logger.info("🔍 Enabling enhanced libp2p services...");
    logger.info(
      `   🔗 Bootstrap peers: ${RELAY_BOOTSTRAP_ADDR.length} configured`,
    );
    RELAY_BOOTSTRAP_ADDR.forEach((addr, i) => {
      logger.info(`     ${i + 1}. ${addr}`);
    });

    services.bootstrap = bootstrap({
      list: RELAY_BOOTSTRAP_ADDR,
    });

    logger.info("🔄 Bootstrap service configured with addresses:");
    RELAY_BOOTSTRAP_ADDR.forEach((addr, i) => {
      logger.info(`     Bootstrap ${i + 1}: ${addr}`);
      if (addr.includes("127.0.0.1")) {
        logger.info("     🏠 ↳ This is your LOCAL RELAY!");
      } else {
        logger.info("     🌐 ↳ This is a production relay");
      }
    });

    services.autonat = autoNAT();
    services.dcutr = dcutr();

    logger.info("✅ Services configured:");
    logger.info("   🔄 bootstrap: with timeout and tagging");
    logger.info("   🔍 autonat: NAT detection");
    logger.info("   🔗 dcutr: Direct connection upgrades");
  }

  // Configure circuit relay transport based on environment
  const circuitRelayConfig = enableReservations
    ? {
        discoverRelays: isUsingLocalRelay() ? 1 : 2,
        maxReservations: isUsingLocalRelay() ? 1 : 2,
        reservationManager: {
          maxReservations: isUsingLocalRelay() ? 1 : 2,
          reservationTtl: 30 * 60 * 1000, // 30 minutes
          reservationConcurrency: 1, // One at a time for better success
        },
      }
    : {
        discoverRelays: 0,
        maxReservations: 0,
      };

  logger.info("🔄 Circuit relay configuration:");
  logger.info(`   🔍 Discover relays: ${circuitRelayConfig.discoverRelays}`);
  logger.info(`   📋 Max reservations: ${circuitRelayConfig.maxReservations}`);

  return {
    ...(privateKey && { privateKey }),
    addresses: {
      listen: enableNetworkConnection
        ? [
            "/p2p-circuit", // Essential for relay connections
            "/webrtc", // WebRTC for direct connections
          ]
        : ["/webrtc"], // Only local WebRTC when network connection is disabled
    },
    transports: enableNetworkConnection
      ? [
          webSockets({
            filter: all,
          }),
          webRTC({
            rtcConfiguration: {
              iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:global.stun.twilio.com:3478" },
              ],
            },
          }),
          circuitRelayTransport(circuitRelayConfig),
        ]
      : [webRTC(), circuitRelayTransport({ discoverRelays: 1 })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: peerDiscoveryServices,
    services,
    connectionManager: {
      maxConnections: 20,
      minConnections: 1,
    },
    connectionGater: {
      denyDialMultiaddr: () => false,
      denyDialPeer: () => false,
      denyInboundConnection: () => false,
      denyOutboundConnection: () => false,
      denyInboundEncryptedConnection: () => false,
      denyOutboundEncryptedConnection: () => false,
      denyInboundUpgradedConnection: () => false,
      denyOutboundUpgradedConnection: () => false,
    },
  };
}

/**
 * Create a libp2p node with the specified configuration
 * @param {Object} options - Configuration options (same as createLibp2pConfig)
 * @returns {Promise<Object>} Created libp2p node
 */
export async function createLibp2pNode(options = {}) {
  logger.info("🚀 Creating libp2p node...");
  const config = await createLibp2pConfig(options);
  const libp2p = await createLibp2p(config);

  // Add comprehensive event listeners for debugging connections
  libp2p.addEventListener("peer:connect", (event) => {
    const peerId = event.detail.toString();
    const connection = libp2p
      .getConnections()
      .find((conn) => conn.remotePeer.toString() === peerId);

    logger.info(`✅ 🔗 Connected to peer: ${peerId.slice(-8)}`);
    if (connection) {
      logger.info(
        `     🔌 Transport: ${connection.transports?.[0] || "unknown"}`,
      );
      logger.info(`     🔄 Direction: ${connection.direction}`);
      logger.info(
        `     📏 Remote Address: ${connection.remoteAddr.toString()}`,
      );
    }

    // Check if this is our relay
    if (RELAY_PEER_ID && peerId.includes(RELAY_PEER_ID)) {
      logger.info(`     🏠 ⭐ THIS IS YOUR LOCAL RELAY!`);
      logger.info(`     🆔 Relay PeerID: ${RELAY_PEER_ID}`);

      // Check if this was a WebSocket connection
      if (connection?.remoteAddr.toString().includes("/ws")) {
        logger.info(`     🔌 ✅ WebSocket connection established!`);
      }
    } else {
      logger.info(
        `     🌐 Other peer: ${peerId.slice(0, 12)}...${peerId.slice(-12)}`,
      );
    }
  });

  // Add transport-specific debugging
  libp2p.addEventListener("transport:listening", (event) => {
    logger.info(`👂 Transport listening:`, event);
  });

  libp2p.addEventListener("peer:disconnect", (event) => {
    const peerId = event.detail.toString();
    logger.info(`💔 Disconnected from: ${peerId.slice(-8)}`);
    if (RELAY_PEER_ID && peerId.includes(RELAY_PEER_ID)) {
      logger.info(`     ⚠️ Lost connection to LOCAL RELAY`);
    }
  });

  // Add bootstrap-specific event listeners with auto-dial functionality
  libp2p.addEventListener("peer:discovery", (event) => {
    const peerIdObj = event.detail.id; // This is the PeerId object
    const peerIdStr = peerIdObj.toString();
    logger.info(`🔍 Discovered peer: ${peerIdStr.slice(-8)}`);

    // Check if this discovered peer is our local relay
    if (RELAY_PEER_ID && peerIdStr.includes(RELAY_PEER_ID)) {
      logger.info("✅ 🏠 Discovered LOCAL RELAY via bootstrap!");
    }

    // Auto-dial discovered peers (except relay)
    if (!RELAY_PEER_ID || !peerIdStr.includes(RELAY_PEER_ID)) {
      logger.info(`📞 Auto-dialing discovered peer: ${peerIdStr.slice(-8)}`);

      // Use setTimeout to avoid blocking the discovery event
      setTimeout(async () => {
        try {
          // Check if we're already connected to this peer
          const existingConnections = libp2p.getConnections();
          const alreadyConnected = existingConnections.some(
            (conn) => conn.remotePeer.toString() === peerIdStr,
          );

          if (alreadyConnected) {
            logger.info(
              `⏭️  Skipping dial - already connected to ${peerIdStr.slice(-8)}`,
            );
            return;
          }

          logger.info(`🔄 Attempting to dial peer: ${peerIdStr.slice(-8)}`);
          // Dial using the PeerId object (not multiaddresses)
          const connection = await libp2p.dial(peerIdObj, {
            signal: AbortSignal.timeout(15000),
          });
          logger.info(`✅ Successfully dialed peer: ${peerIdStr.slice(-8)}`);
          logger.info(`   Connection direction: ${connection.direction}`);
          logger.info(`   Remote address: ${connection.remoteAddr.toString()}`);
        } catch (error) {
          logger.info(
            `❌ Failed to dial peer ${peerIdStr.slice(-8)}: ${error.message}`,
          );
          // Don't log this as an error since it's expected that some dials may fail
        }
      }, 1000); // Wait 1 second before dialing to let discovery complete
    }
  });

  libp2p.addEventListener("peer:disconnect", (event) => {
    const peerId = event.detail.toString();
    logger.info(`💔 Disconnected from peer: ${peerId.slice(-8)}`);
  });

  // Log when we get circuit relay addresses
  libp2p.addEventListener("self:peer:update", () => {
    // const multiaddrs = libp2p.getMultiaddrs();
    // const circuitAddrs = multiaddrs.filter(addr =>
    //   addr.toString().includes('/p2p-circuit')
    // );
    // if (circuitAddrs.length > 0) {
    //   logger.info('🎯 Circuit relay addresses obtained:');
    //   circuitAddrs.forEach((addr, i) => {
    //     logger.info(`   ${i + 1}. ${addr.toString()}`);
    //   });
    // }
  });

  logger.info(`✅ LibP2P node created with ID: ${libp2p.peerId.toString()}`);

  if (isUsingLocalRelay()) {
    logger.info(
      "🏠 Using local relay - bootstrap will automatically discover and connect",
    );
    logger.info(
      "🔍 Watch for peer:discovery and peer:connect events to see bootstrap in action",
    );
  }

  return libp2p;
}

/**
 * Create a Helia IPFS node with libp2p
 * @param {Object} libp2p - LibP2P node instance
 * @param {Object} [blockstore] - Custom blockstore (optional)
 * @param {Object} [datastore] - Custom datastore (optional)
 * @returns {Promise<Object>} Created Helia IPFS node
 */
export async function createHeliaNode(libp2p, blockstore, datastore) {
  logger.info("📦 Creating Helia IPFS node...");
  const heliaConfig = { libp2p };

  if (blockstore) heliaConfig.blockstore = blockstore;
  if (datastore) heliaConfig.datastore = datastore;

  const helia = await createHelia(heliaConfig);
  logger.info("✅ Helia IPFS node created");

  return helia;
}

initializeRelayConfig();
