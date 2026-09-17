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
  import { createHelia } from "helia";
  import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
  import { webSockets } from "@libp2p/websockets";
  import { webRTC } from "@libp2p/webrtc";
  import { noise } from "@chainsafe/libp2p-noise";
  import { yamux } from "@chainsafe/libp2p-yamux";
  import { identify } from "@libp2p/identify";
  import { gossipsub } from "@libp2p/gossipsub";
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

  // Import WebAuthn DID Provider from published module
  import {
    WebAuthnDIDProvider,
    OrbitDBWebAuthnIdentityProviderFunction,
    registerWebAuthnProvider,
    checkWebAuthnSupport,
    storeWebAuthnCredential,
    loadWebAuthnCredential
  } from "@le-space/orbitdb-identity-provider-webauthn-did";

  // Where backups go, and the Carbon components
  import StorageBackendPicker from "./StorageBackendPicker.svelte";
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
  import { logger } from "./logger.js";

  // Where backups go: a storage backend from StorageBackendPicker
  let storageBackend = null;
  let storageLabel = "";

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
  let demoDatabaseAddresses = new Set();

  // Check WebAuthn support on component initialization
  async function initializeWebAuthnSupport() {
    try {
      const support = await checkWebAuthnSupport();
      webAuthnSupported = support.supported;
      webAuthnPlatformAvailable = support.platformAuthenticator;
      webAuthnSupportMessage = support.message;

      // WebAuthn provider will be registered when needed (not automatically)
      logger.info('WebAuthn support detected, provider will be registered when creating identity');
    } catch (error) {
      logger.error("WebAuthn support check failed:", error);
      webAuthnSupportMessage = "Unable to check WebAuthn support";
    } finally {
      webAuthnChecking = false;
    }
  }

  // Initialize on component mount
  initializeWebAuthnSupport();

  // backupDatabase reports its steps through an emitter; show them as Alice's step.
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
   * Create a reusable OrbitDB identity from seed (mnemonic-based)
   */
  async function createMnemonicIdentity(persona = "shared") {
    logger.info(`🆔 Creating ${persona} identity from mnemonic...`);

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

    logger.info(`✅ ${persona} mnemonic identity created: ${identity.id}`);
    return { identity, identities, seedPhrase, masterSeed };
  }

  /**
   * Create a reusable OrbitDB identity using WebAuthn
   */
  async function createWebAuthnIdentity(persona = "shared") {
    logger.info(`🆔 Creating ${persona} identity with WebAuthn...`);

    if (!webAuthnSupported) {
      throw new Error("WebAuthn is not supported in this browser");
    }

    // Create or load WebAuthn credential (with improved storage from published module)
    let webauthnCredential = loadWebAuthnCredential();
    if (!webauthnCredential) {
      // Create new WebAuthn credential
      webauthnCredential = await WebAuthnDIDProvider.createCredential({
        userId: `${persona}@orbitdb.org`,
        displayName: `OrbitDB ${persona} Identity`,
      });
      // Store credential for future use
      storeWebAuthnCredential(webauthnCredential);
      logger.info('🔐 New WebAuthn credential created and stored');
    } else {
      logger.info('🔐 Existing WebAuthn credential loaded from storage');
    }

    // Register the WebAuthn provider (like DID provider does)
    useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);

    // Create OrbitDB identities instance with default keystore
    // The WebAuthn provider will handle signing internally
    const identities = await Identities();

    // FIXED: Use OrbitDB's built-in identity creation instead of plain object
    // This ensures proper identity resolution and verification in access controller
    
    // Ensure the WebAuthn provider is registered with OrbitDB
    logger.info('🔧 Registering WebAuthn identity provider with OrbitDB...');
    
    // Debug: Check if provider is already registered
    logger.info('🔍 Checking OrbitDB identity providers before registration...');
    
    const registrationSuccess = registerWebAuthnProvider();
    logger.info('📋 Registration result:', registrationSuccess);
    
    if (!registrationSuccess) {
      throw new Error('Failed to register WebAuthn provider with OrbitDB');
    }
    
    // Debug: Verify the provider function
    logger.info('🔍 WebAuthn Provider Function:', OrbitDBWebAuthnIdentityProviderFunction);
    logger.info('🔍 Provider Type:', OrbitDBWebAuthnIdentityProviderFunction.type);
    logger.info('🔍 Provider verifyIdentity:', typeof OrbitDBWebAuthnIdentityProviderFunction.verifyIdentity);
    
    // Create the identity using OrbitDB's standard identity creation
    // This ensures proper serialization, resolution via getIdentity(), and verification
    logger.info('🆔 Creating WebAuthn identity via OrbitDB identities.createIdentity...');
    const identity = await identities.createIdentity({
      provider: OrbitDBWebAuthnIdentityProviderFunction({ webauthnCredential })
    });
    
    logger.info('✅ Created OrbitDB-compatible WebAuthn identity:', {
      id: identity.id,
      type: identity.type,
      publicKey: identity.publicKey,
      hasSign: typeof identity.sign === 'function',
      hasVerify: typeof identity.verify === 'function',
      hasHash: !!identity.hash
    });
    
    // 🔍 CRITICAL DEBUG: Test the signing function directly
    logger.info('🔍 Testing WebAuthn identity signing function directly...');
    try {
      const testData = 'test-signing-data';
      logger.info('🧪 Calling identity.sign() with test data - this should trigger WebAuthn!');
      
      const testSignature = await identity.sign(identity, testData);
      logger.info('✅ Direct signing test successful!');
      logger.info('   📏 Signature length:', testSignature?.length);
      logger.info('   🔤 Signature preview:', testSignature?.slice(0, 64) + '...');
      
      // Try to decode as WebAuthn proof
      try {
        const proofBytes = new Uint8Array(Array.from(atob(testSignature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
        const proofText = new TextDecoder().decode(proofBytes);
        const webauthnProof = JSON.parse(proofText);
        logger.info('   🎉 SUCCESS: Direct signing produced WebAuthn proof format!');
        logger.info('   🆔 Credential ID in proof:', webauthnProof.credentialId?.slice(0, 16) + '...');
      } catch (decodeError) {
        logger.info('   ⚠️ WARNING: Direct signing did NOT produce WebAuthn proof format');
        logger.info('   📝 Signature appears to be:', testSignature?.startsWith('30') ? 'DER-encoded ECDSA' : 'Unknown format');
      }
      
    } catch (signError) {
      logger.info('❌ Direct signing test failed:', signError.message);
      logger.info('   ⚠️ This explains why OrbitDB falls back to default signing!');
    }
    
    // Verify the identity can be resolved by the identities system
    logger.info('🔍 Testing identity resolution...');
    const resolvedIdentity = await identities.getIdentity(identity.id);
    if (resolvedIdentity) {
      logger.info('✅ Identity resolution test passed - access controller should work');
    } else {
      logger.warn('⚠️ Identity resolution test failed - this may cause access control issues');
    }
    
    // Test identity verification
    logger.info('🔍 Testing identity verification...');
    try {
      const verificationResult = await identities.verifyIdentity(identity);
      if (verificationResult) {
        logger.info('✅ Identity verification test passed');
      } else {
        logger.warn('⚠️ Identity verification test failed');
      }
    } catch (verifyError) {
      logger.warn('⚠️ Identity verification test error:', verifyError.message);
    }

    logger.info(`✅ ${persona} WebAuthn identity created: ${identity.id}`);
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

  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    useSharedIdentity = true,
  ) {
    logger.info(`🔧 Creating OrbitDB instance for ${persona}...`);

    // Helia 7 builds libp2p itself, from options — it no longer takes a finished
    // node — and hands back a node that has to be started before OrbitDB reads
    // helia.libp2p. Memory storage, to avoid persistence conflicts between runs.
    logger.info("🗄️ Initializing Helia with memory storage for testing...");
    const helia = await createHelia({ libp2p: DefaultLibp2pBrowserOptions }).start();
    const libp2p = helia.libp2p;
    logger.info("Helia and libp2p started with memory storage");

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
      logger.info(`🔑 Alice using WebAuthn identity: ${sharedIdentity.id}`);
    } else if (persona === "bob") {
      if (useSharedIdentity && sharedIdentity && sharedIdentities) {
        // Bob shares Alice's WebAuthn identity
        orbitdbConfig.identities = sharedIdentities;
        orbitdbConfig.identity = sharedIdentity;
        logger.info(`🔗 Bob using Alice's shared WebAuthn identity: ${sharedIdentity.id}`);
      } else if (bobIdentity && bobIdentities) {
        // Bob has his own identity
        orbitdbConfig.identities = bobIdentities;
        orbitdbConfig.identity = bobIdentity;
        logger.info(`🆔 Bob using his own identity: ${bobIdentity.id}`);
      } else {
        // Fallback: let OrbitDB create default identity with unique ID
        orbitdbConfig.id = `${persona}-${instanceId}-${Date.now()}-${Math.random()}`;
        logger.info(`⚠️ ${persona} using default OrbitDB identity`);
      }
    } else {
      // Fallback: let OrbitDB create default identity with unique ID
      orbitdbConfig.id = `${persona}-${instanceId}-${Date.now()}-${Math.random()}`;
      logger.info(`⚠️ ${persona} using default OrbitDB identity`);
    }

    logger.info('🔧 OrbitDB config about to be used:', {
      hasIPFS: !!orbitdbConfig.ipfs,
      hasIdentity: !!orbitdbConfig.identity,
      hasIdentities: !!orbitdbConfig.identities,
      hasId: !!orbitdbConfig.id,
      identityId: orbitdbConfig.identity?.id,
      identityType: orbitdbConfig.identity?.type,
      directory: orbitdbConfig.directory
    });
    
    const orbitdb = await createOrbitDB(orbitdbConfig);
    
    logger.info('🆔 OrbitDB instance created:', {
      orbitDBId: orbitdb.id,
      actualIdentityId: orbitdb.identity?.id,
      actualIdentityType: orbitdb.identity?.type,
      actualIdentityHash: orbitdb.identity?.hash,
      identityMatch: orbitdb.identity?.id === orbitdbConfig.identity?.id ? '✅ MATCH' : '❌ DIFFERENT',
      hasSignMethod: typeof orbitdb.identity?.sign === 'function',
      hasVerifyMethod: typeof orbitdb.identity?.verify === 'function',
      signMethodString: orbitdb.identity?.sign?.toString().slice(0, 100) + '...'
    });
    
    logger.info("📂 OrbitDB instance created with WebAuthn identity");

    // Create database with access controller
    const database = await orbitdb.open(databaseName, databaseConfig);
    logger.info("📊 Database created:", database.name);

    // Set up event listeners for this database
    setupDatabaseEventListeners(database, persona);

    return { libp2p, helia, orbitdb, database };
  }

  // Add this new function to set up event listeners for the demo databases only
  function setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    logger.info(`🎧 Setting up event listeners for ${persona}'s database...`);
    logger.info(`🎯 [Demo] Database address: ${database.address}`);

    // Add this database address to our tracking set
    demoDatabaseAddresses.add(
      database.address?.toString() || database.address,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any demo database
      const eventAddress = address?.toString() || address;

      if (demoDatabaseAddresses.has(eventAddress)) {
        logger.info(`🔗 [Demo-${persona}] JOIN EVENT:`, {
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
      // Check if this event is for any demo database
      const eventAddress = address?.toString() || address;

      if (demoDatabaseAddresses.has(eventAddress)) {
        logger.info(`🔄 [Demo-${persona}] UPDATE EVENT:`, {
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

    logger.info(
      `✅ [Demo] Event listeners set up for database instance ${persona}`,
    );
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
          db.name.includes("simple-todo") ||
          db.name.includes("storacha-test") ||
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
      logger.info('\n🔐 Configuring Access Controller for Alice:');
      logger.info('   🆔 WebAuthn Identity ID:', sharedIdentity.id);
      logger.info('   🏷️ Identity Type:', sharedIdentity.type);
      logger.info('   🔑 Identity Key (for access):', sharedIdentity.key?.slice(0, 32) + '...' || 'NO KEY');
      
      const writePermissions = [sharedIdentity.id];
      logger.info('   ✍️ Write Permissions Array:', writePermissions);
      logger.info('   🌟 Using Wildcard (*)?', writePermissions.includes('*') ? 'YES' : 'NO');
      logger.info('   🔒 Access Control Type: EXPLICIT IDENTITY-BASED');
      
      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // FIXED: Use explicit identity-based access control instead of wildcard
        // This ensures the WebAuthn identity is properly validated
        AccessController: IPFSAccessController({
          write: writePermissions // Use the actual WebAuthn identity ID
        }),
      };
      
      logger.info('   ⚙️ Final Database Config:', {
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
        
        logger.info(`📝 Adding todo ${i + 1}: ${todo.text}`);
        
        const hash = await aliceDatabase.put(todo.id, todo);
        
        logger.info(`✅ Todo ${i + 1} added with hash: ${hash.slice(0, 16)}...`);
        
        // 🔍 DETAILED WEBAUTHN SIGNATURE VERIFICATION
        const entry = await aliceDatabase.log.get(hash);
        if (entry) {
          logger.info(`\n🔐 =============== TODO ${i + 1} SIGNATURE ANALYSIS ===============`);
          logger.info('📄 Entry Hash:', hash);
          logger.info('🆔 Entry Identity:', entry.identity);
          logger.info('🔑 Expected Identity (WebAuthn):', aliceOrbitDB.identity.id);
          logger.info('🔑 Expected Identity Hash:', aliceOrbitDB.identity.hash);
          
          // Check both DID and hash matches (OrbitDB may convert DID to hash for oplog)
          const didMatch = entry.identity === aliceOrbitDB.identity.id;
          const hashMatch = entry.identity === aliceOrbitDB.identity.hash;
          const isMatch = didMatch || hashMatch;
          
          logger.info('✅ Identity Match:', isMatch ? '✅ YES' : '❌ NO');
          logger.info('   📊 DID Match:', didMatch ? '✅ YES' : '❌ NO');
          logger.info('   📊 Hash Match:', hashMatch ? '✅ YES' : '❌ NO');
          
          // Signature Analysis
          if (entry.sig) {
            logger.info('🔐 Signature Present: ✅ YES');
            logger.info('   📏 Signature Length:', entry.sig.length, 'characters');
            logger.info('   🔤 Signature Preview:', entry.sig.slice(0, 64) + '...');
            logger.info('   🔍 Signature Type: WebAuthn (base64url encoded)');
            
            // Try to decode and analyze the WebAuthn proof
            try {
              const proofBytes = new Uint8Array(Array.from(atob(entry.sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
              const proofText = new TextDecoder().decode(proofBytes);
              const webauthnProof = JSON.parse(proofText);
              
              logger.info('   🧪 WebAuthn Proof Structure:');
              logger.info('      🆔 Credential ID:', webauthnProof.credentialId?.slice(0, 16) + '...' || 'MISSING');
              logger.info('      📊 Data Hash:', webauthnProof.dataHash?.slice(0, 16) + '...' || 'MISSING');
              logger.info('      🔐 Auth Data:', webauthnProof.authenticatorData ? 'PRESENT' : 'MISSING');
              logger.info('      📱 Client Data:', webauthnProof.clientDataJSON ? 'PRESENT' : 'MISSING');
              logger.info('      ⏰ Timestamp:', webauthnProof.timestamp ? new Date(webauthnProof.timestamp).toISOString() : 'MISSING');
              
              // Verify the credential ID matches our WebAuthn credential
              if (sharedWebAuthnCredential && sharedWebAuthnCredential.credentialId) {
                const credentialMatch = webauthnProof.credentialId === sharedWebAuthnCredential.credentialId;
                logger.info('      🔗 Credential Match:', credentialMatch ? '✅ YES' : '❌ NO');
                if (!credentialMatch) {
                  logger.info('         Expected:', sharedWebAuthnCredential.credentialId?.slice(0, 16) + '...');
                  logger.info('         Got:', webauthnProof.credentialId?.slice(0, 16) + '...');
                }
              }
              
              logger.info('   ✅ WebAuthn Proof Successfully Decoded and Analyzed!');
            } catch (decodeError) {
              logger.info('   ⚠️ Could not decode WebAuthn proof:', decodeError.message);
              logger.info('   📄 Raw signature might not be WebAuthn format');
            }
          } else {
            logger.info('🔐 Signature Present: ❌ NO - This entry is NOT SIGNED!');
            logger.info('   ⚠️ WARNING: Missing signature indicates signing failure!');
          }
          
          // Clock and Payload Analysis
          logger.info('⏰ Clock Info:', entry.clock ? `{id: ${entry.clock.id?.slice(0, 16)}..., time: ${entry.clock.time}}` : 'NO CLOCK');
          logger.info('📦 Payload Operation:', entry.payload?.op || 'NO OPERATION');
          logger.info('🔑 Payload Key:', entry.payload?.key || entry.key || 'NO KEY');
          
          logger.info(`🔐 =============== END TODO ${i + 1} ANALYSIS ===============\n`);
        } else {
          logger.info(`❌ Could not retrieve oplog entry for hash: ${hash}`);
        }
      }

      // Get all todos to verify and display
      aliceTodos = await aliceDatabase.all();

      // 🔍 ITERATE OVER THE ENTIRE OPLOG HISTORY
      logger.info('\n🗂️ =============== COMPLETE OPLOG HISTORY ===============');
      logger.info('📊 Database:', aliceDatabase.name);
      logger.info('📍 Address:', aliceDatabase.address);
      logger.info('🆔 Database Identity:', aliceDatabase.identity?.id);
      logger.info('📝 Total Todos Added:', aliceTodos.length);
      
      try {
        logger.info('\n🔄 Iterating through oplog entries...');
        
        // Get the oplog from the database
        const oplog = aliceDatabase.log;
        logger.info('📋 Oplog basic info:', {
          hasIterator: typeof oplog.iterator === 'function',
          length: oplog.length || 'unknown'
        });
        
        // Method 1: Use the correct OrbitDB API - log.iterator() 
        let entryCount = 0;
        if (typeof oplog.iterator === 'function') {
          logger.info('\n📖 Using log.iterator() to traverse ALL entries:');
          
          try {
            for await (const entry of oplog.iterator()) {
              entryCount++;
              logger.info(`\n📄 Entry #${entryCount}:`);
              logger.info('   🔗 Hash:', entry.hash?.toString() || entry.hash);
              logger.info('   🆔 Identity:', entry.identity);
              logger.info('   🔑 Key:', entry.key || entry.payload?.key);
              logger.info('   📋 Operation:', entry.payload?.op);
              logger.info('   💾 Value Preview:', JSON.stringify(entry.payload?.value || entry.value)?.slice(0, 100) + '...');
              logger.info('   🔐 Signature:', entry.sig ? `${entry.sig.slice(0, 32)}... (${entry.sig.length} chars)` : 'NO SIGNATURE');
              logger.info('   ⏰ Clock:', entry.clock ? `{id: ${entry.clock.id?.slice(0, 16)}..., time: ${entry.clock.time}}` : 'NO CLOCK');
              
              // Handle next and refs arrays safely
              const nextRefs = Array.isArray(entry.next) ? entry.next.map(n => n.toString().slice(0, 16) + '...') : (entry.next ? [entry.next.toString().slice(0, 16) + '...'] : []);
              const refs = Array.isArray(entry.refs) ? entry.refs.map(r => r.toString().slice(0, 16) + '...') : (entry.refs ? [entry.refs.toString().slice(0, 16) + '...'] : []);
              
              logger.info('   🔗 Next:', nextRefs.length > 0 ? nextRefs : 'NO NEXT');
              logger.info('   📎 Refs:', refs.length > 0 ? refs : 'NO REFS');
              
              // Show full entry structure (collapsed)
              logger.info('   🏗️ Full Entry Structure:', {
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
                logger.info('   ⚠️ Limiting output to first 10 entries to prevent console overflow...');
                break;
              }
            }
          } catch (iteratorError) {
            logger.error('❌ Error using log.iterator():', iteratorError.message);
            entryCount = 0; // Reset to try alternative methods
          }
        } else {
          logger.info('⚠️ log.iterator() not available, trying alternative methods...');
        }
        
        // Method 2: Try using database.iterator() as fallback (for database entries)
        if (entryCount === 0) {
          logger.info('\n📖 Trying database.iterator() as fallback:');
          try {
            for await (const record of aliceDatabase.iterator()) {
              entryCount++;
              logger.info(`\n📄 Database Record #${entryCount}:`);
              logger.info('   🔑 Key:', record.key);
              logger.info('   💾 Value:', JSON.stringify(record.value)?.slice(0, 100) + '...');
              logger.info('   🔗 Hash:', record.hash?.toString() || 'NO HASH');
              
              // Try to get the actual oplog entry for this record
              if (record.hash) {
                try {
                  const oplogEntry = await aliceDatabase.log.get(record.hash);
                  if (oplogEntry) {
                    logger.info('   🔐 Signature:', oplogEntry.sig ? `${oplogEntry.sig.slice(0, 32)}... (${oplogEntry.sig.length} chars)` : 'NO SIGNATURE');
                    logger.info('   🆔 Entry Identity:', oplogEntry.identity);
                  }
                } catch (getError) {
                  logger.info('   ⚠️ Could not get oplog entry for record:', getError.message);
                }
              }
              
              // Limit output
              if (entryCount >= 10) {
                logger.info('   ⚠️ Limiting output to first 10 records...');
                break;
              }
            }
          } catch (dbIteratorError) {
            logger.error('❌ Error using database.iterator():', dbIteratorError.message);
          }
        }
        
        // Summary
        logger.info(`\n📊 OPLOG SUMMARY:`);
        logger.info(`   📝 Total Entries Found: ${entryCount}`);
        logger.info(`   🗄️ Database Todos: ${aliceTodos.length}`);
        logger.info(`   🔍 Match: ${entryCount >= aliceTodos.length ? '✅ YES' : '❌ NO - Missing entries'}`);
        
        // 🔐 WEBAUTHN SIGNATURE VERIFICATION SUMMARY
        logger.info(`\n🔐 =============== WEBAUTHN SIGNATURE SUMMARY ===============`);
        
        // Analyze all entries for WebAuthn signatures
        let signedEntries = 0;
        let webauthnProofs = 0;
        let identityMatches = 0;
        let credentialMatches = 0;
        
        try {
          for await (const entry of oplog.iterator()) {
            if (entry.sig) {
              signedEntries++;
              
              // Check identity match
              const identityMatch = entry.identity === aliceOrbitDB.identity.id || entry.identity === aliceOrbitDB.identity.hash;
              if (identityMatch) identityMatches++;
              
              // Try to decode WebAuthn proof
              try {
                const proofBytes = new Uint8Array(Array.from(atob(entry.sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
                const proofText = new TextDecoder().decode(proofBytes);
                const webauthnProof = JSON.parse(proofText);
                
                if (webauthnProof.credentialId && webauthnProof.authenticatorData) {
                  webauthnProofs++;
                  
                  // Check credential match
                  if (sharedWebAuthnCredential && webauthnProof.credentialId === sharedWebAuthnCredential.credentialId) {
                    credentialMatches++;
                  }
                }
              } catch (e) {
                // Not a WebAuthn proof format
              }
            }
          }
        } catch (iterError) {
          logger.info('   ⚠️ Could not iterate for signature analysis:', iterError.message);
        }
        
        logger.info('📊 Signature Analysis Results:');
        logger.info(`   📝 Total Entries: ${entryCount}`);
        logger.info(`   ✍️ Signed Entries: ${signedEntries}/${entryCount} (${entryCount > 0 ? Math.round(signedEntries/entryCount*100) : 0}%)`);
        logger.info(`   🔐 WebAuthn Proofs: ${webauthnProofs}/${signedEntries} (${signedEntries > 0 ? Math.round(webauthnProofs/signedEntries*100) : 0}%)`);
        logger.info(`   🆔 Identity Matches: ${identityMatches}/${entryCount} (${entryCount > 0 ? Math.round(identityMatches/entryCount*100) : 0}%)`);
        logger.info(`   🔗 Credential Matches: ${credentialMatches}/${webauthnProofs} (${webauthnProofs > 0 ? Math.round(credentialMatches/webauthnProofs*100) : 0}%)`);
        
        // Overall assessment
        const allSigned = signedEntries === entryCount && entryCount > 0;
        const allWebAuthn = webauthnProofs === signedEntries && signedEntries > 0;
        const allMatchingIdentity = identityMatches === entryCount && entryCount > 0;
        const allMatchingCredential = credentialMatches === webauthnProofs && webauthnProofs > 0;
        
        logger.info('\n🏆 Overall Assessment:');
        logger.info(`   📝 All entries signed: ${allSigned ? '✅ YES' : '❌ NO'}`);
        logger.info(`   🔐 All signatures are WebAuthn: ${allWebAuthn ? '✅ YES' : '❌ NO'}`);
        logger.info(`   🆔 All identities match: ${allMatchingIdentity ? '✅ YES' : '❌ NO'}`);
        logger.info(`   🔗 All credentials match: ${allMatchingCredential ? '✅ YES' : '❌ NO'}`);
        
        const perfect = allSigned && allWebAuthn && allMatchingIdentity && allMatchingCredential;
        logger.info(`   🎯 WebAuthn Integration: ${perfect ? '🎉 PERFECT!' : '⚠️ NEEDS ATTENTION'}`);
        
        logger.info(`🔐 =============== END WEBAUTHN SUMMARY ===============`);
        
        // Additional oplog info
        logger.info(`\n🔧 Oplog Technical Details:`);
        logger.info(`   📊 Oplog Length:`, oplog.length || 'unknown');
        logger.info(`   🆔 Oplog Type:`, typeof oplog);
        logger.info(`   📋 Available Methods:`, Object.getOwnPropertyNames(oplog).filter(prop => typeof oplog[prop] === 'function'));
        
      } catch (error) {
        logger.error('❌ Error iterating oplog:', error);
        logger.error('   Error details:', error.message);
        logger.error('   Error stack:', error.stack?.slice(0, 500) + '...');
      }
      
      logger.info('🗂️ =============== END OPLOG HISTORY ===============\n');

      // 🔒 ACCESS CONTROLLER INSPECTION
      logger.info('\n🔒 =============== ACCESS CONTROLLER ANALYSIS ===============');
      try {
        const database = aliceDatabase;
        logger.info('🎯 Database Access Controller Details:');
        logger.info('   📊 Database Name:', database.name);
        logger.info('   🆔 Database Identity:', database.identity?.id);
        logger.info('   📍 Database Address:', database.address);
        
        // Check if access controller exists
        if (database.access) {
          logger.info('\n🔐 Access Controller Found:');
          logger.info('   🏷️ Type:', database.access.type || typeof database.access);
          logger.info('   📋 Available Methods:', Object.getOwnPropertyNames(database.access).filter(prop => typeof database.access[prop] === 'function'));
          
          // Check for write permissions
          if (database.access.write) {
            logger.info('\n✍️ Write Permissions:');
            if (Array.isArray(database.access.write)) {
              logger.info('   📝 Write Array:', database.access.write);
              logger.info('   📊 Total Writers:', database.access.write.length);
              
              // Check if wildcard is present
              if (database.access.write.includes('*')) {
                logger.info('   🌟 WILDCARD ACCESS: * found - ALL identities can write');
                logger.info('   ⚠️ WARNING: Using wildcard access - this was the old configuration!');
              } else {
                logger.info('   🔒 RESTRICTED ACCESS: Only specific identities can write');
                logger.info('   ✅ GOOD: Using identity-based access control as intended');
              }
              
              // Additional security analysis
              const hasWildcard = database.access.write.includes('*');
              const hasSpecificIdentities = database.access.write.some(id => id !== '*');
              
              if (hasWildcard && hasSpecificIdentities) {
                logger.info('   ⚠️ MIXED ACCESS: Both wildcard (*) AND specific identities present');
                logger.info('   📝 This means the wildcard makes specific identities redundant');
              } else if (hasWildcard) {
                logger.info('   🌍 OPEN ACCESS: Only wildcard present - any identity can write');
              } else {
                logger.info('   🔐 SECURE ACCESS: Only specific identities can write (recommended)');
              }
              
              // Check if our WebAuthn identity is in the list
              const ourIdentityId = database.identity?.id;
              if (ourIdentityId && database.access.write.includes(ourIdentityId)) {
                logger.info('   ✅ OUR IDENTITY ALLOWED:', ourIdentityId.slice(0, 32) + '...');
              } else if (ourIdentityId) {
                logger.info('   ❌ OUR IDENTITY NOT IN LIST:', ourIdentityId.slice(0, 32) + '...');
                logger.info('   ⚠️ This might cause write failures!');
              }
              
              // Show each allowed identity
              database.access.write.forEach((identity, index) => {
                if (identity === '*') {
                  logger.info(`   ${index + 1}. 🌟 WILDCARD: * (allows all identities)`);
                } else {
                  const isOurs = identity === ourIdentityId;
                  logger.info(`   ${index + 1}. ${isOurs ? '👤 OUR IDENTITY' : '👥 OTHER IDENTITY'}: ${identity.slice(0, 32)}...`);
                }
              });
            } else {
              logger.info('   📝 Write Property (not array):', database.access.write);
            }
          } else {
            logger.info('   ⚠️ No write property found on access controller');
          }
          
          // Test access controller methods
          if (typeof database.access.canAppend === 'function') {
            logger.info('\n🧪 Testing Access Controller canAppend method:');
            
            // Create a mock entry to test access
            const mockEntry = {
              identity: database.identity?.id,
              payload: { op: 'PUT', key: 'test', value: 'test' },
              v: 2,
              clock: { id: database.identity?.id, time: 1 }
            };
            
            try {
              const canAppend = await database.access.canAppend(mockEntry);
              logger.info('   🧪 Mock Entry Test Result:', canAppend ? '✅ ALLOWED' : '❌ DENIED');
              
              if (!canAppend) {
                logger.info('   ⚠️ WARNING: Mock entry would be denied - this explains write failures!');
              }
            } catch (canAppendError) {
              logger.info('   ❌ Error testing canAppend:', canAppendError.message);
            }
          } else {
            logger.info('   ⚠️ No canAppend method found on access controller');
          }
          
        } else {
          logger.info('\n❌ No access controller found on database');
          logger.info('   ⚠️ This might indicate a configuration issue');
        }
        
        // Check the original database configuration
        logger.info('\n📋 Database Configuration Analysis:');
        logger.info('   🏗️ Database Type:', database.type || 'unknown');
        logger.info('   📊 Database Options Keys:', Object.keys(database.options || {}));
        
        if (database.options?.AccessController) {
          logger.info('   🔐 AccessController in options:', typeof database.options.AccessController);
        }
        
        // Show the actual access controller constructor/function
        if (database.access && database.access.constructor) {
          logger.info('   🏗️ Access Controller Constructor:', database.access.constructor.name);
        }
        
      } catch (accessError) {
        logger.error('❌ Error inspecting access controller:', accessError);
        logger.error('   Error details:', accessError.message);
      }
      
      logger.info('🔒 =============== END ACCESS CONTROLLER ANALYSIS ===============\n');

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
    aliceStep = "Creating backup...";

    try {
      addResult("alice", "Backup", "running", `Creating backup on ${storageLabel}...`);

      // One CAR holding every block of the database, and a small metadata file
      // that names it. The metadata's CID is all a restore needs.
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
        `Backup created on ${storageLabel}: ${backupResult.blocksTotal} blocks in one CAR`,
        {
          metadataCID: backupResult.backupFiles.metadataCID,
          carCID: backupResult.backupFiles.carCID,
          databaseAddress: backupResult.databaseAddress,
          blocksTotal: backupResult.blocksTotal,
          storage: storageLabel,
          identityType: sharedIdentity.type || identityMethod,
        },
      );

      aliceStep = "Alice backup complete - Bob can now restore";
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
    if (bobRunning || !backupResult) return;

    if (!storageBackend) {
      addResult("bob", "Error", "error", "Choose where backups go first");
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
        AccessController: IPFSAccessController({
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
    bobStep = "Restoring from backup...";

    try {
      const identityInfo = bobUseSameIdentity
        ? `same ${identityMethod} identity as Alice`
        : `his own ${identityMethod} identity`;

      addResult(
        "bob",
        "Restore",
        "running",
        `Restoring the database from ${storageLabel} using ${identityInfo}...`,
      );

      // Everything hangs off one CID: the metadata names the CAR, and the CAR
      // holds the blocks. Bob fetches both through the same backend, and every
      // block is checked against its own CID before it joins his log.
      const metadataCID = backupResult.backupFiles.metadataCID;
      bobStep = `Fetching backup ${metadataCID.slice(0, 16)}… from ${storageLabel}`;
      restoreResult = await restoreFromCID(bobOrbitDB, {
        metadataCID,
        fetchBytes: (cid) => storageBackend.getBlob(cid),
      });

      // Get restored todos
      const restoredDatabase = restoreResult.database;

      // Add restored database to tracking
      if (restoredDatabase && restoredDatabase.address) {
        demoDatabaseAddresses.add(
          restoredDatabase.address?.toString() || restoredDatabase.address,
        );
      }

      // Wait for indexing
      await new Promise((resolve) => setTimeout(resolve, 5000));
      bobTodos = await restoredDatabase.all();

      updateLastResult(
        "bob",
        "success",
        `Database restored from ${storageLabel}: ${bobTodos.length} todos, using ${identityInfo}`,
        {
          metadataCID,
          databaseAddress: restoreResult.address,
          blocks: restoreResult.blocks,
          entries: restoreResult.entries,
          headsJoined: restoreResult.joined,
          storage: storageLabel,
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
      logger.error("❌ Restore failed:", error);
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
      logger.warn("⚠️ Alice cleanup error:", error.message);
    }

    // Cleanup Bob
    try {
      if (bobDatabase) await bobDatabase.close();
      if (bobOrbitDB) await bobOrbitDB.stop();
      if (bobHelia) await bobHelia.stop();
      if (bobLibp2p) await bobLibp2p.stop();
    } catch (error) {
      logger.warn("⚠️ Bob cleanup error:", error.message);
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
    demoDatabaseAddresses.clear();
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
   * A basic Libp2p configuration for browser nodes, as options for Helia 7.
   *
   * Helia replaces each top-level key it is given and fills every other one with
   * its own browser defaults, so `peerDiscovery` is spelled out as empty: without
   * it these nodes would start dialling public bootstrap peers.
   */
  const DefaultLibp2pBrowserOptions = {
    addresses: {
      listen: ["/webrtc", "/p2p-circuit"],
    },
    transports: [
      webSockets(),
      webRTC(),
      circuitRelayTransport(),
    ],
    peerDiscovery: [],
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
  <!-- Where backups go -->
  <Row>
    <Column>
      <div style="margin-bottom: 2rem;">
        <StorageBackendPicker
          on:configured={handleStorageConfigured}
          on:cleared={handleStorageCleared}
        />

        {#if !storageBackend}
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Choose a storage first"
            subtitle="Alice backs up to it and Bob restores from it. Aleph works without an account."
          />
        {/if}
      </div>
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
          Alice creates todos and backs them up to {storageLabel || "the storage chosen above"} using {identityMethod === "webauthn" ? "biometric authentication" : "seed phrase identity"}.
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
            disabled={aliceRunning || aliceOrbitDB || !storageBackend}
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
              !storageBackend}
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
              !storageBackend}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            2. Restore from {storageLabel || "storage"}
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
          subtitle={`Alice created ${aliceTodos.length} todos using ${identityMethod === "webauthn" ? "biometric authentication" : "mnemonic seed"} and backed them up to ${storageLabel}. Bob successfully restored all ${bobTodos.length} todos from the backup using ${bobUseSameIdentity ? "the same identity" : "his own identity"}!`}
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