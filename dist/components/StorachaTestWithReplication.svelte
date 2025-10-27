<script>
  import {
    Plus,
    Upload,
    Download,
    Database,
    CheckCircle,
    AlertCircle,
    Loader2,
    Eye,
    EyeOff,
    User,
    Users,
    ArrowRight,
    ToggleLeft,
    ToggleRight,
    Wifi,
    WifiOff,
  } from "lucide-svelte";
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
  import { all } from "@libp2p/websockets/filters";
  import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
  import {
    backupDatabase,
    restoreLogEntriesOnly,
    clearStorachaSpace,
    OrbitDBStorachaBridge,
  } from "./orbitdb-storacha-bridge";
  import { Identities, useIdentityProvider } from "@orbitdb/core";
  import OrbitDBIdentityProviderDID from "@orbitdb/identity-provider-did";
  import { Ed25519Provider } from "key-did-provider-ed25519";
  import * as KeyDIDResolver from "key-did-resolver";
  import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
  import { wordlist as english } from "@scure/bip39/wordlists/english";
  import { createHash } from "crypto";

  // Import the new Storacha Auth component and Carbon components
  import StorachaAuth from "./StorachaAuth.svelte";
  import {
    Grid,
    Row,
    Column,
    Button,
    Tile,
    Accordion,
    AccordionItem,
    Toggle,
    InlineNotification,
    Loading,
    CodeSnippet,
    ProgressIndicator,
    ProgressStep,
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
    Checkmark,
    Warning,
    Connect,
    Disconnect,
  } from "carbon-icons-svelte";

  // Storacha authentication state
  let storachaAuthenticated = false;
  let storachaClient = null;
  let storachaCredentials = null;

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
  let sharedIdentity = null;
  let sharedIdentities = null;
  let sharedDatabaseAddress = null;
  let backupResult = null;
  let restoreResult = null;
  let showDetails = false;
  let replicationEnabled = true;

  // Progress tracking state
  let uploadProgress = null;
  let downloadProgress = null;
  let showProgress = false;

  // Connection state
  let peersConnected = false;
  let replicationEvents = [];
  
  // Enhanced connection tracking
  let connectionStates = new Map();
  let databaseReadyStates = new Map();
  let connectionTimeouts = new Map();
  
  // Track database readiness separately from peer connections
  let aliceDatabaseReady = false;
  let bobDatabaseReady = false;

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
      text: "Backup database to Storacha",
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

  // LibP2P Configuration (from simple-todo)
  const RELAY_BOOTSTRAP_ADDR_DEV = '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWAJjbRkp8FPF5MKgMU53aUTxWkqvDrs4zc1VMbwRwfsbE';
  const RELAY_BOOTSTRAP_ADDR_PROD = '/dns4/91-99-67-170.k51qzi5uqu5dl6dk0zoaocksijnghdrkxir5m4yfcodish4df6re6v3wbl6njf.libp2p.direct/tcp/4002/wss/p2p/12D3KooWPJYEZSwfmRL9SHehYAeQKEbCvzFu7vtKWb6jQfMSMb8W';
  const PUBSUB_TOPICS = ['orbitdb-replication._peer-discovery._p2p._pubsub'];
  
  // Use production relay for replication demo
  const RELAY_BOOTSTRAP_ADDR = [RELAY_BOOTSTRAP_ADDR_PROD];

  async function createLibp2pConfig(options = {}) {
    const {
      privateKey = null,
      enablePeerConnections = true,
      enableNetworkConnection = true
    } = options;

    // Configure peer discovery based on enablePeerConnections
    const peerDiscoveryServices = [];
    if (enablePeerConnections && enableNetworkConnection) {
      console.log('🔍 Enabling pubsub peer discovery');
      peerDiscoveryServices.push(
        pubsubPeerDiscovery({
          interval: 5000, // More frequent broadcasting
          topics: PUBSUB_TOPICS, // Configurable topics
          listenOnly: false,
          emitSelf: true // Enable even when no peers are present initially
        })
      );
    }

    // Configure services based on network connection preference
    const services = {
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: true, // Enable to see our own messages
        allowPublishToZeroTopicPeers: true
      })
    };

    // Only add bootstrap service if network connections are enabled
    if (enableNetworkConnection) {
      console.log('🔍 Enabling bootstrap, pubsub, autonat, dcutr services');
      services.bootstrap = bootstrap({ list: RELAY_BOOTSTRAP_ADDR });
      services.autonat = autoNAT();
      services.dcutr = dcutr();
    }

    return {
      ...(privateKey && { privateKey: privateKey }),
      addresses: {
        listen: enableNetworkConnection
          ? ['/p2p-circuit', '/webrtc', '/webtransport', '/wss', '/ws']
          : ['/webrtc'] // Only local WebRTC when network connection is disabled
      },
      transports: enableNetworkConnection
        ? [
            webSockets({
              filter: all
            }),
            webRTC(),
            circuitRelayTransport({
              discoverRelays: 1
            })
          ]
        : [webRTC(), circuitRelayTransport({ discoverRelays: 1 })], // Only WebRTC transport when network connection is disabled
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
      services
    };
  }

  // Create and setup bridge with progress tracking
  function createStorachaBridge(credentials) {
    if (!credentials) {
      throw new Error("Storacha credentials are required but not provided");
    }
    
    if (!credentials.method) {
      throw new Error("Storacha credentials must have a method property");
    }
    
    const bridgeOptions = {};
    
    if (credentials.method === "credentials") {
      const storachaKey = localStorage.getItem("storacha_key");
      const storachaProof = localStorage.getItem("storacha_proof");
      
      if (storachaKey && storachaProof) {
        bridgeOptions.storachaKey = storachaKey;
        bridgeOptions.storachaProof = storachaProof;
      } else {
        throw new Error("Storacha credentials not found in storage");
      }
    } else if (credentials.method === "ucan" || credentials.method === "seed") {
      // UCAN authentication support
      if (!storachaClient) {
        throw new Error("UCAN client is required but not available");
      }
      
      bridgeOptions.ucanClient = storachaClient;
      
      // Get current space DID if available
      try {
        const currentSpace = storachaClient.currentSpace();
        if (currentSpace) {
          bridgeOptions.spaceDID = currentSpace.did();
        }
      } catch (error) {
        console.warn('Could not get current space DID:', error.message);
      }
    } else {
      throw new Error(
        `Bridge with ${credentials.method} authentication not yet implemented`,
      );
    }
    
    const bridge = new OrbitDBStorachaBridge(bridgeOptions);
    
    // Set up progress event listeners
    bridge.on('uploadProgress', (progress) => {
      console.log('📤 Upload Progress:', progress);
      if (progress && typeof progress === 'object') {
        uploadProgress = progress;
        showProgress = true;
        
        // Update Alice step for upload progress
        if (progress.status === 'starting') {
          aliceStep = `Starting backup: ${progress.total} blocks to upload`;
        } else if (progress.status === 'uploading') {
          aliceStep = `Uploading: ${progress.current}/${progress.total} blocks (${progress.percentage}%)`;
        } else if (progress.status === 'completed') {
          aliceStep = `Upload completed: ${progress.summary?.successful || 0} successful, ${progress.summary?.failed || 0} failed`;
          showProgress = false;
        }
      } else {
        console.warn('Invalid upload progress data:', progress);
      }
    });
    
    bridge.on('downloadProgress', (progress) => {
      console.log('📥 Download Progress:', progress);
      if (progress && typeof progress === 'object') {
        downloadProgress = progress;
        showProgress = true;
        
        // Update Bob step for download progress
        if (progress.status === 'starting') {
          bobStep = `Starting restore: ${progress.total} files to download`;
        } else if (progress.status === 'downloading') {
          bobStep = `Downloading: ${progress.current}/${progress.total} files (${progress.percentage}%)`;
        } else if (progress.status === 'completed') {
          bobStep = `Download completed: ${progress.summary?.downloaded || 0} downloaded, ${progress.summary?.failed || 0} failed`;
          showProgress = false;
        }
      } else {
        console.warn('Invalid download progress data:', progress);
      }
    });
    
    return bridge;
  }

  // Handle Storacha authentication events
  function handleStorachaAuthenticated(event) {
    console.log("🔐 Storacha authenticated:", event.detail);
    storachaAuthenticated = true;
    storachaClient = event.detail.client;
    storachaCredentials = {
      method: event.detail.method,
      spaces: event.detail.spaces,
      identity: event.detail.identity, // Available if authenticated with seed
    };

    // Store credentials for backup/restore operations
    if (event.detail.method === "credentials") {
      // For key/proof authentication, we need to extract the credentials
      console.log(
        "📝 Credentials-based authentication - storing for backup operations",
      );
    } else if (
      event.detail.method === "ucan" ||
      event.detail.method === "seed"
    ) {
      console.log(
        `📝 ${event.detail.method}-based authentication - ready for operations`,
      );
    }
  }

  function handleStorachaLogout() {
    console.log("🚪 Storacha logged out");
    storachaAuthenticated = false;
    storachaClient = null;
    storachaCredentials = null;
  }

  function handleSpaceChanged(event) {
    console.log("🔄 Storacha space changed:", event.detail.space);
    // Update any space-dependent operations
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
    console.log(`🆔 Creating ${persona} identity...`);

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

    console.log(`✅ ${persona} identity created: ${identity.id}`);
    return { identity, identities, seedPhrase, masterSeed };
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
    console.log(`🧪 ${persona}: ${step} - ${status} - ${message}`, data || "");
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
    console.log("🔄 Replication Event:", replicationEvent);
  }

  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    useSharedAddress = false,
  ) {
    console.log(`🔧 Creating OrbitDB instance for ${persona}...`);

    // Create libp2p configuration with replication enabled
    const libp2pConfig = await createLibp2pConfig({
      enablePeerConnections: replicationEnabled,
      enableNetworkConnection: replicationEnabled,
    });

    // Create libp2p instance
    const libp2p = await createLibp2p(libp2pConfig);
    console.log(`${persona} libp2p created with peer discovery enabled:`, replicationEnabled);

    // Set up enhanced connection monitoring (replaces polling)
    console.log(`🎧 [ReplicationTest] Event listeners set up for database instance ${persona}`);
    console.log(`🎧 [ALICE] EVENT LISTENER VERIFICATION:`);
    console.log(`   ✅ 'join' event listener: ACTIVE`);
    console.log(`   ✅ 'update' event listener: ACTIVE`);
    console.log(`   📊 Tracking database address: ${database.address}`);
    console.log(`   🗑️ Total tracked addresses: ${replicationTestDatabaseAddresses.size}`);
    console.log(`   🔍 All tracked: [${Array.from(replicationTestDatabaseAddresses).map(addr => `'${addr}'`).join(', ')}]`);
    
    // Use enhanced connection monitoring instead of basic event listeners
    setupEnhancedConnectionMonitoring(libp2p, persona, database);

    // Create Helia instance
    console.log(`🗄️ Initializing ${persona}'s Helia with memory storage for testing...`);
    const helia = await createHelia({ libp2p });
    console.log(`${persona} Helia created with memory storage`);

    // Create OrbitDB instance with unique ID
    const orbitdbConfig = {
      ipfs: helia,
      id: `${persona}-${instanceId}-${Date.now()}-${Math.random()}`,
      directory: `./orbitdb-replication-${persona}-${instanceId}`,
      identity: sharedIdentity,
      identities: sharedIdentities,
    };

    const orbitdb = await createOrbitDB(orbitdbConfig);
    console.log(`${persona} orbitdb:`, orbitdb);

    // Create or open database - use shared address for replication
    let database;
    if (useSharedAddress && sharedDatabaseAddress) {
      console.log(`🔗 ${persona} opening shared database at address:`, sharedDatabaseAddress);
      database = await orbitdb.open(sharedDatabaseAddress);
    } else {
      console.log(`🆕 ${persona} creating new database:`, databaseName);
      database = await orbitdb.open(databaseName, databaseConfig);
      if (!sharedDatabaseAddress) {
        sharedDatabaseAddress = database.address;
        console.log(`📍 Shared database address set:`, sharedDatabaseAddress);
      }
    }
    
    console.log(`${persona} database:`, database);

    // Set up event listeners for this database
    setupDatabaseEventListeners(database, persona);

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
    
    // Trigger database readiness check when peer connections change
    checkDatabaseReadiness();
  }
  
  /**
   * Enhanced connection monitoring setup for libp2p instances
   * Replaces polling with event-driven connection state updates
   */
  function setupEnhancedConnectionMonitoring(libp2p, persona, database = null) {
    console.log(`🔧 Setting up enhanced connection monitoring for ${persona}`);
    
    // Track connection states for this persona
    const personaConnectionStates = new Map();
    connectionStates.set(persona, personaConnectionStates);
    
    // Peer connection events (high-level)
    libp2p.addEventListener('peer:connect', (event) => {
      const peerId = event.detail.toString();
      console.log(`🔗 [${persona.toUpperCase()}] Peer connected: ${peerId}`);
      
      // Update connection tracking immediately
      personaConnectionStates.set(peerId, {
        connected: true,
        timestamp: Date.now(),
        type: 'peer'
      });
      
      // Update UI state immediately
      if (persona === "alice") {
        if (!aliceConnectedPeers.includes(peerId)) {
          aliceConnectedPeers = [...aliceConnectedPeers, peerId];
        }
        alicePeerId = libp2p.peerId.toString();
      } else if (persona === "bob") {
        if (!bobConnectedPeers.includes(peerId)) {
          bobConnectedPeers = [...bobConnectedPeers, peerId];
        }
        bobPeerId = libp2p.peerId.toString();
      }
      
      // Immediately update peer connection status and check database readiness
      updatePeerConnectionStatus();
      
      // Add replication event
      addReplicationEvent({
        type: 'peer_connected',
        peer: persona,
        data: { connectedTo: peerId }
      });
      
      // Clear any connection timeout for this peer
      const timeoutKey = `${persona}-${peerId}`;
      if (connectionTimeouts.has(timeoutKey)) {
        clearTimeout(connectionTimeouts.get(timeoutKey));
        connectionTimeouts.delete(timeoutKey);
      }
    });
    
    libp2p.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      console.log(`🔌 [${persona.toUpperCase()}] Peer disconnected: ${peerId}`);
      
      // Update connection tracking immediately
      personaConnectionStates.set(peerId, {
        connected: false,
        timestamp: Date.now(),
        type: 'peer'
      });
      
      // Update UI state immediately
      if (persona === "alice") {
        aliceConnectedPeers = aliceConnectedPeers.filter(p => p !== peerId);
      } else if (persona === "bob") {
        bobConnectedPeers = bobConnectedPeers.filter(p => p !== peerId);
      }
      
      // Immediately update peer connection status and check database readiness
      updatePeerConnectionStatus();
      
      // Add replication event
      addReplicationEvent({
        type: 'peer_disconnected',
        peer: persona,
        data: { disconnectedFrom: peerId }
      });
    });
    
    // Individual connection events (more granular)
    libp2p.addEventListener('connection:open', (event) => {
      const connection = event.detail;
      const peerId = connection.remotePeer.toString();
      
      console.log(`🚀 [${persona.toUpperCase()}] Connection opened:`, {
        peer: peerId,
        direction: connection.direction,
        status: connection.status,
        transient: connection.transient,
        limited: connection.limits != null
      });
      
      // Update connection tracking with detailed info
      personaConnectionStates.set(`${peerId}-connection`, {
        connected: true,
        timestamp: Date.now(),
        type: 'connection',
        direction: connection.direction,
        transient: connection.transient,
        limited: connection.limits != null,
        connection: connection
      });
      
      // Immediately check if database can start syncing
      checkDatabaseSyncReadiness(connection, persona, database);
      
      // Add replication event for connection details
      addReplicationEvent({
        type: 'connection_opened',
        peer: persona,
        data: {
          connectedTo: peerId,
          direction: connection.direction,
          transient: connection.transient,
          limited: connection.limits != null
        }
      });
    });
    
    libp2p.addEventListener('connection:close', (event) => {
      const connection = event.detail;
      const peerId = connection.remotePeer.toString();
      
      console.log(`🔌 [${persona.toUpperCase()}] Connection closed: ${peerId}`);
      
      // Update connection tracking
      personaConnectionStates.set(`${peerId}-connection`, {
        connected: false,
        timestamp: Date.now(),
        type: 'connection'
      });
      
      // Check database readiness
      checkDatabaseReadiness();
      
      // Add replication event
      addReplicationEvent({
        type: 'connection_closed',
        peer: persona,
        data: { disconnectedFrom: peerId }
      });
    });
    
    // Peer discovery events
    libp2p.addEventListener('peer:discovery', (event) => {
      const peerId = event.detail.toString();
      console.log(`🔍 [${persona.toUpperCase()}] Discovered peer: ${peerId}`);
      
      // Add discovered peer to tracking (not connected yet)
      personaConnectionStates.set(`${peerId}-discovered`, {
        connected: false,
        timestamp: Date.now(),
        type: 'discovery'
      });
      
      // Add replication event
      addReplicationEvent({
        type: 'peer_discovered',
        peer: persona,
        data: { discovered: peerId }
      });
    });
    
    console.log(`✅ [${persona.toUpperCase()}] Enhanced connection monitoring active`);
  }
  
  /**
   * Check if database is ready for replication operations
   * Replaces polling with immediate event-driven checks
   */
  function checkDatabaseReadiness() {
    // Check Alice's database readiness
    if (aliceDatabase && aliceLibp2p) {
      const hasAliceConnections = aliceConnectedPeers.length > 0;
      const hasSharedDatabase = sharedDatabaseAddress !== null;
      
      aliceDatabaseReady = hasAliceConnections && hasSharedDatabase;
      
      if (aliceDatabaseReady && !databaseReadyStates.get('alice')) {
        console.log('✅ [ALICE] Database ready for replication - connections available');
        databaseReadyStates.set('alice', true);
        
        addReplicationEvent({
          type: 'database_ready',
          peer: 'alice',
          data: {
            connections: aliceConnectedPeers.length,
            hasSharedAddress: hasSharedDatabase
          }
        });
      } else if (!aliceDatabaseReady && databaseReadyStates.get('alice')) {
        console.log('⚠️ [ALICE] Database no longer ready for replication');
        databaseReadyStates.set('alice', false);
      }
    }
    
    // Check Bob's database readiness
    if (bobDatabase && bobLibp2p) {
      const hasBobConnections = bobConnectedPeers.length > 0;
      const hasSharedDatabase = sharedDatabaseAddress !== null;
      
      bobDatabaseReady = hasBobConnections && hasSharedDatabase;
      
      if (bobDatabaseReady && !databaseReadyStates.get('bob')) {
        console.log('✅ [BOB] Database ready for replication - connections available');
        databaseReadyStates.set('bob', true);
        
        addReplicationEvent({
          type: 'database_ready',
          peer: 'bob',
          data: {
            connections: bobConnectedPeers.length,
            hasSharedAddress: hasSharedDatabase
          }
        });
      } else if (!bobDatabaseReady && databaseReadyStates.get('bob')) {
        console.log('⚠️ [BOB] Database no longer ready for replication');
        databaseReadyStates.set('bob', false);
      }
    }
  }
  
  /**
   * Check if a specific connection enables database syncing
   * Called immediately when a connection opens
   */
  function checkDatabaseSyncReadiness(connection, persona, database) {
    if (!connection || !database) return;
    
    const peerId = connection.remotePeer.toString();
    const isDirectConnection = !connection.transient && !connection.limits;
    
    console.log(`🔍 [${persona.toUpperCase()}] Checking sync readiness for connection to ${peerId}:`, {
      direct: isDirectConnection,
      transient: connection.transient,
      limited: connection.limits != null,
      direction: connection.direction
    });
    
    if (isDirectConnection) {
      console.log(`🚀 [${persona.toUpperCase()}] Direct connection available - database sync optimal`);
      
      addReplicationEvent({
        type: 'direct_connection_ready',
        peer: persona,
        data: {
          connectedTo: peerId,
          optimal: true
        }
      });
    } else {
      console.log(`🔄 [${persona.toUpperCase()}] Relay connection available - database sync possible`);
      
      addReplicationEvent({
        type: 'relay_connection_ready',
        peer: persona,
        data: {
          connectedTo: peerId,
          viaRelay: true
        }
      });
    }
    
    // Trigger overall database readiness check
    checkDatabaseReadiness();
  }

  // Set up event listeners for replication demo databases
  function setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    console.log(`🎧 Setting up replication event listeners for ${persona}'s database...`);
    console.log(`🎯 [ReplicationTest] Database address: ${database.address}`);

    // Add this database address to our tracking set
    replicationTestDatabaseAddresses.add(
      database.address?.toString() || database.address,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any replication test database
      const eventAddress = address?.toString() || address;

      if (replicationTestDatabaseAddresses.has(eventAddress)) {
        console.log(`🔗 [ReplicationTest-${persona}] JOIN EVENT:`, {
          address: eventAddress,
          entry: {
            hash: entry?.hash?.toString() || entry?.hash,
            payload: entry?.payload,
            key: entry?.key,
            value: entry?.value,
          },
          heads: heads?.map((h) => h?.toString()) || heads,
          timestamp: new Date().toISOString(),
        });

        // Add to test results if test is running
        const replicationSource = entry?.identity !== database.identity.id ? 'replicated' : 'local';
        addResult(
          persona,
          "Replication Event",
          "success",
          `Entry ${replicationSource}: ${entry?.key || "unknown key"}`,
          {
            address: eventAddress,
            entryHash: entry?.hash?.toString() || entry?.hash,
            entryKey: entry?.key,
            entryValue: entry?.value,
            replicationSource,
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
          console.warn(`Failed to update ${persona}'s todos:`, error);
        }

        // Add replication event
        addReplicationEvent({
          type: 'data_replicated',
          peer: persona,
          data: {
            key: entry?.key,
            replicationSource,
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
        console.log(`🔄 [ReplicationTest-${persona}] UPDATE EVENT:`, {
          address: eventAddress,
          entry: {
            hash: entry?.hash?.toString() || entry?.hash,
            payload: entry?.payload,
            key: entry?.key,
            value: entry?.value,
          },
          heads: heads?.map((h) => h?.toString()) || heads,
          timestamp: new Date().toISOString(),
        });

        // Add to test results if test is running
        const replicationSource = entry?.identity !== database.identity.id ? 'replicated' : 'local';
        addResult(
          persona,
          "Database Update",
          "success",
          `Entry updated ${replicationSource}: ${entry?.key || "unknown key"}`,
          {
            address: eventAddress,
            entryHash: entry?.hash?.toString() || entry?.hash,
            entryKey: entry?.key,
            entryValue: entry?.value,
            replicationSource,
          },
        );
      }
    });

    console.log(
      `✅ [ReplicationTest] Event listeners set up for database instance ${persona}`,
    );
  }

  async function clearIndexedDB() {
    console.log("🗑️ Clearing IndexedDB...");

    // Get all IndexedDB databases
    if ("databases" in indexedDB) {
      const databases = await indexedDB.databases();
      console.log(
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
          console.log(`🗑️ Deleting database: ${db.name}`);

          // Add timeout to prevent hanging
          await Promise.race([
            new Promise((resolve, reject) => {
              const deleteReq = indexedDB.deleteDatabase(db.name);
              deleteReq.onsuccess = () => resolve();
              deleteReq.onerror = () => reject(deleteReq.error);
              deleteReq.onblocked = () => {
                console.warn(`⚠️ Database deletion blocked for: ${db.name}`);
                // Don't reject immediately, give it more time
              };
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 5000),
            ),
          ]);

          console.log(`✅ Deleted database: ${db.name}`);
        } catch (error) {
          if (error.message === "Timeout") {
            console.warn(`⏱️ Timeout deleting database ${db.name} - skipping`);
          } else {
            console.warn(`⚠️ Failed to delete database ${db.name}:`, error);
          }
        }
      }
    }

    console.log("🧹 IndexedDB cleanup completed");
  }

  // Alice's functions
  async function initializeAlice() {
    if (aliceRunning) return;

    // Check Storacha authentication first
    if (!storachaAuthenticated || !storachaClient) {
      addResult(
        "alice",
        "Error",
        "error",
        "Please authenticate with Storacha first",
      );
      return;
    }

    aliceRunning = true;
    aliceError = null;
    aliceResults = [];
    aliceStep = "Initializing Alice...";

    try {
      // Create shared identity if not exists
      if (!sharedIdentity) {
        addResult(
          "alice",
          "Identity",
          "running",
          "Creating shared identity for replication...",
        );
        const identityResult = await createReusableIdentity("shared");
        sharedIdentity = identityResult.identity;
        sharedIdentities = identityResult.identities;
        updateLastResult(
          "alice",
          "success",
          `Shared identity created: ${sharedIdentity.id}`,
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
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      const instance = await createOrbitDBInstance(
        "alice",
        "replication-instance",
        "shared-todos-replication",
        databaseConfig,
        false, // Alice creates the initial database
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
      console.error("❌ Alice initialization failed:", error);
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
        console.log(`✅ Alice added todo ${i + 1} (will replicate to Bob):`, todo);
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
      console.error("❌ Adding todos failed:", error);
      aliceError = error.message;
      aliceStep = `Adding todos failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  async function backupAlice() {
    if (aliceRunning || !aliceDatabase) return;

    // Check Storacha authentication
    if (!storachaAuthenticated || !storachaClient || !storachaCredentials) {
      addResult(
        "alice",
        "Error",
        "error",
        "Storacha authentication required for backup",
      );
      return;
    }

    aliceRunning = true;
    aliceStep = "Creating backup while maintaining replication...";

    try {
      addResult("alice", "Backup", "running", "Creating backup to Storacha while preserving replication...");

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      // Create bridge with progress tracking
      const bridge = createStorachaBridge(storachaCredentials);

      // Use bridge for backup with log entries only (fallback reconstruction)
      backupResult = await bridge.backupLogEntriesOnly(
        aliceOrbitDB,
        aliceDatabase.address,
        {
          dbConfig: databaseConfig,
          timeout: 60000,
        },
      );

      if (!backupResult.success) {
        throw new Error(`Backup failed: ${backupResult.error}`);
      }

      updateLastResult(
        "alice",
        "success",
        `Backup created successfully with ${backupResult.blocksUploaded}/${backupResult.blocksTotal} blocks - replication preserved`,
        {
          manifestCID: backupResult.manifestCID,
          databaseAddress: backupResult.databaseAddress,
          blocksTotal: backupResult.blocksTotal,
          blocksUploaded: backupResult.blocksUploaded,
          replicationStillActive: true,
        },
      );

      aliceStep = "Alice backup complete - Bob can restore while maintaining replication";
    } catch (error) {
      console.error("❌ Backup failed:", error);
      aliceError = error.message;
      aliceStep = `Backup failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  // Bob's functions
  async function initializeBob() {
    if (bobRunning) return;

    // Check requirements
    if (!storachaAuthenticated || !storachaClient) {
      addResult(
        "bob",
        "Error",
        "error",
        "Please authenticate with Storacha first",
      );
      return;
    }

    if (!sharedIdentity || !sharedDatabaseAddress) {
      addResult(
        "bob",
        "Error",
        "error",
        "Alice must initialize first to create shared identity and database address",
      );
      return;
    }

    bobRunning = true;
    bobError = null;
    bobResults = [];
    bobStep = "Initializing Bob for replication...";

    try {
      addResult(
        "bob",
        "Setup",
        "running",
        "Setting up Bob's OrbitDB instance for P2P replication with shared database...",
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      const instance = await createOrbitDBInstance(
        "bob",
        "replication-instance",
        "shared-todos-replication",
        databaseConfig,
        true, // Bob opens the shared database
      );
      bobOrbitDB = instance.orbitdb;
      bobDatabase = instance.database;
      bobHelia = instance.helia;
      bobLibp2p = instance.libp2p;

      // Wait a bit for initial replication
      await new Promise((resolve) => setTimeout(resolve, 3000));
      bobTodos = await bobDatabase.all();

      updateLastResult(
        "bob",
        "success",
        `Bob's OrbitDB instance ready - connected to shared database with ${bobTodos.length} replicated todos`,
        {
          orbitDBId: bobOrbitDB.id,
          identityId: bobOrbitDB.identity.id,
          databaseAddress: bobDatabase.address,
          sharedAddress: sharedDatabaseAddress,
          peerId: bobLibp2p.peerId.toString(),
          replicatedTodos: bobTodos.length,
          addressesMatch: bobDatabase.address === sharedDatabaseAddress,
        },
      );

      bobStep = "Bob ready - should see Alice's todos via replication";
    } catch (error) {
      console.error("❌ Bob initialization failed:", error);
      bobError = error.message;
      bobStep = `Bob initialization failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  async function restoreBob() {
    if (bobRunning || !bobOrbitDB || !backupResult) return;

    // Check Storacha authentication
    if (!storachaAuthenticated || !storachaClient) {
      addResult(
        "bob",
        "Error",
        "error",
        "Storacha authentication required for restore",
      );
      return;
    }

    bobRunning = true;
    bobStep = "Restoring from backup while preserving replication...";

    try {
      addResult(
        "bob",
        "Restore",
        "running",
        "Restoring database from Storacha backup while maintaining P2P replication...",
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      // Create bridge with progress tracking
      const bridge = createStorachaBridge(storachaCredentials);

      // Use bridge for optimized log-entries-only restore
      restoreResult = await bridge.restoreLogEntriesOnly(
        bobOrbitDB,
        {
          dbName: "shared-todos-replication",
          dbConfig: databaseConfig,
          timeout: 120000,
        },
      );

      if (!restoreResult.success) {
        throw new Error(`Restore failed: ${restoreResult.error}`);
      }

      // Get restored database and wait for replication to sync
      const restoredDatabase = restoreResult.database;

      // Add restored database to tracking
      if (restoredDatabase && restoredDatabase.address) {
        replicationTestDatabaseAddresses.add(
          restoredDatabase.address?.toString() || restoredDatabase.address,
        );
      }

      // Wait for indexing and potential replication sync
      await new Promise((resolve) => setTimeout(resolve, 5000));
      bobTodos = await (bobDatabase || restoredDatabase).all();

      const optimizationInfo = restoreResult.optimizationSavings
        ? `(${restoreResult.optimizationSavings.percentageSaved}% fewer downloads)`
        : "";

      updateLastResult(
        "bob",
        "success",
        `Database restored successfully with ${restoreResult.entriesRecovered} entries - replication maintained ${optimizationInfo}`,
        {
          manifestCID: restoreResult.manifestCID,
          databaseAddress: restoreResult.address,
          entriesRecovered: restoreResult.entriesRecovered,
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
      console.error("❌ Restore failed:", error);
      bobError = error.message;
      bobStep = `Restore failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  // Test replication by having Bob add a todo
  async function addBobTodo() {
    if (bobRunning || !bobDatabase) return;

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

      await bobDatabase.put(bobTodo.id, bobTodo);
      console.log("✅ Bob added todo (should replicate to Alice):", bobTodo);

      // Wait a bit for replication
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      console.error("❌ Bob todo add failed:", error);
      bobError = error.message;
      bobStep = `Bob todo add failed: ${error.message}`;
      addResult("bob", "Replication Test", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  // Cleanup functions
  async function cleanup() {
    console.log("🧹 Cleaning up all instances...");

    // Cleanup Alice
    try {
      if (aliceDatabase) await aliceDatabase.close();
      if (aliceOrbitDB) await aliceOrbitDB.stop();
      if (aliceHelia) await aliceHelia.stop();
      if (aliceLibp2p) await aliceLibp2p.stop();
    } catch (error) {
      console.warn("⚠️ Alice cleanup error:", error.message);
    }

    // Cleanup Bob
    try {
      if (bobDatabase) await bobDatabase.close();
      if (bobOrbitDB) await bobOrbitDB.stop();
      if (bobHelia) await bobHelia.stop();
      if (bobLibp2p) await bobLibp2p.stop();
    } catch (error) {
      console.warn("⚠️ Bob cleanup error:", error.message);
    }

    await clearIndexedDB();

    // Clear enhanced connection monitoring state
    connectionStates.clear();
    databaseReadyStates.clear();
    
    // Clear any pending connection timeouts
    for (const timeout of connectionTimeouts.values()) {
      clearTimeout(timeout);
    }
    connectionTimeouts.clear();
    
    // Reset database ready states
    aliceDatabaseReady = false;
    bobDatabaseReady = false;
    
    console.log('🧹 Cleared enhanced connection monitoring state');

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

    sharedIdentity = null;
    sharedIdentities = null;
    sharedDatabaseAddress = null;
    backupResult = null;
    restoreResult = null;
    replicationTestDatabaseAddresses.clear();
    replicationEvents = [];
    peersConnected = false;
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
  <!-- Storacha Authentication Section -->
  <Row>
    <Column>
      <Tile style="margin-bottom: 2rem;">
        <StorachaAuth
          on:authenticated={handleStorachaAuthenticated}
          on:logout={handleStorachaLogout}
          on:spaceChanged={handleSpaceChanged}
          autoLogin={true}
          showTitle={true}
          compact={false}
          enableSeedAuth={false}
          enableEmailAuth={false}
        />

        {#if !storachaAuthenticated}
          <InlineNotification
            kind="warning"
            title="Authentication Required"
            subtitle="Please authenticate with Storacha above to enable backup and restore functionality"
            style="margin-top: 1rem;"
          />
        {/if}
      </Tile>
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
          and can backup/restore to Storacha while preserving P2P connections.
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
                <Disconnect size={16} style="color:var(--cds-support-error);" />
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
        
        <!-- Database Readiness Indicators -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;padding:1rem;border:1px solid var(--cds-border-subtle);border-radius:4px;background:var(--cds-layer-01);">
          <div style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.25rem;">
              {#if aliceDatabaseReady}
                <Checkmark size={16} style="color:var(--cds-support-success);" />
              {:else}
                <Warning size={16} style="color:var(--cds-support-error);" />
              {/if}
              <span style="font-size:0.875rem;font-weight:500;">Alice DB Ready</span>
            </div>
            <span style="font-size:0.75rem;color:var(--cds-text-secondary);">
              {aliceDatabaseReady ? 'Ready for Replication' : 'Waiting for Connections'}
            </span>
          </div>
          
          <div style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.25rem;">
              {#if bobDatabaseReady}
                <Checkmark size={16} style="color:var(--cds-support-success);" />
              {:else}
                <Warning size={16} style="color:var(--cds-support-error);" />
              {/if}
              <span style="font-size:0.875rem;font-weight:500;">Bob DB Ready</span>
            </div>
            <span style="font-size:0.75rem;color:var(--cds-text-secondary);">
              {bobDatabaseReady ? 'Ready for Replication' : 'Waiting for Connections'}
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
          kind="secondary"
          size="sm"
          icon={showDetails ? ViewOff : View}
          on:click={() => (showDetails = !showDetails)}
        >
          {showDetails ? "Hide Details" : "Show Details"}
        </Button>

        <Button kind="danger" size="sm" icon={Reset} on:click={cleanup}>
          Reset All
        </Button>
      </div>
    </Column>
  </Row>

  <!-- Progress Display -->
  {#if showProgress && (uploadProgress || downloadProgress)}
    <Row>
      <Column>
        <Tile>
          {#if uploadProgress}
            <div style="margin-bottom:1rem;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                  <CloudUpload size={16} />
                  <h5 style="font-size:0.875rem;font-weight:600;margin:0;">Upload Progress</h5>
                </div>
                <span style="font-size:0.875rem;color:var(--cds-text-secondary);"> 
                  {uploadProgress.current}/{uploadProgress.total} ({uploadProgress.percentage}%)
                </span>
              </div>
              
              <div style="width:100%;background-color:var(--cds-layer-accent);border-radius:0.25rem;overflow:hidden;height:0.5rem;">
                <div 
                  style="width:{uploadProgress.percentage}%;background-color:var(--cds-support-info);height:100%;transition:width 0.3s ease;"
                ></div>
              </div>
              
              {#if uploadProgress.currentBlock}
                <div style="margin-top:0.5rem;font-size:0.75rem;color:var(--cds-text-secondary);">
                  Current block: <code>{uploadProgress.currentBlock.hash?.slice(0, 16)}...</code>
                  ({uploadProgress.currentBlock.size} bytes)
                </div>
              {/if}
              
              {#if uploadProgress.error}
                <InlineNotification 
                  kind="error" 
                  title="Upload Error" 
                  subtitle={uploadProgress.error.message} 
                  style="margin-top:0.5rem;"
                />
              {/if}
            </div>
          {/if}
          
          {#if downloadProgress}
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                  <CloudDownload size={16} />
                  <h5 style="font-size:0.875rem;font-weight:600;margin:0;">Download Progress</h5>
                </div>
                <span style="font-size:0.875rem;color:var(--cds-text-secondary);">
                  {downloadProgress.current}/{downloadProgress.total} ({downloadProgress.percentage}%)
                </span>
              </div>
              
              <div style="width:100%;background-color:var(--cds-layer-accent);border-radius:0.25rem;overflow:hidden;height:0.5rem;">
                <div 
                  style="width:{downloadProgress.percentage}%;background-color:var(--cds-support-success);height:100%;transition:width 0.3s ease;"
                ></div>
              </div>
              
              {#if downloadProgress.currentBlock}
                <div style="margin-top:0.5rem;font-size:0.75rem;color:var(--cds-text-secondary);">
                  Current file: <code>{downloadProgress.currentBlock.storachaCID?.slice(0, 16)}...</code>
                  ({downloadProgress.currentBlock.size} bytes)
                </div>
              {/if}
              
              {#if downloadProgress.error}
                <InlineNotification 
                  kind="error" 
                  title="Download Error" 
                  subtitle={downloadProgress.error.message} 
                  style="margin-top:0.5rem;"
                />
              {/if}
            </div>
          {/if}
        </Tile>
      </Column>
    </Row>
  {/if}

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
            <div>
              <span style="font-size:0.875rem;font-weight:500;">Connected Peers:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {aliceConnectedPeers.length}
              </span>
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
            size="sm"
            icon={aliceRunning ? undefined : DataBase}
            on:click={initializeAlice}
            disabled={aliceRunning || aliceOrbitDB || !storachaAuthenticated}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Alice (Creates Shared DB)
          </Button>

          <Button
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
            size="sm"
            kind="tertiary"
            icon={aliceRunning ? undefined : CloudUpload}
            on:click={backupAlice}
            disabled={aliceRunning ||
              aliceTodos.length === 0 ||
              backupResult ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            3. Backup to Storacha
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
            <div style="display:flex;flex-direction:column;gap:0.25rem;">
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
            <div>
              <span style="font-size:0.875rem;font-weight:500;">Connected Peers:</span>
              <span style="font-size:0.875rem;color:var(--cds-text-secondary);margin-left:0.5rem;">
                {bobConnectedPeers.length}
              </span>
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
            size="sm"
            kind="secondary"
            icon={bobRunning ? undefined : DataBase}
            on:click={initializeBob}
            disabled={bobRunning ||
              !sharedDatabaseAddress ||
              bobOrbitDB ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Bob (Connect to Shared DB)
          </Button>

          <Button
            size="sm"
            kind="secondary"
            icon={bobRunning ? undefined : Add}
            on:click={addBobTodo}
            disabled={bobRunning || !bobDatabase}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            2. Add Todo (Test Replication to Alice)
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : CloudDownload}
            on:click={restoreBob}
            disabled={bobRunning ||
              !bobOrbitDB ||
              !backupResult ||
              restoreResult ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            3. Restore from Storacha
          </Button>
        </div>

        <!-- Shared Database Status -->
        {#if !sharedDatabaseAddress}
          <InlineNotification
            kind="info"
            title="Waiting"
            subtitle="Waiting for Alice to create shared database..."
            style="margin-bottom:1rem;"
          />
        {:else}
          <InlineNotification
            kind="success"
            title="Ready"
            subtitle="Shared database available for replication"
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
            <div style="display:flex;flex-direction:column;gap:0.25rem;">
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