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
  } from "lucide-svelte";
  import { createLibp2p } from "libp2p";
  import { createHelia } from "helia";
  import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
  import { webSockets } from "@libp2p/websockets";
  import { webRTC } from "@libp2p/webrtc";
  import { noise } from "@chainsafe/libp2p-noise";
  import { yamux } from "@chainsafe/libp2p-yamux";
  import { identify } from "@libp2p/identify";
  import { gossipsub } from "@chainsafe/libp2p-gossipsub";
  import { all } from "@libp2p/websockets/filters";
  import { createOrbitDB, IPFSAccessController } from "@orbitdb/core";
  import {
    backupDatabase,
    restoreLogEntriesOnly,
    clearStorachaSpace,
    OrbitDBStorachaBridge,
  } from "./orbitdb-storacha-bridge";
  import { logger } from "../lib/logger.js";
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

  // Bob's state (restores data)
  let bobRunning = false;
  let bobOrbitDB = null;
  let bobDatabase = null;
  let bobHelia = null;
  let bobLibp2p = null;
  let bobTodos = [];
  let bobResults = [];
  let bobStep = "";
  let bobError = null;
  let bobUseSameIdentity = true; // Toggle for Bob's identity choice
  let bobIdentity = null; // Bob's own identity if he creates one
  let bobIdentities = null; // Bob's own identities instance

// Shared state
let sharedIdentity = null;
let sharedIdentities = null;
let backupResult = null;
let restoreResult = null;
let showDetails = false;

