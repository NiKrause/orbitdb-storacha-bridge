<script>
  import {
    Database,
    CheckCircle,
    AlertCircle,
    Loader2,
    Users,
  } from "lucide-svelte";
  import { createHelia } from "helia";
  import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
  import { webSockets } from "@libp2p/websockets";
  import { webRTC } from "@libp2p/webrtc";
  import { noise } from "@chainsafe/libp2p-noise";
  import { yamux } from "@chainsafe/libp2p-yamux";
  import { identify } from "@libp2p/identify";
  import { gossipsub } from "@libp2p/gossipsub";
  import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
  import { bootstrap } from "@libp2p/bootstrap";
  import { multiaddr } from "@multiformats/multiaddr";
  import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
  import { backupDatabase } from "orbitdb-storage-bridge";
  import { restoreFromCID } from "orbitdb-storage-bridge/restore-cid";
  import { Identities, useIdentityProvider } from "@orbitdb/core";
  import OrbitDBIdentityProviderDID from "@orbitdb/identity-provider-did";
  import { Ed25519Provider } from "key-did-provider-ed25519";
  import * as KeyDIDResolver from "key-did-resolver";
  import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
  import { wordlist as english } from "@scure/bip39/wordlists/english";
  import { createHash } from "crypto";

  // Where backups go, and the Carbon components
  import StorageBackendPicker from "./StorageBackendPicker.svelte";
  import {
    Grid,
    Row,
    Column,
    Button,
    Tile,
    Toggle,
    InlineNotification,
    Loading,
    CodeSnippet,
  } from "carbon-components-svelte";
  import {
    DataBase,
    UserAvatar,
    CloudUpload,
    CloudDownload,
    Add,
    View,
    ViewOff,
    Reset,
    Warning,
    Connect,
  } from "carbon-icons-svelte";
  import { logger } from "./logger.js";
  import { relayMultiaddrs, relaySource } from "./relay-bootstrap.js";

  // Where backups go, chosen in StorageBackendPicker
  let storageBackend = null;
  let storageLabel = "";

  // Alice's state (creates data and backs up)
  let aliceRunning = false;
  let aliceOrbitDB = null;
  let aliceDatabase = null;
  let aliceHelia = null;
  let aliceLibp2p = null;
  let aliceTodos = [];
  let aliceResults = [];
  let aliceStep = "";
  let aliceError = null;
  let alicePeerId = null;
  let aliceConnectedPeers = [];

  // Bob's state (restores data and replicates)
  let bobRunning = false;
  let bobOrbitDB = null;
  let bobDatabase = null;
  let bobHelia = null;
  let bobLibp2p = null;
  let bobTodos = [];
  let bobResults = [];
  let bobStep = "";
  let bobError = null;
  let bobPeerId = null;
  let bobConnectedPeers = [];

  // Shared state
  let aliceIdentity = null;
  let aliceIdentities = null;
  let bobIdentity = null;
  let bobIdentities = null;
  let sharedDatabaseAddress = null;
  let backupResult = null;
  let restoreResult = null;
  let showDetails = false;
  let replicationEnabled = true;
  let bothIdentitiesGenerated = false;
  
  // Peer connection state for direct dialing
  let aliceMultiaddrs = [];
  let bobMultiaddrs = [];
  let aliceAddressReady = false;
  let bobAddressReady = false;

  // Connection state
  let peersConnected = false;
  let replicationEvents = [];
  // Set when no relay hands out an address, which is otherwise a silent wait.
  let relayWarning = "";


  // Test data
  let originalTodos = [
    {
      id: "replication_todo_1",
      text: "Test P2P replication with Alice & Bob",
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy: "alice",
    },
    {
      id: "replication_todo_2",
      text: "Back the database up to decentralized storage",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      createdBy: "alice",
    },
    {
      id: "replication_todo_3",
      text: "Restore and maintain replication",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      createdBy: "alice",
    },
  ];

  // Keep track of database addresses for replication demo
  let replicationTestDatabaseAddresses = new Set();

  const PUBSUB_TOPICS = ['todo._peer-discovery._p2p._pubsub'];

  // The relays Alice and Bob meet through: a browser cannot listen, so each
  // reserves a slot on a relay and is reachable at /p2p-circuit until they
  // upgrade to a direct WebRTC connection. The addresses come from the relay
  // registry on Aleph (see relay-bootstrap.js), or from VITE_RELAY_ADDRS.
  let relayAddrs = [];

  /**
   * The libp2p options Helia builds its node from. Every key Helia would fill
   * in itself is spelled out, peerDiscovery included, because its defaults dial
   * the public network.
   */
  async function createLibp2pConfig(options = {}) {
    const {
      privateKey = null,
      enablePeerConnections = true,
      enableNetworkConnection = true
    } = options;

    // How two browsers find each other: each announces itself on a pubsub
    // topic the other listens to, over the relay they both hold a slot on.
    const peerDiscoveryServices = [];
    if (enablePeerConnections && enableNetworkConnection) {
      peerDiscoveryServices.push(
        pubsubPeerDiscovery({
          interval: 3000,
          topics: PUBSUB_TOPICS,
          listenOnly: false,
          emitSelf: false
        })
      );
      logger.info(`🔍 Peer discovery on ${PUBSUB_TOPICS.join(', ')}, every 3s`);
    }

    // Peer discovery, not a service: bootstrap dials the relays and keeps the
    // connections tagged, so the connection manager does not prune them. The
    // list is empty when no relay is registered — bootstrap refuses an empty
    // one, and there would be nothing to dial anyway.
    if (enableNetworkConnection) {
      relayAddrs = await relayMultiaddrs();
      if (relayAddrs.length > 0) {
        peerDiscoveryServices.push(
          bootstrap({
            list: relayAddrs,
            timeout: 30000,
            tagName: 'bootstrap',
            tagValue: 50
          })
        );
        logger.info(`🔗 Relays from ${relaySource}: ${relayAddrs.join(', ')}`);
      } else {
        logger.warn(`⚠️ No relay found in ${relaySource}`);
      }
    }

    const services = {
      // A relay announces one libp2p protocol per database it holds open
      // (`/orbitdb/heads/<address>`, from OrbitDB's own sync), and libp2p
      // rejects an identify response over 8192 bytes *whole* — so past a few
      // hundred databases the client learns nothing about the relay, including
      // that it is one. No HOP, no reservation, no address to be dialled at,
      // and the page waits with no reason to show. Measured against the
      // registered relay on 2026-09-18: 611 protocols, identify silently
      // dropped at the default limit, fine at 64 KiB.
      identify: identify({ maxMessageSize: 65_536 }),
      pubsub: gossipsub({
        emitSelf: true,
        allowPublishToZeroTopicPeers: true
      })
    };

    return {
      ...(privateKey && { privateKey: privateKey }),
      addresses: {
        listen: enableNetworkConnection
          ? [
              '/p2p-circuit', // reachable through the relay
              '/webrtc' // and directly, once the relay has introduced them
            ]
          : ['/webrtc']
      },
      transports: enableNetworkConnection
        ? [
            webSockets(),
            webRTC({
              rtcConfiguration: {
                iceServers: [
                  { urls: 'stun:stun.l.google.com:19302' },
                  { urls: 'stun:global.stun.twilio.com:3478' }
                ]
              }
            }),
            circuitRelayTransport()
          ]
        : [webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      connectionGater: {
        denyDialMultiaddr: () => false,
        denyDialPeer: () => false,
        denyInboundConnection: () => false,
        denyOutboundConnection: () => false,
        denyInboundEncryptedConnection: () => false,
        denyOutboundEncryptedConnection: () => false,
        denyInboundUpgradedConnection: () => false,
        denyOutboundUpgradedConnection: () => false
      },
      streamMuxers: [yamux()],
      peerDiscovery: peerDiscoveryServices,
      services,
      connectionManager: {
        maxConnections: 20,
        minConnections: 1
      }
    };
  }

  /**
   * The backup reports its steps through an event emitter; this turns them into
   * Alice's status line.
   */
  function createBackupEvents() {
    return {
      emit(event, progress) {
        if (event !== "backupProgress" || !progress) return;
        logger.info("📤 Backup progress:", progress);
        if (progress.status === "creating") {
          aliceStep = `Packing ${progress.totalBlocks} blocks into a CAR`;
        } else if (progress.status === "uploading-blocks") {
          aliceStep = `Uploading the CAR (${progress.size} bytes) to ${storageLabel}`;
        } else if (progress.status === "uploading-metadata") {
          aliceStep = `Uploading the backup's metadata to ${storageLabel}`;
        } else if (progress.status === "completed") {
          aliceStep = `Backup uploaded to ${storageLabel}`;
        } else if (progress.status === "error") {
          aliceStep = `Backup failed: ${progress.error}`;
        }
      },
    };
  }

  function handleStorageConfigured(event) {
    storageBackend = event.detail.backend;
    storageLabel = event.detail.label;
    logger.info(`🗄️ Backups go to ${storageLabel}`);
  }

  function handleStorageCleared() {
    storageBackend = null;
    storageLabel = "";
  }

  /**
   * Convert 64-bit seed to 32-bit seed (same as deContact)
   */
  function convertTo32BitSeed(origSeed) {
    const hash = createHash("sha256");
    hash.update(Buffer.from(origSeed, "hex"));
    return hash.digest();
  }

  // Convert Uint8Array to hex (browser-safe)
  function toHex(u8) {
    return Array.from(u8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Generate master seed from mnemonic
   */
  function generateMasterSeed(mnemonicSeedphrase, password = "password") {
    return toHex(mnemonicToSeedSync(mnemonicSeedphrase, password));
  }

  /**
   * Create a reusable OrbitDB identity from seed
   */
  async function createReusableIdentity(persona = "shared") {
    logger.info(`🆔 Creating ${persona} identity...`);

    // Generate a test seed phrase for consistent identity
    const seedPhrase = generateMnemonic(english);
    const masterSeed = generateMasterSeed(seedPhrase, `${persona}-password`);
    const seed32 = convertTo32BitSeed(masterSeed);

    // Set up DID resolver and register the official DID provider
    const keyDidResolver = KeyDIDResolver.getResolver();
    OrbitDBIdentityProviderDID.setDIDResolver(keyDidResolver);
    useIdentityProvider(OrbitDBIdentityProviderDID);

    // Create OrbitDB identities instance
    const identities = await Identities();

    // Create DID provider from seed
    const didProvider = new Ed25519Provider(seed32);

    // Use the official OrbitDB DID identity provider
    const identity = await identities.createIdentity({
      provider: OrbitDBIdentityProviderDID({
        didProvider: didProvider,
      }),
    });

    logger.info(`✅ ${persona} identity created: ${identity.id}`);
    return { identity, identities, seedPhrase, masterSeed };
  }

  /**
   * Generate both Alice and Bob identities upfront for proper access control
   * UPDATED: Creates a shared identities system that knows about both identities
   */
  async function generateBothIdentities() {
    logger.info(`🆔 Generating peer identities for replication demo...`);

    try {
      // Set up DID resolver and register the official DID provider
      const keyDidResolver = KeyDIDResolver.getResolver();
      OrbitDBIdentityProviderDID.setDIDResolver(keyDidResolver);
      useIdentityProvider(OrbitDBIdentityProviderDID);
      
      // Create shared identities system for proper cross-peer resolution
      const sharedIdentitiesSystem = await Identities();
      
      // Generate Alice's identity
      const aliceSeedPhrase = generateMnemonic(english);
      const aliceMasterSeed = generateMasterSeed(aliceSeedPhrase, 'alice-password');
      const aliceSeed32 = convertTo32BitSeed(aliceMasterSeed);
      const aliceDidProvider = new Ed25519Provider(aliceSeed32);
      
      aliceIdentity = await sharedIdentitiesSystem.createIdentity({
        provider: OrbitDBIdentityProviderDID({
          didProvider: aliceDidProvider,
        }),
      });
      
      // Generate Bob's identity using the same system
      const bobSeedPhrase = generateMnemonic(english);
      const bobMasterSeed = generateMasterSeed(bobSeedPhrase, 'bob-password');
      const bobSeed32 = convertTo32BitSeed(bobMasterSeed);
      const bobDidProvider = new Ed25519Provider(bobSeed32);
      
      bobIdentity = await sharedIdentitiesSystem.createIdentity({
        provider: OrbitDBIdentityProviderDID({
          didProvider: bobDidProvider,
        }),
      });
      
      // Both peers use the shared identities system
      aliceIdentities = sharedIdentitiesSystem;
      bobIdentities = sharedIdentitiesSystem;
      bothIdentitiesGenerated = true;

      logger.info(`✅ Peer identities created:`);
      logger.info(`   Alice: ...${aliceIdentity.id.slice(-12)}`);
      logger.info(`   Bob: ...${bobIdentity.id.slice(-12)}`);

      return {
        aliceIdentity,
        aliceIdentities,
        bobIdentity,
        bobIdentities,
        sharedIdentitiesSystem
      };
    } catch (error) {
      logger.error(`❌ Failed to generate identities:`, error);
      throw error;
    }
  }

  function addResult(persona, step, status, message, data = null) {
    const result = {
      step,
      status, // 'running', 'success', 'error'
      message,
      data,
      timestamp: new Date().toISOString(),
    };

    if (persona === "alice") {
      aliceResults = [...aliceResults, result];
    } else {
      bobResults = [...bobResults, result];
    }
    logger.info(`🧪 ${persona}: ${step} - ${status} - ${message}`, data || "");
  }

  function updateLastResult(persona, status, message, data = null) {
    const results = persona === "alice" ? aliceResults : bobResults;
    if (results.length > 0) {
      const lastResult = results[results.length - 1];
      lastResult.status = status;
      lastResult.message = message;
      if (data) lastResult.data = data;

      if (persona === "alice") {
        aliceResults = [...aliceResults];
      } else {
        bobResults = [...bobResults];
      }
    }
  }

  function addReplicationEvent(event) {
    const replicationEvent = {
      timestamp: new Date().toISOString(),
      type: event.type,
      peer: event.peer,
      data: event.data,
    };
    replicationEvents = [...replicationEvents, replicationEvent].slice(-20); // Keep last 20 events
    logger.info("🔄 Replication Event:", replicationEvent);
  }

  // Function to check replication status
  async function checkReplicationStatus() {
    logger.info("🔍 Checking replication status...");
    
    if (aliceDatabase && bobDatabase) {
      logger.info("📊 Database status check:");
      
      try {
        // OrbitDB doesn't have a sync() method - replication happens automatically via events
        // Instead, we just check the current state of both databases
        logger.info("🔄 Checking current database states...");
        
        // Get current data counts
        const aliceData = await aliceDatabase.all();
        const bobData = await bobDatabase.all();
        
        logger.info(`📊 Alice has ${aliceData.length} todos:`, aliceData.map(t => t.key));
        logger.info(`📊 Bob has ${bobData.length} todos:`, bobData.map(t => t.key));
        
        // Update UI
        aliceTodos = aliceData;
        bobTodos = bobData;
        
        // Check if data matches
        if (aliceData.length === bobData.length) {
          logger.info("✅ Data counts match - replication appears to be working!");
        } else {
          logger.warn(`⚠️  Data mismatch - Alice: ${aliceData.length}, Bob: ${bobData.length}`);
        }
        
        // Check for peer connections to verify replication potential
        logger.info(`🔗 Alice connected to ${aliceConnectedPeers.length} peers:`, aliceConnectedPeers.map(p => p.slice(-8)));
        logger.info(`🔗 Bob connected to ${bobConnectedPeers.length} peers:`, bobConnectedPeers.map(p => p.slice(-8)));
        
        return { alice: aliceData.length, bob: bobData.length };
      } catch (error) {
        logger.error("❌ Error checking replication status:", error);
        return null;
      }
    } else {
      logger.warn("⚠️  Cannot check replication - one or both databases not initialized");
      return null;
    }
  }

  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    openDatabase = true, // New parameter to control database opening
  ) {
    logger.info(`🔧 Creating OrbitDB instance for ${persona}... (openDatabase: ${openDatabase})`);

    // Create libp2p configuration with replication enabled
    const libp2pConfig = await createLibp2pConfig({
      enablePeerConnections: replicationEnabled,
      enableNetworkConnection: replicationEnabled,
    });

    // Helia 7 builds libp2p itself, from options — it no longer takes a
    // finished node — and hands back a node that has to be started before
    // helia.libp2p is there to listen to.
    logger.info(`🗄️ Initializing ${persona}'s Helia...`);
    const helia = await createHelia({
      libp2p: libp2pConfig,
      // No delegated router and no gateways: a missing block is asked of the
      // peer we replicate with, over the connection this demo is about. Helia
      // would otherwise send every CID it cannot find to public infrastructure,
      // and wait on it.
      http: { delegatedRouters: [], recursiveGateways: [] },
    }).start();
    const libp2p = helia.libp2p;
    logger.info(`${persona} Helia and libp2p started; peer discovery:`, replicationEnabled);
    logger.info(`🆔 ${persona} Peer ID:`, libp2p.peerId.toString());
    
    // Store multiaddrs for potential direct dialing
    const multiaddrs = libp2p.getMultiaddrs().map(addr => addr.toString());
    logger.info(`🎧 ${persona} Listening on:`, multiaddrs);
    
    if (persona === "alice") {
      aliceMultiaddrs = multiaddrs;
      alicePeerId = libp2p.peerId.toString();
    } else {
      bobMultiaddrs = multiaddrs;
      bobPeerId = libp2p.peerId.toString();
    }

    // A browser cannot listen, so its address comes from the relay. If no relay
    // answers, say which ones were tried instead of leaving the next step
    // disabled with nothing to go on.
    const relayDeadline = setTimeout(() => {
      const ready = persona === "alice" ? aliceAddressReady : bobAddressReady;
      if (!ready) {
        relayWarning = relayAddrs.length
          ? `No relay answered within 20 seconds, so ${persona} has no address other peers could dial. Tried, from ${relaySource}: ${relayAddrs.join(", ")}. Set VITE_RELAY_ADDRS to a relay you can reach.`
          : `${relaySource} lists no relay, so ${persona} has no address other peers could dial. Deploy one with relay-button, or set VITE_RELAY_ADDRS to a relay you can reach.`;
        logger.warn(`⚠️ ${relayWarning}`);
      }
    }, 20000);

    // Monitor peer connectivity for replication demo
    const updateAddressReadiness = () => {
      const currentMultiaddrs = libp2p.getMultiaddrs().map(addr => addr.toString());
      const hasDialableAddresses = currentMultiaddrs.some(addr =>
        addr.includes('/p2p-circuit/') ||
        addr.includes('/webrtc') ||
        addr.includes('/ws/') ||
        addr.includes('/wss/') ||
        addr.includes('/tcp/') ||
        (addr.includes('/dns4/') || addr.includes('/dns6/'))
      );

      if (hasDialableAddresses) {
        clearTimeout(relayDeadline);
        relayWarning = "";
      }

      if (persona === "alice") {
        const wasReady = aliceAddressReady;
        aliceMultiaddrs = currentMultiaddrs;
        aliceAddressReady = hasDialableAddresses;
        
        if (hasDialableAddresses && !wasReady) {
          logger.info(`✅ Alice ready for connections (${currentMultiaddrs.length} addresses)`);
          addReplicationEvent({
            type: 'addresses_ready',
            peer: 'alice',
            data: { addressCount: currentMultiaddrs.length, dialable: true }
          });
        }
      } else {
        const wasReady = bobAddressReady;
        bobMultiaddrs = currentMultiaddrs;
        bobAddressReady = hasDialableAddresses;
        
        if (hasDialableAddresses && !wasReady) {
          logger.info(`✅ Bob ready for connections (${currentMultiaddrs.length} addresses)`);
          addReplicationEvent({
            type: 'addresses_ready', 
            peer: 'bob',
            data: { addressCount: currentMultiaddrs.length, dialable: true }
          });
        }
      }
    };
    
    // Initial address check (no polling - just once)
    updateAddressReadiness();
    
    // Try to listen for any address updates
    try {
      libp2p.addEventListener('self:peer:update', (event) => {
        logger.info(`🔄 [${persona.toUpperCase()}] PEER UPDATE EVENT:`, event.detail);
        const updatedMultiaddrs = libp2p.getMultiaddrs().map(addr => addr.toString());
        logger.info(`🔄 [${persona.toUpperCase()}] Updated multiaddrs:`, updatedMultiaddrs);
        
        if (persona === "alice") {
          aliceMultiaddrs = updatedMultiaddrs;
        } else {
          bobMultiaddrs = updatedMultiaddrs;
        }
        
        // Update address readiness immediately after peer update
        updateAddressReadiness();
      });
    } catch (error) {
      logger.info(`💫 Peer update events not available for ${persona}`);
    }
    
    // Peer Discovery Events
    libp2p.addEventListener('peer:discovery', (event) => {
      const peerId = event.detail.id.toString();
      logger.info(`🔍 ${persona.toUpperCase()} discovered peer: ...${peerId.slice(-8)}`);
      
      addReplicationEvent({
        type: 'peer_discovered',
        peer: persona,
        data: { discovered: peerId.slice(-12) }
      });
    });
    
    // Connection Events
    libp2p.addEventListener('peer:connect', (event) => {
      const peerId = event.detail.toString();
      logger.info(`🔗 ${persona.toUpperCase()} connected to peer: ...${peerId.slice(-8)}`);
      
      if (persona === "alice") {
        aliceConnectedPeers = [...aliceConnectedPeers, peerId];
        alicePeerId = libp2p.peerId.toString();
      } else {
        bobConnectedPeers = [...bobConnectedPeers, peerId];
        bobPeerId = libp2p.peerId.toString();
      }
      
      updatePeerConnectionStatus();
      setTimeout(() => updateAddressReadiness(), 100);
      
      addReplicationEvent({
        type: 'peer_connected',
        peer: persona,
        data: { connectedTo: peerId.slice(-12) }
      });
    });

    // Disconnection Events
    libp2p.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      logger.info(`🔌 ${persona.toUpperCase()} disconnected from: ...${peerId.slice(-8)}`);
      
      if (persona === "alice") {
        aliceConnectedPeers = aliceConnectedPeers.filter(p => p !== peerId);
      } else {
        bobConnectedPeers = bobConnectedPeers.filter(p => p !== peerId);
      }
      
      updatePeerConnectionStatus();
      
      addReplicationEvent({
        type: 'peer_disconnected',
        peer: persona,
        data: { disconnectedFrom: peerId.slice(-12) }
      });
    });
    
    // Monitor connection status (minimal logging)
    setInterval(() => {
      const connections = libp2p.getConnections();
      const currentMultiaddrs = libp2p.getMultiaddrs().map(addr => addr.toString());
      
      // Update stored multiaddrs if they changed
      if (persona === "alice" && JSON.stringify(aliceMultiaddrs) !== JSON.stringify(currentMultiaddrs)) {
        aliceMultiaddrs = currentMultiaddrs;
      } else if (persona === "bob" && JSON.stringify(bobMultiaddrs) !== JSON.stringify(currentMultiaddrs)) {
        bobMultiaddrs = currentMultiaddrs;
      }
      
      // Only log if there are active connections
      if (connections.length > 0) {
        logger.info(`📊 ${persona.toUpperCase()}: ${connections.length} active connections`);
      }
    }, 15000); // Every 15 seconds

    // Create OrbitDB instance with unique ID and persona-specific identity
    const personaIdentity = persona === "alice" ? aliceIdentity : bobIdentity;
    const personaIdentities = persona === "alice" ? aliceIdentities : bobIdentities;
    
    logger.info(`🔍 ${persona} identity verification:`);
    logger.info(`   Identity ID: ${personaIdentity.id}`);
    logger.info(`   Alice ID: ${aliceIdentity.id}`);
    logger.info(`   Bob ID: ${bobIdentity.id}`);
    
    const orbitdbConfig = {
      ipfs: helia,
      id: `${persona}-${instanceId}-${Date.now()}-${Math.random()}`,
      directory: `./orbitdb-replication-${persona}-${instanceId}`,
      identity: personaIdentity,
      identities: personaIdentities,
    };

    const orbitdb = await createOrbitDB(orbitdbConfig);
    logger.info(`${persona} orbitdb:`, orbitdb);

    // Create database with proper access control for both personas (conditionally)
    let database = null;
    
    if (openDatabase) {
      if (persona === "alice") {
        // Alice creates the database with both Alice and Bob access
        logger.info(`🆕 Alice creating new database with both Alice & Bob access:`, databaseName);
        
        // Create shared database with access control for both peers
        logger.info('🔐 Setting up database with write access for both peers');
        const multiAccessConfig = {
          ...databaseConfig,
          // Capital A: what OrbitDB 4 reads. Spelled the old way, the option is
          // ignored and the database ends up writable by its creator alone.
          AccessController: IPFSAccessController({
            write: [aliceIdentity.id, bobIdentity.id]
          })
        };
        
        database = await orbitdb.open(databaseName, multiAccessConfig);
        sharedDatabaseAddress = database.address;
        logger.info(`📍 Alice created shared database with address:`, sharedDatabaseAddress);
        logger.info(`🔐 Access granted to both Alice (${aliceIdentity.id}) and Bob (${bobIdentity.id})`);
        logger.info(`📚 Following official OrbitDB documentation pattern`);
      } else {
        // Bob opens the existing database by Alice's address
        if (!sharedDatabaseAddress) {
          throw new Error("Cannot initialize Bob: Alice must create the shared database first!");
        }
        
        logger.info(`🔗 Bob opening existing database by Alice's address (minimal approach):`, sharedDatabaseAddress);
        logger.info(`💡 Bob will inherit all configuration from Alice's database`);
        
        // Bob opens by address only - minimal approach, inherits all Alice's configuration
        database = await orbitdb.open(sharedDatabaseAddress);
        
        // Verify that the address matches
        if (database.address !== sharedDatabaseAddress) {
          logger.warn(`⚠️  Address mismatch! Expected: ${sharedDatabaseAddress}, Got: ${database.address}`);
        } else {
          logger.info(`✅ Bob successfully opened shared database by address`);
          logger.info(`🔐 Bob using Alice's access control - write permissions for Alice (${aliceIdentity.id}) and Bob (${bobIdentity.id})`);
        }
      }
      
      logger.info(`${persona} database:`, database);
      
      // Verify database setup
      logger.info(`✅ ${persona.toUpperCase()} database ready:`);
      logger.info(`   Address: ...${database.address.split('/').pop().slice(-12)}`);
      logger.info(`   Type: ${database.type}`);
      logger.info(`   Identity: ...${database.identity.id.slice(-12)}`);
      
      if (database.access && database.access.write) {
        const writeList = database.access.write.map(id => `...${id.slice(-12)}`);
        logger.info(`   Write permissions: [${writeList.join(', ')}]`);
      }

      // Set up event listeners for this database
      setupDatabaseEventListeners(database, persona);
    } else {
      logger.info(`⏳ ${persona} OrbitDB instance created but database not opened yet (waiting for connection)`);
    }

    return { libp2p, helia, orbitdb, database };
  }

  function updatePeerConnectionStatus() {
    // Check if Alice and Bob can potentially see each other
    peersConnected = aliceConnectedPeers.length > 0 && bobConnectedPeers.length > 0;
    
    // Also check if they share any common peers or are directly connected
    if (alicePeerId && bobPeerId) {
      const directConnection = aliceConnectedPeers.includes(bobPeerId) || bobConnectedPeers.includes(alicePeerId);
      const commonPeers = aliceConnectedPeers.some(peer => bobConnectedPeers.includes(peer));
      peersConnected = peersConnected || directConnection || commonPeers;
    }
  }
  
  /**
   * Comprehensive database properties comparison and debugging
   * Compares Alice's and Bob's database properties side-by-side
   */
  function debugDatabasePropertiesComparison(aliceDb, bobDb) {
    logger.info(`🔍🔎 [DATABASE COMPARISON] Comprehensive Properties Debug:`);
    logger.info(`=================================================================`);
    
    // Basic Properties Comparison
    logger.info(`🏠 BASIC PROPERTIES:`);
    logger.info(`   Address:`);
    logger.info(`     Alice: ${aliceDb?.address || 'NULL'}`);
    logger.info(`     Bob:   ${bobDb?.address || 'NULL'}`);
    logger.info(`     Match: ${aliceDb?.address === bobDb?.address ? '✅' : '❌'}`);
    
    logger.info(`   Type:`);
    logger.info(`     Alice: ${aliceDb?.type || 'NULL'}`);
    logger.info(`     Bob:   ${bobDb?.type || 'NULL'}`);
    logger.info(`     Match: ${aliceDb?.type === bobDb?.type ? '✅' : '❌'}`);
    
    logger.info(`   Name:`);
    logger.info(`     Alice: ${aliceDb?.name || 'NULL'}`);
    logger.info(`     Bob:   ${bobDb?.name || 'NULL'}`);
    logger.info(`     Match: ${aliceDb?.name === bobDb?.name ? '✅' : '❌'}`);
    
    // Identity Comparison
    logger.info(`\n🆔 IDENTITY COMPARISON:`);
    logger.info(`   Database Identity:`);
    logger.info(`     Alice DB Identity: ${aliceDb?.identity?.id || 'NULL'}`);
    logger.info(`     Bob DB Identity:   ${bobDb?.identity?.id || 'NULL'}`);
    logger.info(`     Match: ${aliceDb?.identity?.id === bobDb?.identity?.id ? '✅' : '❌'}`);
    
    logger.info(`   Expected Identities:`);
    logger.info(`     Alice Identity: ${aliceIdentity?.id || 'NULL'}`);
    logger.info(`     Bob Identity:   ${bobIdentity?.id || 'NULL'}`);
    
    logger.info(`   Database Uses Correct Identity:`);
    logger.info(`     Alice DB uses Bob Identity: ${aliceDb?.identity?.id === bobIdentity?.id ? '✅' : '❌'}`);
    logger.info(`     Bob DB uses Bob Identity:   ${bobDb?.identity?.id === bobIdentity?.id ? '✅' : '❌'}`);
    
    // Access Controller Deep Dive
    logger.info(`\n🔐 ACCESS CONTROLLER COMPARISON:`);
    logger.info(`   Access Controller Exists:`);
    logger.info(`     Alice: ${aliceDb?.access ? '✅ YES' : '❌ NO'}`);
    logger.info(`     Bob:   ${bobDb?.access ? '✅ YES' : '❌ NO'}`);
    
    if (aliceDb?.access && bobDb?.access) {
      logger.info(`   Write Permissions:`);
      logger.info(`     Alice Write List:`, aliceDb.access.write || 'NULL');
      logger.info(`     Bob Write List:  `, bobDb.access.write || 'NULL');
      
      // Check if write lists match
      const aliceWrites = aliceDb.access.write || [];
      const bobWrites = bobDb.access.write || [];
      const writeListsMatch = JSON.stringify(aliceWrites.sort()) === JSON.stringify(bobWrites.sort());
      logger.info(`     Write Lists Match: ${writeListsMatch ? '✅' : '❌'}`);
      
      // Check specific identity permissions
      logger.info(`   Identity Permissions:`);
      logger.info(`     Alice can write to Alice DB: ${aliceWrites.includes(aliceIdentity?.id) ? '✅' : '❌'}`);
      logger.info(`     Alice can write to Bob DB:   ${bobWrites.includes(aliceIdentity?.id) ? '✅' : '❌'}`);
      logger.info(`     Bob can write to Alice DB:   ${aliceWrites.includes(bobIdentity?.id) ? '✅' : '❌'}`);
      logger.info(`     Bob can write to Bob DB:     ${bobWrites.includes(bobIdentity?.id) ? '✅' : '❌'}`);
      
      // Access controller type comparison
      logger.info(`   Controller Type:`);
      logger.info(`     Alice: ${aliceDb.access.type || 'NULL'}`);
      logger.info(`     Bob:   ${bobDb.access.type || 'NULL'}`);
      logger.info(`     Match: ${aliceDb.access.type === bobDb.access.type ? '✅' : '❌'}`);
      
      // Detailed access controller analysis
      logger.info(`   Access Controller Analysis:`);
      if (aliceDb.access.type === 'ipfs') {
        logger.info(`     ✅ Using IPFSAccessController (Static/Immutable) - CORRECT for your use case`);
        logger.info(`     📝 Static permissions set at creation - no runtime changes needed`);
      } else if (aliceDb.access.type === 'orbitdb') {
        logger.info(`     🔄 Using OrbitDBAccessController (Dynamic/Mutable)`);
        logger.info(`     🔧 Supports runtime grant/revoke operations`);
      } else {
        logger.info(`     🤔 Unknown access controller type: ${aliceDb.access.type}`);
      }
      
      // Verify multi-identity setup using HASH format (correct for OrbitDB)
      const aliceDbWrites = aliceDb.access.write || [];
      const expectedIdentityHashes = [aliceIdentity?.hash, bobIdentity?.hash].filter(Boolean);
      const expectedIdentityDIDs = [aliceIdentity?.id, bobIdentity?.id].filter(Boolean);
      const hasAllExpectedHashes = expectedIdentityHashes.every(hash => aliceDbWrites.includes(hash));
      const hasAllExpectedDIDs = expectedIdentityDIDs.every(did => aliceDbWrites.includes(did));
      
      logger.info(`   Multi-Identity Setup Verification:`);
      logger.info(`     Expected identity hashes: ${expectedIdentityHashes.length} [${expectedIdentityHashes.map(h => h?.slice(-12)).join(', ')}]`);
      logger.info(`     Expected identity DIDs: ${expectedIdentityDIDs.length}`);
      logger.info(`     Found in write list: ${aliceDbWrites.length} [${aliceDbWrites.map(w => w?.slice(-12)).join(', ')}]`);
      logger.info(`     All expected hashes present: ${hasAllExpectedHashes ? '✅' : '❌'}`);
      logger.info(`     All expected DIDs present: ${hasAllExpectedDIDs ? '✅' : '❌'} (should be false - DIDs not used)`);
      logger.info(`     Implementation status: ${hasAllExpectedHashes ? '✅ PERFECT - Using correct HASH format' : '❌ ISSUE - Using wrong format or missing identities'}`);
    } else {
      logger.info(`   ⚠️  Cannot compare access controllers - one or both missing`);
    }
    
    // OrbitDB Instance Properties
    logger.info(`\n🌌 ORBITDB INSTANCE COMPARISON:`);
    logger.info(`   OrbitDB Identity:`);
    logger.info(`     Alice OrbitDB: ${aliceOrbitDB?.identity?.id || 'NULL'}`);
    logger.info(`     Bob OrbitDB:   ${bobOrbitDB?.identity?.id || 'NULL'}`);
    logger.info(`     Both Use Bob:  ${(aliceOrbitDB?.identity?.id === bobIdentity?.id && bobOrbitDB?.identity?.id === bobIdentity?.id) ? '✅' : '❌'}`);
    
    logger.info(`   OrbitDB ID:`);
    logger.info(`     Alice: ${aliceOrbitDB?.id || 'NULL'}`);
    logger.info(`     Bob:   ${bobOrbitDB?.id || 'NULL'}`);
    
    // Log Properties (deeper inspection)
    logger.info(`\n📜 LOG PROPERTIES:`);
    logger.info(`   Log ID:`);
    logger.info(`     Alice: ${aliceDb?.log?.id || 'NULL'}`);
    logger.info(`     Bob:   ${bobDb?.log?.id || 'NULL'}`);
    logger.info(`     Match: ${aliceDb?.log?.id === bobDb?.log?.id ? '✅' : '❌'}`);
    
    logger.info(`   Log Length:`);
    logger.info(`     Alice: ${aliceDb?.log?.length || 0}`);
    logger.info(`     Bob:   ${bobDb?.log?.length || 0}`);
    
    // Events and Capabilities
    logger.info(`\n🎆 EVENTS & CAPABILITIES:`);
    logger.info(`   Event Emitter:`);
    logger.info(`     Alice: ${aliceDb?.events ? '✅ YES' : '❌ NO'}`);
    logger.info(`     Bob:   ${bobDb?.events ? '✅ YES' : '❌ NO'}`);
    
    logger.info(`   Sync Enabled:`);
    logger.info(`     Alice: ${aliceDb?.sync !== false ? '✅ YES' : '❌ NO'}`);
    logger.info(`     Bob:   ${bobDb?.sync !== false ? '✅ YES' : '❌ NO'}`);
    
    // Storage and Network
    logger.info(`\n💾 STORAGE & NETWORK:`);
    logger.info(`   IPFS/Helia Instance:`);
    logger.info(`     Alice: ${aliceHelia ? '✅ YES' : '❌ NO'}`);
    logger.info(`     Bob:   ${bobHelia ? '✅ YES' : '❌ NO'}`);
    
    logger.info(`   LibP2P Instance:`);
    logger.info(`     Alice: ${aliceLibp2p ? '✅ YES' : '❌ NO'}`);
    logger.info(`     Bob:   ${bobLibp2p ? '✅ YES' : '❌ NO'}`);
    
    logger.info(`=================================================================`);
    logger.info(`🆗 REPLICATION READINESS SUMMARY:`);
    
    const criticalChecks = {
      addressesMatch: aliceDb?.address === bobDb?.address,
      typesMatch: aliceDb?.type === bobDb?.type,
      bothHaveAccess: !!(aliceDb?.access && bobDb?.access),
      correctIdentities: aliceDb?.identity?.id === bobIdentity?.id && bobDb?.identity?.id === bobIdentity?.id,
      bothCanWrite: !!(aliceDb?.access?.write?.includes(bobIdentity?.id) && bobDb?.access?.write?.includes(bobIdentity?.id)),
      eventsEnabled: !!(aliceDb?.events && bobDb?.events)
    };
    
    Object.entries(criticalChecks).forEach(([check, passed]) => {
      logger.info(`   ${check}: ${passed ? '✅ PASS' : '❌ FAIL'}`);
    });
    
    const allPassed = Object.values(criticalChecks).every(check => check);
    logger.info(`\n🏆 OVERALL REPLICATION READINESS: ${allPassed ? '✅ EXCELLENT' : '⚠️  NEEDS ATTENTION'}`);
    
    return criticalChecks;
  }
  
  // Function for Bob to open Alice's shared database after connection is established
  async function openSharedDatabase(orbitdb, databaseAddress, persona = "bob") {
    logger.info(`🔗 ${persona} opening shared database by address:`, databaseAddress);
    logger.info(`💡 ${persona} will inherit all configuration from Alice's database`);
    
    try {
      // Bob opens by address only - minimal approach, inherits all Alice's configuration
      const database = await orbitdb.open(databaseAddress);
      
      // Verify that the address matches
      if (database.address !== databaseAddress) {
        logger.warn(`⚠️  Address mismatch! Expected: ${databaseAddress}, Got: ${database.address}`);
      } else {
        logger.info(`✅ ${persona} successfully opened shared database by address`);
        logger.info(`🔐 ${persona} using Alice's access control - write permissions for Alice (${aliceIdentity.id}) and Bob (${bobIdentity.id})`);
      }
      
      logger.info(`${persona} database:`, database);
      
      // COMPREHENSIVE DATABASE COMPARISON (if both databases exist)
      if (aliceDatabase && database && persona === 'bob') {
        logger.info(`\n🔍 [DATABASE DEBUG] Running comprehensive comparison...`);
        debugDatabasePropertiesComparison(aliceDatabase, database);
      }
      
      // REPLICATION VERIFICATION: Check all requirements
      logger.info(`\n🔍 [${persona.toUpperCase()}] REPLICATION VERIFICATION:`);
      logger.info(`   🕑 1. Database Address: ${database.address}`);
      logger.info(`   🕒 2. Shared Address: ${databaseAddress}`);
      logger.info(`   🕓 3. Addresses Match: ${database.address === databaseAddress}`);
      logger.info(`   🕔 4. Database Identity: ${database.identity.id}`);
      logger.info(`   🕕 5. Alice Identity: ${aliceIdentity.id}`);
      logger.info(`   🕖 6. Bob Identity: ${bobIdentity.id}`);
      logger.info(`   🕗 7. Database Type: ${database.type}`);
      logger.info(`   🕘 8. OrbitDB Used Identity: ${orbitdb.identity.id}`);
      logger.info(`   🕙 9. OrbitDB Used Identities: ${orbitdb.identities ? 'YES' : 'NO'}`);
      
      // Check access controller
      if (database.access && database.access.write) {
        logger.info(`   🔐 10. Access Controller Write List:`, database.access.write);
      } else {
        logger.info(`   ⚠️  10. Access Controller: NOT FOUND`);
      }

      // Set up event listeners for this database
      setupDatabaseEventListeners(database, persona);
      
      return database;
    } catch (error) {
      logger.error(`❌ Failed to open shared database for ${persona}:`, error);
      throw error;
    }
  }
  
  /**
   * Bob dials Alice. Both run in this page, so her addresses are at hand, and
   * the WebRTC ones come first: a relayed connection is limited, and OrbitDB
   * syncs over a direct one. The relay is the introduction, not the channel.
   */
  async function forceDirectConnection() {
    if (!aliceLibp2p || !bobLibp2p) {
      logger.warn("⚠️ Cannot connect: one of the two nodes is missing");
      return false;
    }

    const addresses = aliceLibp2p
      .getMultiaddrs()
      .map((addr) => addr.toString())
      .filter((addr) => addr.includes("/webrtc") || addr.includes("/p2p-circuit"))
      .sort((a, b) => Number(b.includes("/webrtc")) - Number(a.includes("/webrtc")));

    if (addresses.length === 0) {
      logger.warn("⚠️ Alice has no address Bob could dial yet");
      return false;
    }

    for (const address of addresses) {
      try {
        logger.info(`📞 Bob dialing Alice at ${address}`);
        const connection = await bobLibp2p.dial(multiaddr(address), {
          signal: AbortSignal.timeout(20000),
        });
        logger.info("✅ Bob connected to Alice", {
          remoteAddr: connection.remoteAddr.toString(),
          limited: connection.limits != null,
        });
        addReplicationEvent({
          type: "peers_connected",
          peer: "bob",
          data: { address, limited: connection.limits != null },
        });
        return true;
      } catch (error) {
        logger.info(`❌ ${address} did not work: ${error.message}`);
      }
    }

    // Both hold a reservation on the relay and keep announcing themselves on
    // the pubsub topic, so discovery may still introduce them.
    logger.warn("⚠️ Bob could not dial Alice; leaving it to peer discovery");
    return false;
  }


  // Set up event listeners for replication demo databases
  function setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    logger.info(`🎧 Setting up replication event listeners for ${persona}'s database...`);
    logger.info(`🎯 [ReplicationTest] Database address: ${database.address}`);

    // Add this database address to our tracking set
    replicationTestDatabaseAddresses.add(
      database.address?.toString() || database.address,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any replication test database
      const eventAddress = address?.toString() || address;

      if (replicationTestDatabaseAddresses.has(eventAddress)) {
        const replicationSource = entry?.identity !== database.identity.id ? 'REPLICATED' : 'LOCAL';
        
        logger.info(`🔥 🔗 [${persona.toUpperCase()}] JOIN EVENT (${replicationSource}):`);
        logger.info(`   Entry Key: ${entry?.key}`);
        logger.info(`   Entry Value:`, entry?.value);
        logger.info(`   Entry Identity: ${entry?.identity}`);
        logger.info(`   Local Identity: ${database.identity.id}`);
        logger.info(`   Address: ${eventAddress}`);
        logger.info(`   Timestamp: ${new Date().toISOString()}`);
        
        if (replicationSource === 'REPLICATED') {
          logger.info(`✨ 🎆 REPLICATION DETECTED! ${persona} received data from remote peer!`);
        }
        
        logger.info(`📊 Full event data:`, {
          address: eventAddress,
          entry: {
            hash: entry?.hash?.toString() || entry?.hash,
            payload: entry?.payload,
            key: entry?.key,
            value: entry?.value,
            identity: entry?.identity,
          },
          heads: heads?.map((h) => h?.toString()) || heads,
          replicationSource,
        });

        // Add to test results if test is running
        addResult(
          persona,
          "Replication Event",
          "success",
          `Entry ${replicationSource.toLowerCase()}: ${entry?.key || "unknown key"}`,
          {
            address: eventAddress,
            entryHash: entry?.hash?.toString() || entry?.hash,
            entryKey: entry?.key,
            entryValue: entry?.value,
            replicationSource: replicationSource.toLowerCase(),
            entryIdentity: entry?.identity,
            localIdentity: database.identity.id,
          },
        );

        // Update the todo list for this persona
        try {
          if (persona === "alice") {
            aliceTodos = await aliceDatabase.all();
          } else if (persona === "bob" && bobDatabase) {
            bobTodos = await bobDatabase.all();
          }
        } catch (error) {
          logger.warn(`Failed to update ${persona}'s todos:`, error);
        }

        // Add replication event
        addReplicationEvent({
          type: 'data_replicated',
          peer: persona,
          data: {
            key: entry?.key,
            replicationSource: replicationSource.toLowerCase(),
            from: entry?.identity?.slice(-8) || 'unknown'
          }
        });
      }
    });

    // Listen for entries being updated (update event)
    database.events.on("update", async (address, entry, heads) => {
      // Check if this event is for any replication test database
      const eventAddress = address?.toString() || address;

      if (replicationTestDatabaseAddresses.has(eventAddress)) {
        const replicationSource = entry?.identity !== database.identity.id ? 'REPLICATED' : 'LOCAL';
        
        logger.info(`🔥 🔄 [${persona.toUpperCase()}] UPDATE EVENT (${replicationSource}):`);
        logger.info(`   Entry Key: ${entry?.key}`);
        logger.info(`   Entry Value:`, entry?.value);
        logger.info(`   Entry Identity: ${entry?.identity}`);
        logger.info(`   Local Identity: ${database.identity.id}`);
        
        if (replicationSource === 'REPLICATED') {
          logger.info(`✨ 🔄 UPDATE REPLICATION DETECTED! ${persona} received update from remote peer!`);
        }

        // Add to test results if test is running
        addResult(
          persona,
          "Database Update",
          "success",
          `Entry updated ${replicationSource.toLowerCase()}: ${entry?.key || "unknown key"}`,
          {
            address: eventAddress,
            entryHash: entry?.hash?.toString() || entry?.hash,
            entryKey: entry?.key,
            entryValue: entry?.value,
            replicationSource: replicationSource.toLowerCase(),
          },
        );
      }
    });

    logger.info(
      `✅ [ReplicationTest] Event listeners set up for database instance ${persona}`,
    );
    
    // Verify event listeners are actually working
    logger.info(`🎧 [${persona.toUpperCase()}] EVENT LISTENER VERIFICATION:`);
    logger.info(`   ✅ 'join' event listener: ACTIVE`);
    logger.info(`   ✅ 'update' event listener: ACTIVE`);
    logger.info(`   📊 Tracking database address: ${database.address}`);
    logger.info(`   🗑️ Total tracked addresses: ${replicationTestDatabaseAddresses.size}`);
    logger.info(`   🔍 All tracked:`, Array.from(replicationTestDatabaseAddresses));
  }

  async function clearIndexedDB() {
    logger.info("🗑️ Clearing IndexedDB...");

    // Get all IndexedDB databases
    if ("databases" in indexedDB) {
      const databases = await indexedDB.databases();
      logger.info(
        "📋 Found databases:",
        databases.map((db) => db.name),
      );

      // Delete databases that look like OrbitDB/Helia related
      const dbsToDelete = databases.filter(
        (db) =>
          db.name.includes("helia") ||
          db.name.includes("orbit") ||
          db.name.includes("level") ||
          db.name.includes("replication-test") ||
          db.name.includes("alice") ||
          db.name.includes("bob"),
      );

      for (const db of dbsToDelete) {
        try {
          logger.info(`🗑️ Deleting database: ${db.name}`);

          // Add timeout to prevent hanging
          await Promise.race([
            new Promise((resolve, reject) => {
              const deleteReq = indexedDB.deleteDatabase(db.name);
              deleteReq.onsuccess = () => resolve();
              deleteReq.onerror = () => reject(deleteReq.error);
              deleteReq.onblocked = () => {
                logger.warn(`⚠️ Database deletion blocked for: ${db.name}`);
                // Don't reject immediately, give it more time
              };
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 5000),
            ),
          ]);

          logger.info(`✅ Deleted database: ${db.name}`);
        } catch (error) {
          if (error.message === "Timeout") {
            logger.warn(`⏱️ Timeout deleting database ${db.name} - skipping`);
          } else {
            logger.warn(`⚠️ Failed to delete database ${db.name}:`, error);
          }
        }
      }
    }

    logger.info("🧹 IndexedDB cleanup completed");
  }

  // Alice's functions
  async function initializeAlice() {
    if (aliceRunning) return;

    if (!storageBackend) {
      addResult("alice", "Error", "error", "Choose where backups go first");
      return;
    }

    aliceRunning = true;
    aliceError = null;
    aliceResults = [];
    aliceStep = "Initializing Alice...";

    try {
      // Generate both Alice and Bob identities if not exists
      if (!bothIdentitiesGenerated) {
        addResult(
          "alice",
          "Identity",
          "running",
          "Generating both Alice and Bob identities for proper access control...",
        );
        await generateBothIdentities();
        updateLastResult(
          "alice",
          "success",
          `Both identities created - Alice: ${aliceIdentity.id.slice(-8)}, Bob: ${bobIdentity.id.slice(-8)}`,
        );
      }

      // Create Alice's OrbitDB instance
      addResult(
        "alice",
        "Setup",
        "running",
        "Setting up Alice's OrbitDB instance with P2P replication...",
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // Access controller will be set in createOrbitDBInstance with both Alice & Bob DIDs
      };

      const instance = await createOrbitDBInstance(
        "alice",
        "replication-instance",
        "shared-todos-replication",
        databaseConfig,
      );
      aliceOrbitDB = instance.orbitdb;
      aliceDatabase = instance.database;
      aliceHelia = instance.helia;
      aliceLibp2p = instance.libp2p;

      updateLastResult("alice", "success", `Alice's OrbitDB instance ready with P2P replication`, {
        orbitDBId: aliceOrbitDB.id,
        identityId: aliceOrbitDB.identity.id,
        databaseAddress: aliceDatabase.address,
        peerId: aliceLibp2p.peerId.toString(),
        replicationEnabled,
      });

      aliceStep = "Alice ready to add todos and replicate with Bob";
    } catch (error) {
      logger.error("❌ Alice initialization failed:", error);
      aliceError = error.message;
      aliceStep = `Alice initialization failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  async function addTodos() {
    if (aliceRunning || !aliceDatabase) return;

    aliceRunning = true;
    aliceStep = "Adding todos with replication...";

    try {
      addResult(
        "alice",
        "Adding Todos",
        "running",
        "Adding test todos to replicated database...",
      );

      for (let i = 0; i < originalTodos.length; i++) {
        const todo = originalTodos[i];
        await aliceDatabase.put(todo.id, todo);
        logger.info(`✅ Alice added todo ${i + 1} (will replicate to Bob):`, todo);
      }

      // Get all todos to verify and display
      aliceTodos = await aliceDatabase.all();

      updateLastResult(
        "alice",
        "success",
        `Successfully added ${aliceTodos.length} todos - awaiting replication to Bob`,
        {
          todosAdded: aliceTodos.map((t) => ({
            key: t.key,
            text: t.value.text,
            completed: t.value.completed,
          })),
          databaseAddress: aliceDatabase.address,
          replicationEnabled,
        },
      );

      aliceStep = "Alice ready to backup (Bob should see replicated todos)";
    } catch (error) {
      logger.error("❌ Adding todos failed:", error);
      aliceError = error.message;
      aliceStep = `Adding todos failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  async function backupAlice() {
    if (aliceRunning || !aliceDatabase) return;

    if (!storageBackend) {
      addResult("alice", "Error", "error", "Choose where backups go first");
      return;
    }

    aliceRunning = true;
    aliceStep = `Creating backup on ${storageLabel}...`;

    try {
      addResult(
        "alice",
        "Backup",
        "running",
        `Creating backup on ${storageLabel} while replication keeps running...`,
      );

      // The whole database in one CAR: the entries, the manifest, the access
      // controller, and the identity that signed the entries.
      backupResult = await backupDatabase(aliceOrbitDB, aliceDatabase.address, {
        backend: storageBackend,
        eventEmitter: createBackupEvents(),
      });

      if (!backupResult.success) {
        throw new Error(`Backup failed: ${backupResult.error}`);
      }

      updateLastResult(
        "alice",
        "success",
        `Backup created on ${storageLabel}: ${backupResult.blocksTotal} blocks in one CAR - replication preserved`,
        {
          metadataCID: backupResult.backupFiles?.metadataCID,
          carCID: backupResult.backupFiles?.carCID,
          databaseAddress: backupResult.databaseAddress,
          blocksTotal: backupResult.blocksTotal,
          storage: storageLabel,
          replicationStillActive: true,
        },
      );

      aliceStep = `Alice backup complete - Bob can restore from ${storageLabel} while replication continues`;
    } catch (error) {
      logger.error("❌ Backup failed:", error);
      aliceError = error.message;
      aliceStep = `Backup failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  // Bob's functions
  async function initializeBob() {
    logger.info("🚨 initializeBob() called!");
    logger.info(`   bobRunning: ${bobRunning}`);
    logger.info(`   bobDatabase: ${bobDatabase ? 'exists' : 'null'}`);
    logger.info(`   bobOrbitDB: ${bobOrbitDB ? 'exists' : 'null'}`);
    
    if (bobRunning) {
      logger.info("🚫 initializeBob() exiting - bobRunning is true");
      return;
    }

    // Check requirements
    if (!storageBackend) {
      logger.info("🚫 initializeBob() exiting - no storage chosen");
      addResult("bob", "Error", "error", "Choose where backups go first");
      return;
    }

    if (!bothIdentitiesGenerated || !sharedDatabaseAddress) {
      logger.info("🚫 initializeBob() exiting - identities or address not ready");
      addResult(
        "bob",
        "Error",
        "error",
        "Alice must initialize first to generate both identities and create shared database address",
      );
      return;
    }

    logger.info("✅ initializeBob() proceeding with initialization");
    bobRunning = true;
    bobError = null;
    bobResults = [];
    bobStep = "Creating Bob's OrbitDB instance...";

    try {
      addResult(
        "bob",
        "Setup",
        "running",
        "Setting up Bob's OrbitDB instance for P2P replication...",
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // Access controller already set when Alice created the database
      };

      // First, create Bob's OrbitDB instance WITHOUT opening Alice's database yet
      const instance = await createOrbitDBInstance(
        "bob",
        "replication-instance",
        "shared-todos-replication",
        databaseConfig,
        false, // Don't open database yet - wait for connection first
      );
      bobOrbitDB = instance.orbitdb;
      bobHelia = instance.helia;
      bobLibp2p = instance.libp2p;
      // Note: bobDatabase is still null at this point

      // Wait for Bob to have dialable addresses before attempting connection
      logger.info("⏳ Waiting for Bob to have dialable multiaddresses...");
      bobStep = "Waiting for Bob's P2P addresses to be ready...";
      
      addResult(
        "bob",
        "Address Check",
        "running",
        "Waiting for Bob to have dialable multiaddresses before connecting to Alice...",
      );
      
      // Wait for address readiness using event-driven approach (no polling)
      const maxWaitTime = 45000; // 45 seconds timeout
      const startTime = Date.now();
      
      // Use a promise that resolves when addresses become ready
      await new Promise((resolve, reject) => {
        // Check if already ready
        if (bobAddressReady) {
          logger.info('✅ [BOB] Addresses already ready!');
          resolve();
          return;
        }
        
        // Set up one-time listener for address readiness
        const checkAddressReadiness = () => {
          if (bobAddressReady) {
            logger.info('✅ [BOB] Addresses now ready!');
            resolve();
          } else if (Date.now() - startTime >= maxWaitTime) {
            reject(new Error("Timeout waiting for Bob's dialable addresses to be ready"));
          } else {
            // Check again in a short while (minimal polling as fallback)
            setTimeout(checkAddressReadiness, 500);
          }
        };
        
        // Start checking
        checkAddressReadiness();
      });
      
      logger.info("✅ Bob has dialable addresses, now dialing Alice...");
      bobStep = "Dialing Alice to establish P2P connection...";
      
      addResult(
        "bob",
        "Connection",
        "running",
        "Bob dialing Alice to establish P2P connection...",
      );

      // Now that Bob has addresses, try to connect to Alice
      logger.info("📞 Bob attempting to connect directly to Alice...");
      logger.info(`   Alice Peer ID: ${alicePeerId}`);
      logger.info(`   Bob Peer ID: ${bobPeerId}`);
      logger.info(`   Alice libp2p exists: ${!!aliceLibp2p}`);
      logger.info(`   Bob libp2p exists: ${!!bobLibp2p}`);
      logger.info(`   Alice address ready: ${aliceAddressReady}`);
      logger.info(`   Bob address ready: ${bobAddressReady}`);
      
      const connected = await forceDirectConnection();
      logger.info(`📋 forceDirectConnection() returned: ${connected}`);
      
      if (!connected) {
        logger.warn("⚠️  Direct connection failed - proceeding anyway (may rely on discovery)");
      } else {
        logger.info("✅ Direct connection to Alice established!");
      }
      
      // Wait and verify that Bob is actually connected to Alice before opening database
      logger.info("⏳ Waiting to verify connection with Alice...");
      bobStep = "Verifying connection with Alice...";
      
      addResult(
        "bob",
        "Connection Verification",
        "running",
        "Verifying Bob is connected to Alice before opening database...",
      );
      
      // Use event-driven connection verification (minimal polling as fallback)
      const connectionTimeout = 15000; // 15 seconds to verify connection
      const connectionStartTime = Date.now();
      
      const connectionVerified = await new Promise((resolve) => {
        const checkConnection = () => {
          // Check if Alice and Bob are in each other's connected peers list
          const aliceConnectedToBob = aliceConnectedPeers.includes(bobPeerId);
          const bobConnectedToAlice = bobConnectedPeers.includes(alicePeerId);
          const verified = aliceConnectedToBob || bobConnectedToAlice;
          
          logger.info(`🔗 Connection verification:`, {
            aliceConnectedToBob,
            bobConnectedToAlice,
            verified,
            aliceConnectedPeers: aliceConnectedPeers.length,
            bobConnectedPeers: bobConnectedPeers.length
          });
          
          if (verified) {
            resolve(true);
          } else if (Date.now() - connectionStartTime >= connectionTimeout) {
            resolve(false); // Timeout, but don't throw error
          } else {
            // Check again (minimal polling as fallback)
            setTimeout(checkConnection, 1000);
          }
        };
        
        // Start checking immediately
        checkConnection();
      });
      
      if (!connectionVerified) {
        logger.warn("⚠️  Could not verify direct connection, but proceeding with database opening (OrbitDB may work through discovery)");
      } else {
        logger.info("✅ Connection verified! Alice and Bob can see each other.");
      }
      
      // Now that connection is verified (or timed out), open Alice's shared database
      logger.info("📛 Bob now opening Alice's shared database...");
      bobStep = "Opening Alice's shared database...";
      
      addResult(
        "bob",
        "Database Open",
        "running",
        "Bob opening Alice's shared database after verifying connection...",
      );
      
      bobDatabase = await openSharedDatabase(bobOrbitDB, sharedDatabaseAddress, "bob");
      
      // Wait a bit for initial replication after database opening
      await new Promise((resolve) => setTimeout(resolve, 3000));
      bobTodos = await bobDatabase.all();

      updateLastResult(
        "bob",
        "success",
        `Bob ready - dialed Alice and opened shared database with ${bobTodos.length} replicated todos`,
        {
          orbitDBId: bobOrbitDB.id,
          identityId: bobOrbitDB.identity.id,
          databaseAddress: bobDatabase.address,
          sharedAddress: sharedDatabaseAddress,
          peerId: bobLibp2p.peerId.toString(),
          replicatedTodos: bobTodos.length,
          addressesMatch: bobDatabase.address === sharedDatabaseAddress,
          bobAddressesReady: bobAddressReady,
          bobMultiaddrs: bobMultiaddrs,
          connectionEstablished: connected,
          connectionVerified: connectionVerified,
          flowOrder: "1.Created OrbitDB -> 2.Got Addresses -> 3.Dialed Alice -> 4.Verified Connection -> 5.Opened Database"
        },
      );

      bobStep = "Bob ready - dialed Alice, verified connection, then opened shared database for replication";
    } catch (error) {
      logger.error("❌ Bob initialization failed:", error);
      bobError = error.message;
      bobStep = `Bob initialization failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  async function restoreBob() {
    if (bobRunning || !bobOrbitDB || !backupResult) return;

    if (!storageBackend) {
      addResult("bob", "Error", "error", "Choose where backups go first");
      return;
    }

    bobRunning = true;
    bobStep = `Restoring from the backup on ${storageLabel}...`;

    try {
      addResult(
        "bob",
        "Restore",
        "running",
        `Restoring the database from ${storageLabel} while replication keeps running...`,
      );

      // The metadata CID is the whole pointer: it names the CAR, and the CAR
      // carries the blocks. The bytes come from the same storage Alice used.
      const metadataCID = backupResult.backupFiles.metadataCID;
      restoreResult = await restoreFromCID(bobOrbitDB, {
        metadataCID,
        fetchBytes: (cid) => storageBackend.getBlob(cid),
      });

      // The restore reopens the log to read what it put underneath, and OrbitDB
      // hands out one instance per address — so the database Bob opened for
      // replication is the one that was closed. This is his handle now; writing
      // through the old one fails on an aborted signal.
      const restoredDatabase = restoreResult.database;
      bobDatabase = restoredDatabase;
      setupDatabaseEventListeners(bobDatabase, "bob");

      // Add restored database to tracking
      if (restoredDatabase && restoredDatabase.address) {
        replicationTestDatabaseAddresses.add(
          restoredDatabase.address?.toString() || restoredDatabase.address,
        );
      }

      // Wait for indexing and potential replication sync
      await new Promise((resolve) => setTimeout(resolve, 5000));
      bobTodos = await bobDatabase.all();

      updateLastResult(
        "bob",
        "success",
        `Database restored from ${storageLabel}: ${restoreResult.entries} entries, ${restoreResult.blocks} blocks - replication maintained`,
        {
          metadataCID,
          databaseAddress: restoreResult.address,
          entriesRecovered: restoreResult.entries,
          blocksRestored: restoreResult.blocks,
          headsJoined: restoreResult.joined,
          todosRestored: bobTodos.map((t) => ({
            key: t.key,
            text: t.value.text,
            completed: t.value.completed,
          })),
          replicationPreserved: true,
          sharedDatabase: bobDatabase?.address === sharedDatabaseAddress,
        },
      );

      bobStep = "Bob restore complete - replication with Alice maintained";
    } catch (error) {
      logger.error("❌ Restore failed:", error);
      bobError = error.message;
      bobStep = `Restore failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  // Test replication by having Bob add a todo
  async function addBobTodo() {
    logger.info("🚨 addBobTodo() called!");
    logger.info(`   bobRunning: ${bobRunning}`);
    logger.info(`   bobDatabase: ${bobDatabase ? 'exists' : 'null'}`);
    logger.info(`   Guard condition (bobRunning || !bobDatabase): ${bobRunning || !bobDatabase}`);
    
    if (bobRunning || !bobDatabase) {
      logger.info("🚫 addBobTodo() exiting - guard condition met");
      return;
    }

    logger.info("✅ addBobTodo() proceeding with todo addition");
    bobRunning = true;
    bobStep = "Bob adding todo to test replication...";

    try {
      const bobTodo = {
        id: "bob_replication_test_" + Date.now(),
        text: "Added by Bob - should replicate to Alice",
        completed: false,
        createdAt: new Date().toISOString(),
        createdBy: "bob",
      };

      logger.info("📊 Before adding - Bob todos:", bobTodos.length);
      if (aliceDatabase) {
        const aliceDataBefore = await aliceDatabase.all();
        logger.info("📊 Before adding - Alice todos:", aliceDataBefore.length);
      }
      
      // Test write operation
      logger.info('📝 Bob attempting to write todo to shared database...');
      await bobDatabase.put(bobTodo.id, bobTodo);
      logger.info("✅ Bob added todo (should replicate to Alice):", bobTodo);

      // Wait a bit for replication and check status
      logger.info("⏳ Waiting for replication events...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      // Force check replication status
      await checkReplicationStatus();
      
      bobTodos = await bobDatabase.all();

      addResult(
        "bob",
        "Replication Test",
        "success",
        "Bob added todo - should appear in Alice's database via replication",
        {
          todoAdded: bobTodo,
          totalTodos: bobTodos.length,
        }
      );

      bobStep = "Bob added todo - check Alice's list for replication";
    } catch (error) {
      logger.error("❌ Bob todo add failed:", error);
      bobError = error.message;
      bobStep = `Bob todo add failed: ${error.message}`;
      addResult("bob", "Replication Test", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  // Cleanup state
  let cleanupRunning = false;

  // Cleanup functions
  async function cleanup() {
    logger.info("🧹 Cleaning up all instances...");
    cleanupRunning = true;

    try {
      // Cleanup Alice
      try {
        logger.info("🧹 Cleaning up Alice...");
        if (aliceDatabase) await aliceDatabase.close();
        if (aliceOrbitDB) await aliceOrbitDB.stop();
        if (aliceHelia) await aliceHelia.stop();
        if (aliceLibp2p) await aliceLibp2p.stop();
      } catch (error) {
        logger.warn("⚠️ Alice cleanup error:", error.message);
      }

      // Cleanup Bob
      try {
        logger.info("🧹 Cleaning up Bob...");
        if (bobDatabase) await bobDatabase.close();
        if (bobOrbitDB) await bobOrbitDB.stop();
        if (bobHelia) await bobHelia.stop();
        if (bobLibp2p) await bobLibp2p.stop();
      } catch (error) {
        logger.warn("⚠️ Bob cleanup error:", error.message);
      }

      logger.info("🧹 Clearing IndexedDB...");
      await clearIndexedDB();

      logger.info("🧹 Resetting application state...");
      // Reset state
      aliceOrbitDB = null;
      aliceDatabase = null;
      aliceHelia = null;
      aliceLibp2p = null;
      aliceTodos = [];
      aliceResults = [];
      aliceStep = "";
      aliceError = null;
      alicePeerId = null;
      aliceConnectedPeers = [];

      bobOrbitDB = null;
      bobDatabase = null;
      bobHelia = null;
      bobLibp2p = null;
      bobTodos = [];
      bobResults = [];
      bobStep = "";
      bobError = null;
      bobPeerId = null;
      bobConnectedPeers = [];

      aliceIdentity = null;
      aliceIdentities = null;
      bobIdentity = null;
      bobIdentities = null;
      bothIdentitiesGenerated = false;
      sharedDatabaseAddress = null;
      backupResult = null;
      restoreResult = null;
      replicationTestDatabaseAddresses.clear();
      replicationEvents = [];
      peersConnected = false;
      
      // Reset address readiness states
      aliceMultiaddrs = [];
      bobMultiaddrs = [];
      aliceAddressReady = false;
      bobAddressReady = false;
      relayWarning = "";

      logger.info("✅ Cleanup completed successfully!");
    } catch (error) {
      logger.error("❌ Cleanup failed:", error);
    } finally {
      cleanupRunning = false;
    }
  }


  // Utility functions
  function formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
  }

  function getStatusIcon(status) {
    switch (status) {
      case "running":
        return Loader2;
      case "success":
        return CheckCircle;
      case "error":
        return AlertCircle;
      default:
        return AlertCircle;
    }
  }

  function getStatusClass(status) {
    switch (status) {
      case "running":
        return "text-blue-600 dark:text-blue-400";
      case "success":
        return "text-green-600 dark:text-green-400";
      case "error":
        return "text-red-600 dark:text-red-400";
      default:
        return "text-gray-600 dark:text-gray-400";
    }
  }
</script>

<Grid>
  <!-- Where backups go -->
  <Row>
    <Column>
      <StorageBackendPicker
        on:configured={handleStorageConfigured}
        on:cleared={handleStorageCleared}
      />

      {#if !storageBackend}
        <InlineNotification
          kind="info"
          title="Choose storage"
          subtitle="Pick where backups go before Alice and Bob start"
          style="margin-bottom: 2rem;"
        />
      {/if}

      {#if relayWarning}
        <InlineNotification
          kind="warning"
          hideCloseButton
          title="No relay"
          subtitle={relayWarning}
          style="margin-bottom: 2rem;"
        />
      {/if}
    </Column>
  </Row>

  <!-- Header -->
  <Row>
    <Column>
      <div style="text-align:center;margin-bottom:2rem;">
        <div
          style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:1rem;"
        >
          <img src="/orbitdb.png" alt="OrbitDB" style="width:32px;height:32px;object-fit:contain;" />
          <h3 style="font-size:1.25rem;font-weight:bold;margin:0;">
            Alice & Bob P2P Replication + Backup/Restore Demo
          </h3>
        </div>
        <p style="color:var(--cds-text-secondary);margin:0;">
          Alice & Bob connect via libp2p, share the same database address for real-time replication,
          and back up and restore to Aleph, Pinata or Lighthouse while the P2P connection keeps running.
        </p>
      </div>
    </Column>
  </Row>

  <!-- Replication Status -->
  <Row>
    <Column>
      <Tile style="margin-bottom: 2rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
          <h5 style="font-size:1rem;font-weight:600;margin:0;">P2P Replication Status</h5>
          <Toggle
            size="sm"
            labelText=""
            toggled={replicationEnabled}
            on:toggle={() => (replicationEnabled = !replicationEnabled)}
            disabled={aliceOrbitDB || bobOrbitDB}
          >
            Replication: {replicationEnabled ? 'Enabled' : 'Disabled'}
          </Toggle>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-bottom:1rem;">
          <div style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.25rem;">
              {#if peersConnected}
                <Connect size={16} style="color:var(--cds-support-success);" />
              {:else}
                <Warning size={16} style="color:var(--cds-support-error);" />
              {/if}
              <span style="font-size:0.875rem;font-weight:500;">Peer Connection</span>
            </div>
            <span style="font-size:0.75rem;color:var(--cds-text-secondary);">
              {peersConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          
          <div style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.25rem;">
              <DataBase size={16} style="color:var(--cds-support-info);" />
              <span style="font-size:0.875rem;font-weight:500;">Shared Database</span>
            </div>
            <span style="font-size:0.75rem;color:var(--cds-text-secondary);">
              {sharedDatabaseAddress ? 'Created' : 'Not Created'}
            </span>
          </div>
          
          <div style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.25rem;">
              <Users size={16} style="color:var(--cds-support-warning);" />
              <span style="font-size:0.875rem;font-weight:500;">Replication Events</span>
            </div>
            <span style="font-size:0.75rem;color:var(--cds-text-secondary);">
              {replicationEvents.length} events
            </span>
          </div>
        </div>

        {#if sharedDatabaseAddress}
          <div style="margin-top:1rem;">
            <CodeSnippet type="single" light wrapText>
              Shared DB: {sharedDatabaseAddress}
            </CodeSnippet>
          </div>
        {/if}
      </Tile>
    </Column>
  </Row>

  <!-- Controls -->
  <Row>
    <Column>
      <div
        style="display:flex;align-items:center;justify-content:center;gap:1rem;margin-bottom:2rem;"
      >
        <Button
          type="button"
          kind="secondary"
          size="sm"
          icon={showDetails ? ViewOff : View}
          on:click={() => (showDetails = !showDetails)}
        >
          {showDetails ? "Hide Details" : "Show Details"}
        </Button>

        <Button 
          type="button" 
          kind="danger" 
          size="sm" 
          icon={cleanupRunning ? undefined : Reset}
          disabled={cleanupRunning}
          on:click={cleanup}
        >
          {#if cleanupRunning}<Loading withOverlay={false} small />{/if}
          {cleanupRunning ? "Resetting..." : "Reset All"}
        </Button>
        
        {#if aliceDatabase && bobDatabase}
          <Button type="button" kind="tertiary" size="sm" on:click={checkReplicationStatus}>
            🔄 Check Replication
          </Button>
          
          <Button 
            type="button" 
            kind="secondary" 
            size="sm" 
            icon={View}
            on:click={() => debugDatabasePropertiesComparison(aliceDatabase, bobDatabase)}
          >
            🔍 Debug DB Props
          </Button>
        {/if}
        
        {#if alicePeerId && bobPeerId && aliceLibp2p && bobLibp2p}
          <Button 
            type="button" 
            kind="primary" 
            size="sm" 
            disabled={!aliceAddressReady || !bobAddressReady}
            on:click={forceDirectConnection}
          >
            📞 Force Connection
            {#if !aliceAddressReady || !bobAddressReady}
              (Waiting for addresses)
            {/if}
          </Button>
        {/if}
      </div>
    </Column>
  </Row>

  <!-- Alice & Bob Responsive Layout -->
  <Row>
    <!-- Alice's Section -->
    <Column
      sm={16}
      md={16}
      lg={8}
      xl={8}
      style="margin-bottom: 1rem;"
    >
      <Tile style="height:100%;">
        <div
          style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;"
        >
          <div
            style="display:flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:50%;background-color:var(--cds-support-info);"
          >
            <UserAvatar size={16} style="color:white;" />
          </div>
          <h4 style="font-size:1.125rem;font-weight:600;margin:0;">
            Alice (Data Creator & Replicator)
          </h4>
        </div>

        <!-- Alice's P2P Info -->
        {#if alicePeerId}
          <Tile style="margin-bottom:1rem;">
            <div style="margin-bottom:0.5rem;">
              <span style="font-size:0.875rem;font-weight:500;">Peer ID:</span>
              <CodeSnippet type="single" style="margin-top:0.25rem;">
                {alicePeerId.slice(-16)}
              </CodeSnippet>
            </div>
            <div style="margin-bottom:0.5rem;">
              <span style="font-size:0.875rem;font-weight:500;">Connected Peers:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {aliceConnectedPeers.length}
              </span>
            </div>
            <div>
              <span style="font-size:0.875rem;font-weight:500;">Dialable Addresses:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {aliceAddressReady ? '✅ Ready' : '⏳ Waiting'}
              </span>
              {#if aliceMultiaddrs.length > 0}
                <div style="margin-top:0.25rem;font-size:0.75rem;color:var(--cds-text-disabled);">
                  {aliceMultiaddrs.length} address{aliceMultiaddrs.length !== 1 ? 'es' : ''} available
                </div>
              {/if}
            </div>
          </Tile>
        {/if}

        <!-- Alice's Status -->
        {#if aliceStep}
          {#if aliceError}
            <InlineNotification
              kind="error"
              title="Error"
              subtitle={aliceStep}
              style="margin-bottom:1rem;"
            />
          {:else if aliceRunning}
            <InlineNotification
              kind="info"
              title="Processing"
              subtitle={aliceStep}
              style="margin-bottom:1rem;"
            />
          {:else}
            <InlineNotification
              kind="success"
              title="Success"
              subtitle={aliceStep}
              style="margin-bottom:1rem;"
            />
          {/if}
        {/if}

        <!-- Alice's Actions -->
        <div
          style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem;"
        >
          <Button
            type="button"
            size="sm"
            icon={aliceRunning ? undefined : DataBase}
            on:click={initializeAlice}
            disabled={aliceRunning || aliceOrbitDB || !storageBackend}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Alice (Creates Shared DB)
          </Button>

          <Button
            type="button"
            size="sm"
            kind="secondary"
            icon={aliceRunning ? undefined : Add}
            on:click={addTodos}
            disabled={aliceRunning || !aliceDatabase || aliceTodos.length > 0}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            2. Add Todos (Will Replicate to Bob)
          </Button>

          <Button
            type="button"
            size="sm"
            kind="tertiary"
            icon={aliceRunning ? undefined : CloudUpload}
            on:click={backupAlice}
            disabled={aliceRunning ||
              aliceTodos.length === 0 ||
              backupResult ||
              !storageBackend}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            3. Backup to {storageLabel || "storage"}
          </Button>
        </div>

        <!-- Alice's Todos -->
        {#if aliceTodos.length > 0}
          <div style="margin-bottom:1rem;">
            <h5
              style="font-size:0.875rem;font-weight:500;margin-bottom:0.5rem;"
            >
              Alice's Todos:
            </h5>
            <div data-testid="alice-todos" style="display:flex;flex-direction:column;gap:0.25rem;">
              {#each aliceTodos as todo}
                <div
                  style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem;background:var(--cds-layer-accent);border-radius:0.25rem;font-size:0.75rem;"
                >
                  <code style="color:var(--cds-text-secondary);"
                    >{todo.key}:</code
                  >
                  <span
                    style={todo.value.completed
                      ? "text-decoration:line-through;color:var(--cds-text-disabled);"
                      : ""}
                  >
                    {todo.value.text}
                  </span>
                  <span style="margin-left:auto;font-size:0.625rem;color:var(--cds-text-secondary);">
                    👤 {todo.value.createdBy}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Alice's Results -->
        {#if aliceResults.length > 0}
          <Tile>
            <h5
              style="font-size:0.875rem;font-weight:500;margin-bottom:0.5rem;"
            >
              Alice's Progress:
            </h5>
            <div style="display:flex;flex-direction:column;gap:0.5rem;">
              {#each aliceResults as result}
                <div style="display:flex;gap:0.5rem;align-items:flex-start;">
                  <svelte:component
                    this={getStatusIcon(result.status)}
                    size={16}
                    style={`margin-top:2px;${getStatusClass(result.status)}`}
                  />
                  <div style="flex:1;">
                    <div style="display:flex;justify-content:space-between;">
                      <span style="font-size:0.75rem;font-weight:500;"
                        >{result.step}</span
                      >
                      <span
                        style="font-size:0.75rem;color:var(--cds-text-secondary);"
                        >{formatTimestamp(result.timestamp)}</span
                      >
                    </div>
                    <p
                      style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;"
                    >
                      {result.message}
                    </p>
                    {#if showDetails && result.data}
                      <CodeSnippet
                        type="multi"
                        wrapText
                        style="margin-top:0.25rem;"
                      >
                        {JSON.stringify(result.data, null, 2)}
                      </CodeSnippet>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </Tile>
        {/if}
      </Tile>
    </Column>

    <!-- Bob's Section -->
    <Column
      sm={16}
      md={16}
      lg={8}
      xl={8}
    >
      <Tile style="height:100%;">
        <div
          style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;"
        >
          <div
            style="display:flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:50%;background-color:var(--cds-support-warning);"
          >
            <UserAvatar size={16} style="color:white;" />
          </div>
          <h4 style="font-size:1.125rem;font-weight:600;margin:0;">
            Bob (Replicator & Restorer)
          </h4>
        </div>

        <!-- Bob's P2P Info -->
        {#if bobPeerId}
          <Tile style="margin-bottom:1rem;">
            <div style="margin-bottom:0.5rem;">
              <span style="font-size:0.875rem;font-weight:500;">Peer ID:</span>
              <CodeSnippet type="single" style="margin-top:0.25rem;">
                {bobPeerId.slice(-16)}
              </CodeSnippet>
            </div>
            <div style="margin-bottom:0.5rem;">
              <span style="font-size:0.875rem;font-weight:500;">Connected Peers:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {bobConnectedPeers.length}
              </span>
            </div>
            <div>
              <span style="font-size:0.875rem;font-weight:500;">Dialable Addresses:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {bobAddressReady ? '✅ Ready' : '⏳ Waiting'}
              </span>
              {#if bobMultiaddrs.length > 0}
                <div style="margin-top:0.25rem;font-size:0.75rem;color:var(--cds-text-disabled);">
                  {bobMultiaddrs.length} address{bobMultiaddrs.length !== 1 ? 'es' : ''} available
                </div>
              {/if}
            </div>
          </Tile>
        {/if}

        <!-- Bob's Status -->
        {#if bobStep}
          {#if bobError}
            <InlineNotification
              kind="error"
              title="Error"
              subtitle={bobStep}
              style="margin-bottom:1rem;"
            />
          {:else if bobRunning}
            <InlineNotification
              kind="info"
              title="Processing"
              subtitle={bobStep}
              style="margin-bottom:1rem;"
            />
          {:else}
            <InlineNotification
              kind="success"
              title="Success"
              subtitle={bobStep}
              style="margin-bottom:1rem;"
            />
          {/if}
        {/if}

        <!-- Bob's Actions -->
        <div
          style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem;"
        >
          <Button
            type="button"
            size="sm"
            kind="secondary"
            icon={bobRunning ? undefined : DataBase}
            on:click={() => {
              logger.info("🔘 Initialize Bob button clicked!");
              initializeBob();
            }}
            disabled={bobRunning ||
              !bothIdentitiesGenerated ||
              !sharedDatabaseAddress ||
              bobOrbitDB ||
              !storageBackend ||
              !aliceAddressReady}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Bob (Connect to Shared DB)
          </Button>

          <Button
            type="button"
            size="sm"
            kind="secondary"
            icon={bobRunning ? undefined : Add}
            on:click={() => {
              logger.info("🔘 Add Bob Todo button clicked!");
              addBobTodo();
            }}
            disabled={bobRunning || !bobDatabase}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            2. Add Todo (Test Replication to Alice)
          </Button>

          <Button
            type="button"
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : CloudDownload}
            on:click={restoreBob}
            disabled={bobRunning ||
              !bobOrbitDB ||
              !backupResult ||
              restoreResult ||
              !storageBackend}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            3. Restore from {storageLabel || "storage"}
          </Button>
        </div>

        <!-- Shared Database Status -->
        {#if !bothIdentitiesGenerated}
          <InlineNotification
            kind="info"
            title="Waiting"
            subtitle="Waiting for Alice to generate both identities..."
            style="margin-bottom:1rem;"
          />
        {:else if !sharedDatabaseAddress}
          <InlineNotification
            kind="info"
            title="Identities Ready"
            subtitle="Waiting for Alice to create shared database..."
            style="margin-bottom:1rem;"
          />
        {:else if !aliceAddressReady}
          <InlineNotification
            kind="info"
            title="Database Ready"
            subtitle="Waiting for Alice's P2P addresses to be ready..."
            style="margin-bottom:1rem;"
          />
        {:else}
          <InlineNotification
            kind="success"
            title="Ready"
            subtitle="All requirements met - Bob can now initialize"
            style="margin-bottom:1rem;"
          />
        {/if}

        <!-- Bob's Address Status -->
        {#if bobOrbitDB && !bobAddressReady}
          <InlineNotification
            kind="info"
            title="Address Check"
            subtitle="Waiting for Bob's P2P addresses to be ready for dialing..."
            style="margin-bottom:1rem;"
          />
        {:else if bobOrbitDB && bobAddressReady}
          <InlineNotification
            kind="success"
            title="Addresses Ready"
            subtitle="Bob has dialable P2P addresses available"
            style="margin-bottom:1rem;"
          />
        {/if}

        <!-- Backup Status Indicator -->
        {#if !backupResult}
          <InlineNotification
            kind="info"
            title="Backup Status"
            subtitle="Waiting for Alice to create backup..."
            style="margin-bottom:1rem;"
          />
        {:else}
          <InlineNotification
            kind="success"
            title="Backup Available"
            subtitle="Alice's backup ready for restore"
            style="margin-bottom:1rem;"
          />
        {/if}

        <!-- Bob's Replicated Todos -->
        {#if bobTodos.length > 0}
          <div style="margin-bottom:1rem;">
            <h5
              style="font-size:0.875rem;font-weight:500;margin-bottom:0.5rem;"
            >
              Bob's Replicated Todos:
            </h5>
            <div data-testid="bob-todos" style="display:flex;flex-direction:column;gap:0.25rem;">
              {#each bobTodos as todo}
                <div
                  style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem;background:var(--cds-layer-accent);border-radius:0.25rem;font-size:0.75rem;"
                >
                  <code style="color:var(--cds-text-secondary);"
                    >{todo.key}:</code
                  >
                  <span
                    style={todo.value.completed
                      ? "text-decoration:line-through;color:var(--cds-text-disabled);"
                      : ""}
                  >
                    {todo.value.text}
                  </span>
                  <span style="margin-left:auto;font-size:0.625rem;color:var(--cds-text-secondary);">
                    {todo.value.createdBy === 'alice' ? '🔄 from Alice' : 
                     todo.value.createdBy === 'bob' ? '👤 by Bob' : '✨ replicated'}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Bob's Results -->
        {#if bobResults.length > 0}
          <Tile>
            <h5
              style="font-size:0.875rem;font-weight:500;margin-bottom:0.5rem;"
            >
              Bob's Progress:
            </h5>
            <div style="display:flex;flex-direction:column;gap:0.5rem;">
              {#each bobResults as result}
                <div style="display:flex;gap:0.5rem;align-items:flex-start;">
                  <svelte:component
                    this={getStatusIcon(result.status)}
                    size={16}
                    style={`margin-top:2px;${getStatusClass(result.status)}`}
                  />
                  <div style="flex:1;">
                    <div style="display:flex;justify-content:space-between;">
                      <span style="font-size:0.75rem;font-weight:500;"
                        >{result.step}</span
                      >
                      <span
                        style="font-size:0.75rem;color:var(--cds-text-secondary);"
                        >{formatTimestamp(result.timestamp)}</span
                      >
                    </div>
                    <p
                      style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;"
                    >
                      {result.message}
                    </p>
                    {#if showDetails && result.data}
                      <CodeSnippet
                        type="multi"
                        wrapText
                        style="margin-top:0.25rem;"
                      >
                        {JSON.stringify(result.data, null, 2)}
                      </CodeSnippet>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </Tile>
        {/if}

        <!-- Summary Stats -->
        {#if bobTodos.length > 0 || bobResults.length > 0}
          <div style="margin-top:1rem;padding:0.5rem;background:var(--cds-layer-01);border-radius:0.25rem;">
            <p style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;text-align:center;">
              📊 {bobTodos.length} replicated todos • {bobResults.length} progress items
              {#if peersConnected}
                • 🔗 P2P Connected
              {/if}
            </p>
          </div>
        {/if}
      </Tile>
    </Column>
  </Row>

  <!-- Replication Events -->
  {#if replicationEvents.length > 0 && showDetails}
    <Row>
      <Column>
        <Tile>
          <h5 style="font-size:1rem;font-weight:600;margin-bottom:1rem;">
            Recent Replication Events
          </h5>
          <div style="display:flex;flex-direction:column;gap:0.5rem;">
            {#each replicationEvents.slice(-10) as event}
              <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem;background:var(--cds-layer-accent);border-radius:0.25rem;font-size:0.75rem;">
                <span style="color:var(--cds-text-secondary);">
                  {formatTimestamp(event.timestamp)}
                </span>
                <span style="font-weight:500;color:var(--cds-support-info);">
                  {event.type}
                </span>
                <span>
                  {event.peer}:
                </span>
                <span style="color:var(--cds-text-secondary);">
                  {JSON.stringify(event.data)}
                </span>
              </div>
            {/each}
          </div>
        </Tile>
      </Column>
    </Row>
  {/if}

  <!-- Success Summary -->
  {#if aliceTodos.length > 0 && bobTodos.length > 0 && peersConnected}
    <Row>
      <Column>
        <InlineNotification
          kind="success"
          title="Success! P2P Replication + Backup/Restore Working ✅"
          subtitle={`Alice created ${aliceTodos.length} todos, Bob replicated ${bobTodos.length} todos via P2P connection, and backup/restore functionality is available while preserving replication!`}
          style="margin-top:2rem;"
        >
          {#if backupResult && restoreResult}
            <p style="font-size:0.75rem;margin-top:0.5rem;">
              Backup: {backupResult.blocksUploaded}/{backupResult.blocksTotal} blocks
              • Restore: {restoreResult.entriesRecovered} entries recovered • P2P Replication: Active
              • Connection Status: {peersConnected ? 'Connected' : 'Disconnected'}
            </p>
          {/if}
        </InlineNotification>
      </Column>
    </Row>
  {/if}

</Grid>