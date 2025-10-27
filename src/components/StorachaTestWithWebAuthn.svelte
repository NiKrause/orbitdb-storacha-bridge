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
    Fingerprint,
    Shield,
    Key,
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
  import { Identities, useIdentityProvider } from "@orbitdb/core";
  import OrbitDBIdentityProviderDID from "@orbitdb/identity-provider-did";
  import { Ed25519Provider } from "key-did-provider-ed25519";
  import * as KeyDIDResolver from "key-did-resolver";
  import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
  import { wordlist as english } from "@scure/bip39/wordlists/english";
  import { createHash } from "crypto";

  // Import WebAuthn DID Provider
  import {
    WebAuthnDIDProvider,
    OrbitDBWebAuthnIdentityProvider,
    OrbitDBWebAuthnIdentityProviderFunction,
    registerWebAuthnProvider,
    checkWebAuthnSupport,
  } from "./WebAuthnDIDProvider.js";

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
    RadioButton,
    RadioButtonGroup,
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

  // WebAuthn support state
  let webAuthnSupported = false;
  let webAuthnPlatformAvailable = false;
  let webAuthnSupportMessage = "";
  let webAuthnChecking = true;

  // Identity creation method
  let identityMethod = "webauthn"; // "mnemonic" or "webauthn"

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
  let sharedWebAuthnCredential = null; // For WebAuthn-based identity
  let backupResult = null;
  let restoreResult = null;
  let showDetails = false;

  // Progress tracking state
  let uploadProgress = null;
  let downloadProgress = null;
  let showProgress = false;

  // Test data
  let originalTodos = [
    {
      id: "test_todo_1",
      text: "Buy groceries for the week",
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy: "alice",
    },
    {
      id: "test_todo_2",
      text: "Walk the dog in the park",
      completed: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      createdBy: "alice",
    },
    {
      id: "test_todo_3",
      text: "Finish the OrbitDB project",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      createdBy: "alice",
    },
  ];

  // Keep track of database addresses
  let storachaTestDatabaseAddresses = new Set();

  // Check WebAuthn support on component initialization
  async function initializeWebAuthnSupport() {
    try {
      const support = await checkWebAuthnSupport();
      webAuthnSupported = support.supported;
      webAuthnPlatformAvailable = support.platformAuthenticator;
      webAuthnSupportMessage = support.message;

      // WebAuthn provider will be registered when needed (not automatically)
      console.log('WebAuthn support detected, provider will be registered when creating identity');
    } catch (error) {
      console.error("WebAuthn support check failed:", error);
      webAuthnSupportMessage = "Unable to check WebAuthn support";
    } finally {
      webAuthnChecking = false;
    }
  }

  // Initialize on component mount
  initializeWebAuthnSupport();

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
        console.warn("Could not get current space DID:", error.message);
      }
    } else {
      throw new Error(
        `Bridge with ${credentials.method} authentication not yet implemented`,
      );
    }

    const bridge = new OrbitDBStorachaBridge(bridgeOptions);

    // Set up progress event listeners
    bridge.on("uploadProgress", (progress) => {
      console.log("📤 Upload Progress:", progress);
      if (progress && typeof progress === "object") {
        uploadProgress = progress;
        showProgress = true;

        // Update Alice step for upload progress
        if (progress.status === "starting") {
          aliceStep = `Starting backup: ${progress.total} blocks to upload`;
        } else if (progress.status === "uploading") {
          aliceStep = `Uploading: ${progress.current}/${progress.total} blocks (${progress.percentage}%)`;
        } else if (progress.status === "completed") {
          aliceStep = `Upload completed: ${progress.summary?.successful || 0} successful, ${progress.summary?.failed || 0} failed`;
          showProgress = false;
        }
      } else {
        console.warn("Invalid upload progress data:", progress);
      }
    });

    bridge.on("downloadProgress", (progress) => {
      console.log("📥 Download Progress:", progress);
      if (progress && typeof progress === "object") {
        downloadProgress = progress;
        showProgress = true;

        // Update Bob step for download progress
        if (progress.status === "starting") {
          bobStep = `Starting restore: ${progress.total} files to download`;
        } else if (progress.status === "downloading") {
          bobStep = `Downloading: ${progress.current}/${progress.total} files (${progress.percentage}%)`;
        } else if (progress.status === "completed") {
          bobStep = `Download completed: ${progress.summary?.downloaded || 0} downloaded, ${progress.summary?.failed || 0} failed`;
          showProgress = false;
        }
      } else {
        console.warn("Invalid download progress data:", progress);
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
   * Create a reusable OrbitDB identity from seed (mnemonic-based)
   */
  async function createMnemonicIdentity(persona = "shared") {
    console.log(`🆔 Creating ${persona} identity from mnemonic...`);

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

    console.log(`✅ ${persona} mnemonic identity created: ${identity.id}`);
    return { identity, identities, seedPhrase, masterSeed };
  }

  /**
   * Create a reusable OrbitDB identity using WebAuthn
   */
  async function createWebAuthnIdentity(persona = "shared") {
    console.log(`🆔 Creating ${persona} identity with WebAuthn...`);

    if (!webAuthnSupported) {
      throw new Error("WebAuthn is not supported in this browser");
    }

    // Create WebAuthn credential
    const webauthnCredential = await WebAuthnDIDProvider.createCredential({
      userId: `${persona}@orbitdb.org`,
      displayName: `OrbitDB ${persona} Identity`,
    });

    // Register the WebAuthn provider (like DID provider does)
    useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);

    // Create OrbitDB identities instance with default keystore
    // The WebAuthn provider will handle signing internally
    const identities = await Identities();

    // FIXED: Use OrbitDB's built-in identity creation instead of plain object
    // This ensures proper identity resolution and verification in access controller
    
    // Ensure the WebAuthn provider is registered with OrbitDB
    console.log('🔧 Registering WebAuthn identity provider with OrbitDB...');
    const registrationSuccess = registerWebAuthnProvider();
    if (!registrationSuccess) {
      throw new Error('Failed to register WebAuthn provider with OrbitDB');
    }
    
    // Create the identity using OrbitDB's standard identity creation
    // This ensures proper serialization, resolution via getIdentity(), and verification
    console.log('🆔 Creating WebAuthn identity via OrbitDB identities.createIdentity...');
    const identity = await identities.createIdentity({
      provider: OrbitDBWebAuthnIdentityProviderFunction({ webauthnCredential })
    });
    
    console.log('✅ Created OrbitDB-compatible WebAuthn identity:', {
      id: identity.id,
      type: identity.type,
      publicKey: identity.publicKey,
      hasSign: typeof identity.sign === 'function',
      hasVerify: typeof identity.verify === 'function',
      hasHash: !!identity.hash
    });
    
    // Verify the identity can be resolved by the identities system
    // Testing identity resolution
    const resolvedIdentity = await identities.getIdentity(identity.id);
    if (resolvedIdentity) {
      console.log('✅ Identity resolution test passed - access controller should work');
    } else {
      console.warn('⚠️ Identity resolution test failed - this may cause access control issues');
    }
    
    // Test identity verification
    // Testing identity verification
    try {
      const verificationResult = await identities.verifyIdentity(identity);
      if (verificationResult) {
        console.log('✅ Identity verification test passed');
      } else {
        console.warn('⚠️ Identity verification test failed');
      }
    } catch (verifyError) {
      console.warn('⚠️ Identity verification test error:', verifyError.message);
    }

    console.log(`✅ ${persona} WebAuthn identity created: ${identity.id}`);
    return { identity, identities, webauthnCredential };
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

  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    useSharedIdentity = true,
  ) {
    console.log(`🔧 Creating OrbitDB instance for ${persona}...`);

    // Use minimal libp2p config to avoid relay connections
    const config = DefaultLibp2pBrowserOptions;

    // Create libp2p instance
    const libp2p = await createLibp2p(config);
    console.log("libp2p created");

    // Create Helia instance with memory storage for tests to avoid persistence conflicts
    console.log("🗄️ Initializing Helia with memory storage for testing...");
    // Use memory storage to avoid filesystem conflicts and faster cleanup
    const helia = await createHelia({ libp2p });
    console.log("Helia created with memory storage");

    // Create OrbitDB instance configuration
    const orbitdbConfig = {
      ipfs: helia,
      directory: `./orbitdb-${persona}-${instanceId}`,
    };

    // Choose identity based on persona and settings (CRITICAL: don't mix id with identity!)
    if (persona === "alice" && sharedIdentity && sharedIdentities) {
      // Use WebAuthn identity - pass identities instance and specific identity
      orbitdbConfig.identities = sharedIdentities;
      orbitdbConfig.identity = sharedIdentity;
      console.log(`🔑 Alice using WebAuthn identity: ${sharedIdentity.id}`);
    } else if (persona === "bob") {
      if (useSharedIdentity && sharedIdentity && sharedIdentities) {
        // Bob shares Alice's WebAuthn identity
        orbitdbConfig.identities = sharedIdentities;
        orbitdbConfig.identity = sharedIdentity;
        console.log(`🔗 Bob using Alice's shared WebAuthn identity: ${sharedIdentity.id}`);
      } else if (bobIdentity && bobIdentities) {
        // Bob has his own identity
        orbitdbConfig.identities = bobIdentities;
        orbitdbConfig.identity = bobIdentity;
        console.log(`🆔 Bob using his own identity: ${bobIdentity.id}`);
      } else {
        // Fallback: let OrbitDB create default identity with unique ID
        orbitdbConfig.id = `${persona}-${instanceId}-${Date.now()}-${Math.random()}`;
        console.log(`⚠️ ${persona} using default OrbitDB identity`);
      }
    } else {
      // Fallback: let OrbitDB create default identity with unique ID
      orbitdbConfig.id = `${persona}-${instanceId}-${Date.now()}-${Math.random()}`;
      console.log(`⚠️ ${persona} using default OrbitDB identity`);
    }

    console.log('🔧 OrbitDB config about to be used:', {
      hasIPFS: !!orbitdbConfig.ipfs,
      hasIdentity: !!orbitdbConfig.identity,
      hasIdentities: !!orbitdbConfig.identities,
      hasId: !!orbitdbConfig.id,
      identityId: orbitdbConfig.identity?.id,
      identityType: orbitdbConfig.identity?.type,
      directory: orbitdbConfig.directory
    });
    
    const orbitdb = await createOrbitDB(orbitdbConfig);
    
    console.log('🆔 OrbitDB instance created:', {
      orbitDBId: orbitdb.id,
      actualIdentityId: orbitdb.identity?.id,
      actualIdentityType: orbitdb.identity?.type,
      actualIdentityHash: orbitdb.identity?.hash,
      identityMatch: orbitdb.identity?.id === orbitdbConfig.identity?.id ? '✅ MATCH' : '❌ DIFFERENT',
      hasSignMethod: typeof orbitdb.identity?.sign === 'function',
      hasVerifyMethod: typeof orbitdb.identity?.verify === 'function',
      signMethodString: orbitdb.identity?.sign?.toString().slice(0, 100) + '...'
    });
    
    console.log("📂 OrbitDB instance created with WebAuthn identity");

    // Create database with access controller
    const database = await orbitdb.open(databaseName, databaseConfig);
    console.log("📊 Database created:", database.name);

    // Set up event listeners for this database
    setupDatabaseEventListeners(database, persona);

    return { libp2p, helia, orbitdb, database };
  }

  // Add this new function to set up event listeners for StorachaTest databases only
  function setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    console.log(`🎧 Setting up event listeners for ${persona}'s database...`);
    console.log(`🎯 [StorachaTest] Database address: ${database.address}`);

    // Add this database address to our tracking set
    storachaTestDatabaseAddresses.add(
      database.address?.toString() || database.address,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any StorachaTest database
      const eventAddress = address?.toString() || address;

      if (storachaTestDatabaseAddresses.has(eventAddress)) {
        console.log(`🔗 [StorachaTest-${persona}] JOIN EVENT:`, {
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
        console.log(`🔄 [StorachaTest-${persona}] UPDATE EVENT:`, {
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

    console.log(
      `✅ [StorachaTest] Event listeners set up for database instance ${persona}`,
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
          db.name.includes("simple-todo") ||
          db.name.includes("storacha-test") ||
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
          `Creating shared identity using ${identityMethod}...`,
        );

        let identityResult;
        if (identityMethod === "webauthn") {
          identityResult = await createWebAuthnIdentity("shared");
          sharedWebAuthnCredential = identityResult.webauthnCredential;
        } else {
          identityResult = await createMnemonicIdentity("shared");
        }

        sharedIdentity = identityResult.identity;
        sharedIdentities = identityResult.identities;

        updateLastResult(
          "alice",
          "success",
          `Shared identity created (${identityMethod}): ${sharedIdentity.id}`,
        );
      }

      // Create Alice's OrbitDB instance
      addResult(
        "alice",
        "Setup",
        "running",
        "Setting up Alice's OrbitDB instance...",
      );

      // 🔐 ACCESS CONTROLLER CONFIGURATION
      console.log('\n🔐 Configuring Access Controller for Alice:');
      console.log('   🆔 WebAuthn Identity ID:', sharedIdentity.id);
      console.log('   🏷️ Identity Type:', sharedIdentity.type);
      console.log('   🔑 Identity Key (for access):', sharedIdentity.key?.slice(0, 32) + '...' || 'NO KEY');
      
      const writePermissions = [sharedIdentity.id];
      console.log('   ✍️ Write Permissions Array:', writePermissions);
      console.log('   🌟 Using Wildcard (*)?', writePermissions.includes('*') ? 'YES' : 'NO');
      console.log('   🔒 Access Control Type: EXPLICIT IDENTITY-BASED');
      
      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // FIXED: Use explicit identity-based access control instead of wildcard
        // This ensures the WebAuthn identity is properly validated
        accessController: IPFSAccessController({ 
          write: writePermissions // Use the actual WebAuthn identity ID
        }),
      };
      
      console.log('   ⚙️ Final Database Config:', {
        type: databaseConfig.type,
        accessControllerType: 'IPFSAccessController',
        writePermissions: writePermissions
      });

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
        identityType: sharedIdentity.type || identityMethod,
        databaseAddress: aliceDatabase.address,
      });

      aliceStep = "Alice ready to add todos";
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
        
        console.log(`📝 Adding todo ${i + 1}: ${todo.text}`);
        
        const hash = await aliceDatabase.put(todo.id, todo);
        
        console.log(`✅ Todo ${i + 1} added with hash: ${hash.slice(0, 16)}...`);
        
        // Verify the identity of the newly added entry
        const entry = await aliceDatabase.log.get(hash);
        if (entry) {
          // Check both DID and hash matches (OrbitDB may convert DID to hash for oplog)
          const didMatch = entry.identity === aliceOrbitDB.identity.id;
          const hashMatch = entry.identity === aliceOrbitDB.identity.hash;
          const isMatch = didMatch || hashMatch;
          
          console.log(`🔐 Entry ${i + 1}: ${entry.identity.slice(0, 32)}... vs ${aliceOrbitDB.identity.id.slice(0, 32)}... = ${isMatch ? '✅' : '❌'} | Sig: ${entry.sig ? '✅' : '❌'}`);
        }
      }

      // Get all todos to verify and display
      aliceTodos = await aliceDatabase.all();

      // 🔍 ITERATE OVER THE ENTIRE OPLOG HISTORY
      console.log('\n🗂️ =============== COMPLETE OPLOG HISTORY ===============');
      console.log('📊 Database:', aliceDatabase.name);
      console.log('📍 Address:', aliceDatabase.address);
      console.log('🆔 Database Identity:', aliceDatabase.identity?.id);
      console.log('📝 Total Todos Added:', aliceTodos.length);
      
      try {
        console.log('\n🔄 Iterating through oplog entries...');
        
        // Get the oplog from the database
        const oplog = aliceDatabase.log;
        console.log('📋 Oplog basic info:', {
          hasIterator: typeof oplog.iterator === 'function',
          length: oplog.length || 'unknown'
        });
        
        // Method 1: Use the correct OrbitDB API - log.iterator() 
        let entryCount = 0;
        if (typeof oplog.iterator === 'function') {
          console.log('\n📖 Using log.iterator() to traverse ALL entries:');
          
          try {
            for await (const entry of oplog.iterator()) {
              entryCount++;
              console.log(`\n📄 Entry #${entryCount}:`);
              console.log('   🔗 Hash:', entry.hash?.toString() || entry.hash);
              console.log('   🆔 Identity:', entry.identity);
              console.log('   🔑 Key:', entry.key || entry.payload?.key);
              console.log('   📋 Operation:', entry.payload?.op);
              console.log('   💾 Value Preview:', JSON.stringify(entry.payload?.value || entry.value)?.slice(0, 100) + '...');
              console.log('   🔐 Signature:', entry.sig ? `${entry.sig.slice(0, 32)}... (${entry.sig.length} chars)` : 'NO SIGNATURE');
              console.log('   ⏰ Clock:', entry.clock ? `{id: ${entry.clock.id?.slice(0, 16)}..., time: ${entry.clock.time}}` : 'NO CLOCK');
              
              // Handle next and refs arrays safely
              const nextRefs = Array.isArray(entry.next) ? entry.next.map(n => n.toString().slice(0, 16) + '...') : (entry.next ? [entry.next.toString().slice(0, 16) + '...'] : []);
              const refs = Array.isArray(entry.refs) ? entry.refs.map(r => r.toString().slice(0, 16) + '...') : (entry.refs ? [entry.refs.toString().slice(0, 16) + '...'] : []);
              
              console.log('   🔗 Next:', nextRefs.length > 0 ? nextRefs : 'NO NEXT');
              console.log('   📎 Refs:', refs.length > 0 ? refs : 'NO REFS');
              
              // Show full entry structure (collapsed)
              console.log('   🏗️ Full Entry Structure:', {
                version: entry.v,
                id: entry.id,
                key: entry.key,
                identity: entry.identity?.slice ? entry.identity.slice(0, 32) + '...' : entry.identity,
                signature: entry.sig ? entry.sig.slice(0, 32) + '...' : null,
                payloadKeys: Object.keys(entry.payload || {}),
                hasNext: !!entry.next,
                hasRefs: !!entry.refs,
                hasClock: !!entry.clock
              });
              
              // Limit output to prevent console overflow
              if (entryCount >= 10) {
                console.log('   ⚠️ Limiting output to first 10 entries to prevent console overflow...');
                break;
              }
            }
          } catch (iteratorError) {
            console.error('❌ Error using log.iterator():', iteratorError.message);
            entryCount = 0; // Reset to try alternative methods
          }
        } else {
          console.log('⚠️ log.iterator() not available, trying alternative methods...');
        }
        
        // Method 2: Try using database.iterator() as fallback (for database entries)
        if (entryCount === 0) {
          console.log('\n📖 Trying database.iterator() as fallback:');
          try {
            for await (const record of aliceDatabase.iterator()) {
              entryCount++;
              console.log(`\n📄 Database Record #${entryCount}:`);
              console.log('   🔑 Key:', record.key);
              console.log('   💾 Value:', JSON.stringify(record.value)?.slice(0, 100) + '...');
              console.log('   🔗 Hash:', record.hash?.toString() || 'NO HASH');
              
              // Try to get the actual oplog entry for this record
              if (record.hash) {
                try {
                  const oplogEntry = await aliceDatabase.log.get(record.hash);
                  if (oplogEntry) {
                    console.log('   🔐 Signature:', oplogEntry.sig ? `${oplogEntry.sig.slice(0, 32)}... (${oplogEntry.sig.length} chars)` : 'NO SIGNATURE');
                    console.log('   🆔 Entry Identity:', oplogEntry.identity);
                  }
                } catch (getError) {
                  console.log('   ⚠️ Could not get oplog entry for record:', getError.message);
                }
              }
              
              // Limit output
              if (entryCount >= 10) {
                console.log('   ⚠️ Limiting output to first 10 records...');
                break;
              }
            }
          } catch (dbIteratorError) {
            console.error('❌ Error using database.iterator():', dbIteratorError.message);
          }
        }
        
        // Summary
        console.log(`\n📊 OPLOG SUMMARY:`);
        console.log(`   📝 Total Entries Found: ${entryCount}`);
        console.log(`   🗄️ Database Todos: ${aliceTodos.length}`);
        console.log(`   🔍 Match: ${entryCount >= aliceTodos.length ? '✅ YES' : '❌ NO - Missing entries'}`);
        
        // Check if all entries have signatures (WebAuthn should sign everything)
        console.log(`   🔐 WebAuthn Signature Check: All entries should be signed with WebAuthn`);
        
        // Additional oplog info
        console.log(`\n🔧 Oplog Technical Details:`);
        console.log(`   📊 Oplog Length:`, oplog.length || 'unknown');
        console.log(`   🆔 Oplog Type:`, typeof oplog);
        console.log(`   📋 Available Methods:`, Object.getOwnPropertyNames(oplog).filter(prop => typeof oplog[prop] === 'function'));
        
      } catch (error) {
        console.error('❌ Error iterating oplog:', error);
        console.error('   Error details:', error.message);
        console.error('   Error stack:', error.stack?.slice(0, 500) + '...');
      }
      
      console.log('🗂️ =============== END OPLOG HISTORY ===============\n');

      // 🔒 ACCESS CONTROLLER INSPECTION
      console.log('\n🔒 =============== ACCESS CONTROLLER ANALYSIS ===============');
      try {
        const database = aliceDatabase;
        console.log('🎯 Database Access Controller Details:');
        console.log('   📊 Database Name:', database.name);
        console.log('   🆔 Database Identity:', database.identity?.id);
        console.log('   📍 Database Address:', database.address);
        
        // Check if access controller exists
        if (database.access) {
          console.log('\n🔐 Access Controller Found:');
          console.log('   🏷️ Type:', database.access.type || typeof database.access);
          console.log('   📋 Available Methods:', Object.getOwnPropertyNames(database.access).filter(prop => typeof database.access[prop] === 'function'));
          
          // Check for write permissions
          if (database.access.write) {
            console.log('\n✍️ Write Permissions:');
            if (Array.isArray(database.access.write)) {
              console.log('   📝 Write Array:', database.access.write);
              console.log('   📊 Total Writers:', database.access.write.length);
              
              // Check if wildcard is present
              if (database.access.write.includes('*')) {
                console.log('   🌟 WILDCARD ACCESS: * found - ALL identities can write');
                console.log('   ⚠️ WARNING: Using wildcard access - this was the old configuration!');
              } else {
                console.log('   🔒 RESTRICTED ACCESS: Only specific identities can write');
                console.log('   ✅ GOOD: Using identity-based access control as intended');
              }
              
              // Additional security analysis
              const hasWildcard = database.access.write.includes('*');
              const hasSpecificIdentities = database.access.write.some(id => id !== '*');
              
              if (hasWildcard && hasSpecificIdentities) {
                console.log('   ⚠️ MIXED ACCESS: Both wildcard (*) AND specific identities present');
                console.log('   📝 This means the wildcard makes specific identities redundant');
              } else if (hasWildcard) {
                console.log('   🌍 OPEN ACCESS: Only wildcard present - any identity can write');
              } else {
                console.log('   🔐 SECURE ACCESS: Only specific identities can write (recommended)');
              }
              
              // Check if our WebAuthn identity is in the list
              const ourIdentityId = database.identity?.id;
              if (ourIdentityId && database.access.write.includes(ourIdentityId)) {
                console.log('   ✅ OUR IDENTITY ALLOWED:', ourIdentityId.slice(0, 32) + '...');
              } else if (ourIdentityId) {
                console.log('   ❌ OUR IDENTITY NOT IN LIST:', ourIdentityId.slice(0, 32) + '...');
                console.log('   ⚠️ This might cause write failures!');
              }
              
              // Show each allowed identity
              database.access.write.forEach((identity, index) => {
                if (identity === '*') {
                  console.log(`   ${index + 1}. 🌟 WILDCARD: * (allows all identities)`);
                } else {
                  const isOurs = identity === ourIdentityId;
                  console.log(`   ${index + 1}. ${isOurs ? '👤 OUR IDENTITY' : '👥 OTHER IDENTITY'}: ${identity.slice(0, 32)}...`);
                }
              });
            } else {
              console.log('   📝 Write Property (not array):', database.access.write);
            }
          } else {
            console.log('   ⚠️ No write property found on access controller');
          }
          
          // Test access controller methods
          if (typeof database.access.canAppend === 'function') {
            console.log('\n🧪 Testing Access Controller canAppend method:');
            
            // Create a mock entry to test access
            const mockEntry = {
              identity: database.identity?.id,
              payload: { op: 'PUT', key: 'test', value: 'test' },
              v: 2,
              clock: { id: database.identity?.id, time: 1 }
            };
            
            try {
              const canAppend = await database.access.canAppend(mockEntry);
              console.log('   🧪 Mock Entry Test Result:', canAppend ? '✅ ALLOWED' : '❌ DENIED');
              
              if (!canAppend) {
                console.log('   ⚠️ WARNING: Mock entry would be denied - this explains write failures!');
              }
            } catch (canAppendError) {
              console.log('   ❌ Error testing canAppend:', canAppendError.message);
            }
          } else {
            console.log('   ⚠️ No canAppend method found on access controller');
          }
          
        } else {
          console.log('\n❌ No access controller found on database');
          console.log('   ⚠️ This might indicate a configuration issue');
        }
        
        // Check the original database configuration
        console.log('\n📋 Database Configuration Analysis:');
        console.log('   🏗️ Database Type:', database.type || 'unknown');
        console.log('   📊 Database Options Keys:', Object.keys(database.options || {}));
        
        if (database.options?.AccessController) {
          console.log('   🔐 AccessController in options:', typeof database.options.AccessController);
        }
        
        // Show the actual access controller constructor/function
        if (database.access && database.access.constructor) {
          console.log('   🏗️ Access Controller Constructor:', database.access.constructor.name);
        }
        
      } catch (accessError) {
        console.error('❌ Error inspecting access controller:', accessError);
        console.error('   Error details:', accessError.message);
      }
      
      console.log('🔒 =============== END ACCESS CONTROLLER ANALYSIS ===============\n');

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
    aliceStep = "Creating backup...";

    try {
      addResult("alice", "Backup", "running", "Creating backup to Storacha...");

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ 
          write: [sharedIdentity.id] // Use the actual WebAuthn identity ID
        }),
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
          identityType: sharedIdentity.type || identityMethod,
        },
      );

      aliceStep = "Alice backup complete - Bob can now restore";
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
          `Creating Bob's own identity using ${identityMethod}...`,
        );

        let identityResult;
        if (identityMethod === "webauthn") {
          identityResult = await createWebAuthnIdentity("bob");
        } else {
          identityResult = await createMnemonicIdentity("bob");
        }

        bobIdentity = identityResult.identity;
        bobIdentities = identityResult.identities;

        updateLastResult(
          "bob",
          "success",
          `Bob's identity created (${identityMethod}): ${bobIdentity.id}`,
          {
            identityId: bobIdentity.id,
            identityType: bobIdentity.type || identityMethod,
          },
        );
      }

      addResult(
        "bob",
        "Setup",
        "running",
        `Setting up Bob's OrbitDB instance with ${bobUseSameIdentity ? "shared" : "own"} identity...`,
      );

      // Determine which identity to use for access control
      const identityForAccess = bobUseSameIdentity ? sharedIdentity : bobIdentity;
      
      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ 
          write: [identityForAccess.id] // Use the appropriate identity ID
        }),
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
          identityType: identityUsed?.type || identityMethod,
          databaseAddress: bobDatabase.address,
          usingSameIdentity: bobUseSameIdentity,
          identityMatches:
            bobOrbitDB.identity.id === (sharedIdentity?.id || "none"),
        },
      );

      bobStep = "Bob ready to restore";
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
    bobStep = "Restoring from backup...";

    try {
      const identityInfo = bobUseSameIdentity
        ? `same ${identityMethod} identity as Alice`
        : `his own ${identityMethod} identity`;

      addResult(
        "bob",
        "Restore",
        "running",
        `Restoring database from Storacha backup using ${identityInfo}...`,
      );

      // Use the same identity that Bob is using for restore
      const identityForAccess = bobUseSameIdentity ? sharedIdentity : bobIdentity;
      
      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: IPFSAccessController({ 
          write: [identityForAccess.id] // Use the appropriate identity ID
        }),
      };

      // Create bridge with progress tracking
      const bridge = createStorachaBridge(storachaCredentials);

      // Use bridge for optimized log-entries-only restore
      restoreResult = await bridge.restoreLogEntriesOnly(bobOrbitDB, {
        dbName: "shared-todos",
        dbConfig: databaseConfig,
        timeout: 120000,
      });

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
          identityType: identityMethod,
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
      console.error("❌ Restore failed:", error);
      bobError = error.message;
      bobStep = `Restore failed: ${error.message}`;
      updateLastResult("bob", "error", error.message);
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
    sharedWebAuthnCredential = null;
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

  <!-- Identity Method Selection -->
  <Row>
    <Column>
      <Tile style="margin-bottom: 2rem;">
        <div
          style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;"
        >
          <Shield size={20} />
          <h4 style="font-size:1.125rem;font-weight:600;margin:0;">
            Identity Method Selection
          </h4>
        </div>

        <p style="color:var(--cds-text-secondary);margin-bottom:1rem;">
          Choose how to create your OrbitDB identity. WebAuthn provides
          hardware-backed security with biometric authentication.
        </p>

        <!-- WebAuthn Support Status -->
        {#if webAuthnChecking}
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;">
            <Loading withOverlay={false} small />
            <span style="font-size:0.875rem;">Checking WebAuthn support...</span>
          </div>
        {:else}
          <InlineNotification
            kind={webAuthnSupported ? (webAuthnPlatformAvailable ? "success" : "info") : "warning"}
            title={webAuthnSupported ? "WebAuthn Supported" : "WebAuthn Not Available"}
            subtitle={webAuthnSupportMessage}
            style="margin-bottom:1rem;"
          />
        {/if}

        <!-- Identity Method Radio Buttons -->
        <RadioButtonGroup
          bind:selected={identityMethod}
          legendText="Select Identity Creation Method"
          disabled={aliceRunning || bobRunning || sharedIdentity}
        >
          <RadioButton
            labelText="Mnemonic Seed Phrase (Traditional)"
            value="mnemonic"
          />
          <RadioButton
            labelText="WebAuthn Biometric (Hardware-Secured)"
            value="webauthn"
            disabled={!webAuthnSupported}
          />
        </RadioButtonGroup>

        {#if identityMethod === "webauthn" && webAuthnSupported}
          <div style="margin-top:1rem;padding:1rem;background:var(--cds-layer-accent);border-radius:0.25rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
              <Fingerprint size={16} />
              <strong style="font-size:0.875rem;">WebAuthn Benefits:</strong>
            </div>
            <ul style="font-size:0.875rem;color:var(--cds-text-secondary);margin:0;padding-left:1rem;">
              <li>Private keys never leave secure hardware</li>
              <li>Face ID, Touch ID, or Windows Hello authentication</li>
              <li>No seed phrases to manage or lose</li>
              <li>Quantum-resistant when using modern authenticators</li>
            </ul>
          </div>
        {:else if identityMethod === "mnemonic"}
          <div style="margin-top:1rem;padding:1rem;background:var(--cds-layer-accent);border-radius:0.25rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
              <Key size={16} />
              <strong style="font-size:0.875rem;">Mnemonic Seed Benefits:</strong>
            </div>
            <ul style="font-size:0.875rem;color:var(--cds-text-secondary);margin:0;padding-left:1rem;">
              <li>Widely supported across all platforms</li>
              <li>Compatible with existing crypto wallets</li>
              <li>Deterministic identity generation</li>
              <li>Easy backup and recovery with 12 words</li>
            </ul>
          </div>
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
            Alice & Bob Backup/Restore Demo with {identityMethod === "webauthn" ? "WebAuthn" : "Mnemonic"}
          </h3>
        </div>
        <p style="color:var(--cds-text-secondary);margin:0;">
          Alice creates todos and backs them up to Storacha using {identityMethod === "webauthn" ? "biometric authentication" : "seed phrase identity"}. 
          Bob restores the data from the backup using either the same identity or his own.
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
            {#if identityMethod === "webauthn"}
              <Fingerprint size={16} style="color:white;" />
            {:else}
              <UserAvatar size={16} style="color:white;" />
            {/if}
          </div>
          <h4 style="font-size:1.125rem;font-weight:600;margin:0;">
            Alice (Data Creator) - {identityMethod === "webauthn" ? "Biometric" : "Mnemonic"}
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
            icon={aliceRunning ? undefined : (identityMethod === "webauthn" ? Fingerprint : DataBase)}
            on:click={initializeAlice}
            disabled={aliceRunning || aliceOrbitDB || !storachaAuthenticated}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Alice ({identityMethod === "webauthn" ? "Biometric Auth" : "Mnemonic"})
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
            {#if identityMethod === "webauthn"}
              <Fingerprint size={16} style="color:white;" />
            {:else}
              <UserAvatar size={16} style="color:white;" />
            {/if}
          </div>
          <h4 style="font-size:1.125rem;font-weight:600;margin:0;">
            Bob (Data Restorer) - {identityMethod === "webauthn" ? "Biometric" : "Mnemonic"}
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
              🔗 Bob will use Alice's shared {identityMethod === "webauthn" ? "biometric" : "mnemonic"} identity - typical for same user restoring data
            {:else}
              🆔 Bob will create his own {identityMethod === "webauthn" ? "biometric" : "mnemonic"} identity - demonstrates cross-identity data sharing
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
            icon={bobRunning ? undefined : (identityMethod === "webauthn" ? Fingerprint : DataBase)}
            on:click={initializeBob}
            disabled={bobRunning ||
              !backupResult ||
              bobOrbitDB ||
              !storachaAuthenticated}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Bob ({identityMethod === "webauthn" ? "Biometric" : "Mnemonic"})
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
                • Identity: {bobUseSameIdentity ? `🔗 Same ${identityMethod}` : `🆔 Own ${identityMethod}`}
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
          subtitle={`Alice created ${aliceTodos.length} todos using ${identityMethod === "webauthn" ? "biometric authentication" : "mnemonic seed"} and backed them up to Storacha. Bob successfully restored all ${bobTodos.length} todos from the backup using ${bobUseSameIdentity ? "the same identity" : "his own identity"}!`}
          style="margin-top:2rem;"
        >
          {#if backupResult && restoreResult}
            <p style="font-size:0.75rem;margin-top:0.5rem;">
              Backup: {backupResult.blocksUploaded}/{backupResult.blocksTotal} blocks
              • Restore: {restoreResult.entriesRecovered} entries recovered 
              • Identity: {bobUseSameIdentity ? `Shared (${identityMethod})` : `Separate (${identityMethod})`}
              • Method: {identityMethod === "webauthn" ? "🔐 Hardware-Secured Biometric" : "🔑 Mnemonic Seed Phrase"}
            </p>
          {/if}
        </InlineNotification>
      </Column>
    </Row>
  {/if}
</Grid>