// Progress tracking state
let uploadProgress = null;
let downloadProgress = null;
let showProgress = false;

  // Generate test data dynamically
  function generateTestTodos(createdBy = "alice") {
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

  let originalTodos = generateTestTodos();

  // Keep track of database addresses
  let storachaTestDatabaseAddresses = new Set();

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
        logger.warn({ error: error.message }, 'Could not get current space DID');
      }
    } else {
      throw new Error(
        `Bridge with ${credentials.method} authentication not yet implemented`,
      );
    }
    
    const bridge = new OrbitDBStorachaBridge(bridgeOptions);
    
    // Set up progress event listeners
    bridge.on('uploadProgress', (progress) => {
      logger.info({ progress }, '📤 Upload Progress:');
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
        logger.warn({ progress }, 'Invalid upload progress data');
      }
    });
    
    bridge.on('downloadProgress', (progress) => {
      logger.info({ progress }, '📥 Download Progress:');
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
        logger.warn({ progress }, 'Invalid download progress data');
      }
    });
    
    return bridge;
  }

  // Handle Storacha authentication events
  function handleStorachaAuthenticated(event) {
    logger.info({ detail: event.detail }, "🔐 Storacha authenticated:");
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
      logger.info(
        "📝 Credentials-based authentication - storing for backup operations"
      );
    } else if (
      event.detail.method === "ucan" ||
      event.detail.method === "seed"
    ) {
      logger.info(
        { method: event.detail.method },
        `📝 ${event.detail.method}-based authentication - ready for operations`
      );
    }
  }

  function handleStorachaLogout() {
    logger.info("🚪 Storacha logged out");
    storachaAuthenticated = false;
    storachaClient = null;
    storachaCredentials = null;
  }

  function handleSpaceChanged(event) {
    logger.info({ space: event.detail.space }, "🔄 Storacha space changed:");
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
    logger.info({ persona }, `🆔 Creating ${persona} identity...`);

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

    logger.info({ persona, identityId: identity.id }, `✅ ${persona} identity created: ${identity.id}`);
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
    logger.info({ persona, step, status, message, data }, `🧪 ${persona}: ${step} - ${status} - ${message}`);
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

  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    useSharedIdentity = true,
  ) {
    logger.info({ persona }, `🔧 Creating OrbitDB instance for ${persona}...`);

    // Use minimal libp2p config to avoid relay connections
    const config = DefaultLibp2pBrowserOptions;

    // Create libp2p instance
    const libp2p = await createLibp2p(config);
    logger.info("libp2p created");

    // Create Helia instance with memory storage for tests to avoid persistence conflicts
    logger.info("🗄️ Initializing Helia with memory storage for testing...");
    // Use memory storage to avoid filesystem conflicts and faster cleanup
    const helia = await createHelia({ libp2p });
    logger.info("Helia created with memory storage");

    // Create OrbitDB instance with unique ID and memory storage
    const orbitdbConfig = {
      ipfs: helia,
      id: `${persona}-${instanceId}-${Date.now()}-${Math.random()}`,
      directory: `./orbitdb-${persona}-${instanceId}`,
    };

    // Choose identity based on persona and settings
    if (persona === "alice" && sharedIdentity && sharedIdentities) {
      orbitdbConfig.identity = sharedIdentity;
      orbitdbConfig.identities = sharedIdentities;
    } else if (persona === "bob") {
      if (useSharedIdentity && sharedIdentity && sharedIdentities) {
        orbitdbConfig.identity = sharedIdentity;
        orbitdbConfig.identities = sharedIdentities;
        logger.info(
          { identityId: sharedIdentity.id },
          `🔗 Bob using Alice's shared identity: ${sharedIdentity.id}`
        );
      } else if (bobIdentity && bobIdentities) {
        orbitdbConfig.identity = bobIdentity;
        orbitdbConfig.identities = bobIdentities;
        logger.info({ identityId: bobIdentity.id }, `🆔 Bob using his own identity: ${bobIdentity.id}`);
      }
    }

    const orbitdb = await createOrbitDB(orbitdbConfig);
    logger.info({ orbitdbId: orbitdb.id }, "orbitdb created");

    // Create database with access controller (like working integration test)
    const database = await orbitdb.open(databaseName, databaseConfig);
    logger.info({ databaseAddress: database.address }, "database created");

    // Set up event listeners for this database
    setupDatabaseEventListeners(database, persona);

    return { libp2p, helia, orbitdb, database };
  }

  // Add this new function to set up event listeners for StorachaTest databases only
  function setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    logger.info({ persona }, `🎧 Setting up event listeners for ${persona}'s database...`);
    logger.info({ databaseAddress: database.address }, `🎯 [StorachaTest] Database address: ${database.address}`);

    // Add this database address to our tracking set
    storachaTestDatabaseAddresses.add(
      database.address?.toString() || database.address,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any StorachaTest database
      const eventAddress = address?.toString() || address;

      if (storachaTestDatabaseAddresses.has(eventAddress)) {
        logger.info({
          persona,
          address: eventAddress,
          entry: {
            hash: entry?.hash?.toString() || entry?.hash,
            payload: entry?.payload,
            key: entry?.key,
            value: entry?.value,
          },
          heads: heads?.map((h) => h?.toString()) || heads,
          timestamp: new Date().toISOString(),
        }, `🔗 [StorachaTest-${persona}] JOIN EVENT:`);

        // Add to test results if test is running
        if (persona === "alice") {
          addResult(
            "alice",
            "Join Event",
            "success",
            `New entry joined: ${entry?.key || "unknown key"}`,
            {
              address: eventAddress,
              entryHash: entry?.hash?.toString() || entry?.hash,
              entryKey: entry?.key,
              entryValue: entry?.value,
            },
          );
        } else if (persona === "bob") {
          addResult(
            "bob",
            "Join Event",
            "success",
            `New entry joined: ${entry?.key || "unknown key"}`,
            {
              address: eventAddress,
              entryHash: entry?.hash?.toString() || entry?.hash,
              entryKey: entry?.key,
              entryValue: entry?.value,
            },
          );
        }
      }
    });

    // Listen for entries being updated (update event)
    database.events.on("update", async (address, entry, heads) => {
      // Check if this event is for any StorachaTest database
      const eventAddress = address?.toString() || address;

      if (storachaTestDatabaseAddresses.has(eventAddress)) {
        logger.info({
          persona,
          address: eventAddress,
          entry: {
            hash: entry?.hash?.toString() || entry?.hash,
            payload: entry?.payload,
            key: entry?.key,
            value: entry?.value,
          },
          heads: heads?.map((h) => h?.toString()) || heads,
          timestamp: new Date().toISOString(),
        }, `🔄 [StorachaTest-${persona}] UPDATE EVENT:`);

        // Add to test results if test is running
        if (persona === "alice") {
          addResult(
            "alice",
            "Update Event",
            "success",
            `Entry updated: ${entry?.key || "unknown key"}`,
            {
              address: eventAddress,
              entryHash: entry?.hash?.toString() || entry?.hash,
              entryKey: entry?.key,
              entryValue: entry?.value,
            },
          );
        } else if (persona === "bob") {
          addResult(
            "bob",
            "Update Event",
            "success",
            `Entry updated: ${entry?.key || "unknown key"}`,
            {
              address: eventAddress,
              entryHash: entry?.hash?.toString() || entry?.hash,
              entryKey: entry?.key,
              entryValue: entry?.value,
            },
          );
        }
      }
    });

    logger.info(
      { persona },
      `✅ [StorachaTest] Event listeners set up for database instance ${persona}`
    );
  }

  async function clearIndexedDB() {

    // Get all IndexedDB databases
    if ("databases" in indexedDB) {
      const databases = await indexedDB.databases();
      logger.info(
        { databases: databases.map((db) => db.name) },
        "📋 Found databases:"
      );

      // Delete databases that look like OrbitDB/Helia related
      const dbsToDelete = databases.filter(
        (db) =>
          db.name.includes("helia") ||
          db.name.includes("orbit") ||
          db.name.includes("level") ||
          db.name.includes("simple-todo") ||
          db.name.includes("storacha-test") ||
          db.name.includes("alice") ||
          db.name.includes("bob"),
      );

      for (const db of dbsToDelete) {
        try {
          logger.info({ dbName: db.name }, `🗑️ Deleting database: ${db.name}`);

          // Add timeout to prevent hanging
          await Promise.race([
            new Promise((resolve, reject) => {
              const deleteReq = indexedDB.deleteDatabase(db.name);
              deleteReq.onsuccess = () => resolve();
              deleteReq.onerror = () => reject(deleteReq.error);
              deleteReq.onblocked = () => {
                logger.warn({ dbName: db.name }, `⚠️ Database deletion blocked for: ${db.name}`);
                // Don't reject immediately, give it more time
              };
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 5000),
            ),
          ]);

          logger.info({ dbName: db.name }, `✅ Deleted database: ${db.name}`);
        } catch (error) {
          if (error.message === "Timeout") {
            logger.warn({ dbName: db.name }, `⏱️ Timeout deleting database ${db.name} - skipping`);
          } else {
            logger.warn({ dbName: db.name, error: error.message }, `⚠️ Failed to delete database ${db.name}`);
          }
        }
      }
    }

    logger.info("🧹 IndexedDB cleanup completed");
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
          "Creating shared identity...",
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
        "Setting up Alice's OrbitDB instance...",
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      const instance = await createOrbitDBInstance(
        "alice",
        "instance",
        "shared-todos",
        databaseConfig,
        true,
      );
      aliceOrbitDB = instance.orbitdb;
      aliceDatabase = instance.database;
      aliceHelia = instance.helia;
      aliceLibp2p = instance.libp2p;

      updateLastResult("alice", "success", `Alice's OrbitDB instance ready`, {
        orbitDBId: aliceOrbitDB.id,
        identityId: aliceOrbitDB.identity.id,
        databaseAddress: aliceDatabase.address,
      });

      aliceStep = "Alice ready to add todos";
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "❌ Alice initialization failed:");
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
    aliceStep = "Adding todos...";

    try {
      addResult(
        "alice",
        "Adding Todos",
        "running",
        "Adding test todos to database...",
      );

      for (let i = 0; i < originalTodos.length; i++) {
        const todo = originalTodos[i];
        await aliceDatabase.put(todo.id, todo);
        logger.info({ index: i + 1, todo }, `✅ Alice added todo ${i + 1}:`);
      }

      // Get all todos to verify and display
      aliceTodos = await aliceDatabase.all();

      updateLastResult(
        "alice",
        "success",
        `Successfully added ${aliceTodos.length} todos`,
        {
          todosAdded: aliceTodos.map((t) => ({
            key: t.key,
            text: t.value.text,
            completed: t.value.completed,
          })),
        },
      );

      aliceStep = "Alice ready to backup";
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "❌ Adding todos failed:");
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
    aliceStep = "Creating backup...";

    try {
      addResult("alice", "Backup", "running", "Creating backup to Storacha...");

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
        `Backup created successfully with ${backupResult.blocksUploaded}/${backupResult.blocksTotal} blocks`,
        {
          manifestCID: backupResult.manifestCID,
          databaseAddress: backupResult.databaseAddress,
          blocksTotal: backupResult.blocksTotal,
          blocksUploaded: backupResult.blocksUploaded,
        },
      );

      aliceStep = "Alice backup complete - Bob can now restore";
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "❌ Backup failed:");
      aliceError = error.message;
      aliceStep = `Backup failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  // Bob's functions
  async function initializeBob() {
    if (bobRunning || !backupResult) return;

    // Check Storacha authentication first
    if (!storachaAuthenticated || !storachaClient) {
      addResult(
        "bob",
        "Error",
        "error",
        "Please authenticate with Storacha first",
      );
      return;
    }

    bobRunning = true;
    bobError = null;
    bobResults = [];
    bobStep = "Initializing Bob...";

    try {
      if (!sharedIdentity && bobUseSameIdentity) {
        throw new Error(
          "Shared identity not available. Alice must initialize first.",
        );
      }

      // Create Bob's own identity if needed
      if (!bobUseSameIdentity && !bobIdentity) {
        addResult(
          "bob",
          "Identity",
          "running",
          "Creating Bob's own identity...",
        );
        const identityResult = await createReusableIdentity("bob");
        bobIdentity = identityResult.identity;
        bobIdentities = identityResult.identities;
        updateLastResult(
          "bob",
          "success",
          `Bob's identity created: ${bobIdentity.id}`,
          {
            identityId: bobIdentity.id,
            identityType: bobIdentity.type,
          },
        );
      }

      addResult(
        "bob",
        "Setup",
        "running",
        `Setting up Bob's OrbitDB instance with ${bobUseSameIdentity ? "shared" : "own"} identity...`,
      );

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ write: ["*"] }),
      };

      const instance = await createOrbitDBInstance(
        "bob",
        "instance",
        "shared-todos",
        databaseConfig,
        bobUseSameIdentity,
      );
      bobOrbitDB = instance.orbitdb;
      bobDatabase = instance.database;
      bobHelia = instance.helia;
      bobLibp2p = instance.libp2p;

      const identityUsed = bobUseSameIdentity ? sharedIdentity : bobIdentity;
      updateLastResult(
        "bob",
        "success",
        `Bob's OrbitDB instance ready with ${bobUseSameIdentity ? "shared" : "own"} identity`,
        {
          orbitDBId: bobOrbitDB.id,
          identityId: bobOrbitDB.identity.id,
          databaseAddress: bobDatabase.address,
          usingSameIdentity: bobUseSameIdentity,
          identityMatches:
            bobOrbitDB.identity.id === (sharedIdentity?.id || "none"),
        },
      );

      bobStep = "Bob ready to restore";
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "❌ Bob initialization failed:");
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
    bobStep = "Restoring from backup...";

    try {
      const identityInfo = bobUseSameIdentity
        ? "same identity as Alice"
        : "his own identity";
      addResult(
        "bob",
        "Restore",
        "running",
        `Restoring database from Storacha backup using ${identityInfo}...`,
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
          dbName: "shared-todos",
          dbConfig: databaseConfig,
          timeout: 120000,
        },
      );

      if (!restoreResult.success) {
        throw new Error(`Restore failed: ${restoreResult.error}`);
      }

      // Get restored todos
      const restoredDatabase = restoreResult.database;

      // Add restored database to tracking
      if (restoredDatabase && restoredDatabase.address) {
        storachaTestDatabaseAddresses.add(
          restoredDatabase.address?.toString() || restoredDatabase.address,
        );
      }

      // Wait for indexing
      await new Promise((resolve) => setTimeout(resolve, 5000));
      bobTodos = await restoredDatabase.all();

      const optimizationInfo = restoreResult.optimizationSavings
        ? `(${restoreResult.optimizationSavings.percentageSaved}% fewer downloads)`
        : "";

      updateLastResult(
        "bob",
        "success",
        `Database restored successfully with ${restoreResult.entriesRecovered} entries using ${identityInfo} ${optimizationInfo}`,
        {
          manifestCID: restoreResult.manifestCID,
          databaseAddress: restoreResult.address,
          entriesRecovered: restoreResult.entriesRecovered,
          todosRestored: bobTodos.map((t) => ({
            key: t.key,
            text: t.value.text,
            completed: t.value.completed,
          })),
          usingSameIdentity: bobUseSameIdentity,
          identityUsed: bobOrbitDB.identity.id,
        },
      );

      bobStep = "Bob restore complete";
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "❌ Restore failed:");
      bobError = error.message;
      bobStep = `Restore failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  // Cleanup functions
  async function cleanup() {
    logger.info("🧹 Cleaning up all instances...");

    // Cleanup Alice
    try {
      if (aliceDatabase) await aliceDatabase.close();
      if (aliceOrbitDB) await aliceOrbitDB.stop();
      if (aliceHelia) await aliceHelia.stop();
      if (aliceLibp2p) await aliceLibp2p.stop();
    } catch (error) {
      logger.warn({ error: error.message }, "⚠️ Alice cleanup error:");
    }

    // Cleanup Bob
    try {
      if (bobDatabase) await bobDatabase.close();
      if (bobOrbitDB) await bobOrbitDB.stop();
      if (bobHelia) await bobHelia.stop();
      if (bobLibp2p) await bobLibp2p.stop();
    } catch (error) {
      logger.warn({ error: error.message }, "⚠️ Bob cleanup error:");
    }

    await clearIndexedDB();

    // Reset state
    aliceOrbitDB = null;
    aliceDatabase = null;
    aliceHelia = null;
    aliceLibp2p = null;
    aliceTodos = [];
    aliceResults = [];
    aliceStep = "";
    aliceError = null;

    bobOrbitDB = null;
    bobDatabase = null;
    bobHelia = null;
    bobLibp2p = null;
    bobTodos = [];
    bobResults = [];
    bobStep = "";
    bobError = null;
    bobUseSameIdentity = true;
    bobIdentity = null;
    bobIdentities = null;

    sharedIdentity = null;
    sharedIdentities = null;
    backupResult = null;
    restoreResult = null;
    storachaTestDatabaseAddresses.clear();
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

  /**
   * A basic Libp2p configuration for browser nodes.
   */
  const DefaultLibp2pBrowserOptions = {
    addresses: {
      listen: ["/webrtc", "/p2p-circuit"],
    },
    transports: [
      webSockets({
        filter: all,
      }),
      webRTC(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: () => false,
    },
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  };
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
            Alice & Bob Backup/Restore Demo
          </h3>
        </div>
        <p style="color:var(--cds-text-secondary);margin:0;">
          Alice creates todos and backs them up to Storacha. Bob restores the
          data from the backup using either the same identity or his own.
        </p>
      </div>
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
                  title={uploadProgress.error.type === 'ucan' ? 'UCAN Authorization Error' : 'Upload Error'} 
                  subtitle={uploadProgress.error.message} 
                  style="margin-top:0.5rem;"
                >
                  {#if uploadProgress.error.type === 'ucan' && uploadProgress.error.details}
                    <div style="margin-top:0.5rem;font-size:0.75rem;color:var(--cds-text-secondary);">
                      <details>
                        <summary>Technical Details</summary>
                        <pre style="white-space:pre-wrap;margin-top:0.5rem;">{uploadProgress.error.details}</pre>
                      </details>
                    </div>
                  {/if}
                </InlineNotification>
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
            Alice (Data Creator)
          </h4>
        </div>

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
            1. Initialize Alice
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
            2. Add Todos
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
            Bob (Data Restorer)
          </h4>
        </div>

        <!-- Bob's Identity Toggle -->
        <Tile style="margin-bottom:1rem;">
          <div
            style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;"
          >
            <span style="font-size:0.875rem;font-weight:500;"
              >Identity Choice:</span
            >
            <Toggle
              size="sm"
              labelText=""
              toggled={bobUseSameIdentity}
              on:toggle={() => (bobUseSameIdentity = !bobUseSameIdentity)}
              disabled={bobRunning || bobOrbitDB}
            >
              {bobUseSameIdentity ? "Same as Alice" : "Own Identity"}
            </Toggle>
          </div>
          <p
            style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;"
          >
            {#if bobUseSameIdentity}
              🔗 Bob will use Alice's shared identity (DID) - typical for same
              user restoring data
            {:else}
              🆔 Bob will create his own identity (DID) - demonstrates
              cross-identity data sharing
            {/if}
          </p>
        </Tile>

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
              !backupResult ||
              bobOrbitDB ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Bob
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : CloudDownload}
            on:click={restoreBob}
            disabled={bobRunning ||
              !bobOrbitDB ||
              restoreResult ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            2. Restore from Storacha
          </Button>
        </div>

        <!-- Backup Status Indicator -->
        {#if !backupResult}
          <InlineNotification
            kind="info"
            title="Waiting"
            subtitle="Waiting for Alice to create backup..."
            style="margin-bottom:1rem;"
          />
        {:else}
          <InlineNotification
            kind="success"
            title="Ready"
            subtitle="Backup available from Alice"
            style="margin-bottom:1rem;"
          />
        {/if}

        <!-- Bob's Restored Todos -->
        {#if bobTodos.length > 0}
          <div style="margin-bottom:1rem;">
            <h5
              style="font-size:0.875rem;font-weight:500;margin-bottom:0.5rem;"
            >
              Bob's Restored Todos:
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
                    ✨ restored
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
              📊 {bobTodos.length} restored todos • {bobResults.length} progress items
              {#if bobTodos.length > 0}
                • Identity: {bobUseSameIdentity ? "🔗 Same as Alice" : "🆔 Own Identity"}
              {/if}
            </p>
          </div>
        {/if}
      </Tile>
    </Column>
  </Row>

  <!-- Success Summary -->
  {#if aliceTodos.length > 0 && bobTodos.length > 0 && aliceTodos.length === bobTodos.length}
    <Row>
      <Column>
        <InlineNotification
          kind="success"
          title="Success! Data Successfully Transferred ✅"
          subtitle={`Alice created ${aliceTodos.length} todos and backed them up to Storacha. Bob successfully restored all ${bobTodos.length} todos from the backup using ${bobUseSameIdentity ? "the same identity" : "his own identity"}!`}
          style="margin-top:2rem;"
        >
          {#if backupResult && restoreResult}
            <p style="font-size:0.75rem;margin-top:0.5rem;">
              Backup: {backupResult.blocksUploaded}/{backupResult.blocksTotal} blocks
              • Restore: {restoreResult.entriesRecovered} entries recovered • Identity:
              {bobUseSameIdentity
                ? "Shared (Same DID)"
                : "Separate (Different DID)"}
            </p>
          {/if}
        </InlineNotification>
      </Column>
    </Row>
  {/if}

</Grid>