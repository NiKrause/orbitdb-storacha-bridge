<script>
  import {
    Plus,
    Upload,
    Download,
    Database,
    CheckCircle,
    AlertCircle,
    Loader2,
    ToggleRight,
    Fingerprint,
    Shield,
    Key,
  } from "lucide-svelte";
  // LibP2P and Helia imports - now using dedicated p2p module
  import {
    createLibp2pNode,
    createHeliaNode,
    isUsingLocalRelay,
  } from "./p2p.js";
  import {
    createOrbitDB,
    IPFSAccessController,
    useAccessController,
  } from "@orbitdb/core";
  import UCANOrbitDBAccessController from "./UCANOrbitDBAccessController.js";
  import {
    backupDatabase,
    restoreLogEntriesOnly,
    clearStorachaSpace,
    OrbitDBStorachaBridge,
  } from "./orbitdb-storacha-bridge";
  // Import the Identity Service, UCAN Service, OrbitDB Service, and required OrbitDB components
  import { identityService } from "./services/IdentityService.js";
  import { ucanService } from "./services/UCANService.js";
  import { orbitDBService } from "./services/OrbitDBService.js";
  import { Identities } from "@orbitdb/core";

  // Import the new Storacha Auth component and Carbon components
  import StorachaAuth from "./StorachaAuth.svelte";
  import { sanitizeAgent } from "./AgentSanitizer.js";
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

  // WebAuthn support state (now managed by identityService)
  let webAuthnStatus = {
    supported: false,
    platformAvailable: false,
    message: "",
    checking: true,
  };

  // Identity creation method
  let identityMethod = "webauthn"; // "mnemonic" or "webauthn"

  // UCAN delegation method
  let useBridgeDelegation = true; // true = P-256 bridge, false = direct EdDSA

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
  let aliceMultiaddrs = [];
  let aliceAddressReady = false;

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
  // Bob always has his own separate identity for cross-identity data sharing demonstration
  let bobIdentity = null; // Bob's own identity
  let bobIdentities = null; // Bob's own identities instance
  let bobPeerId = null;
  let bobConnectedPeers = [];
  let bobMultiaddrs = [];
  let bobAddressReady = false;

  // UCAN delegation state
  let storachaDelegation = null; // Storacha UCAN delegation from Alice to Bob
  let aliceUCANAccessController = null; // Reference to Alice's UCAN access controller

  // Shared state
  let sharedIdentity = null;
  let sharedIdentities = null;
  let sharedWebAuthnCredential = null; // For WebAuthn-based identity
  let sharedDatabaseAddress = null; // Shared database address for replication
  let backupResult = null;
  let restoreResult = null;
  let showDetails = false;
  let replicationEnabled = true; // Enable P2P replication

  // Connection state
  let peersConnected = false;
  let replicationEvents = [];

  // Progress tracking state
  let uploadProgress = null;
  let downloadProgress = null;
  let showProgress = false;

  // Test data with assignee field for Bob
  let originalTodos = [
    {
      id: "test_todo_1",
      text: "Buy groceries for the week",
      completed: false,
      createdAt: new Date().toISOString(),
      createdBy: "alice",
      assignee: null, // Alice's own todo
    },
    {
      id: "test_todo_2",
      text: "Walk the dog in the park",
      completed: false, // Change to false so Bob can complete it
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      createdBy: "alice",
      assignee: "bob", // Assigned to Bob - will be updated with Bob's actual DID
    },
    {
      id: "test_todo_3",
      text: "Finish the OrbitDB project",
      completed: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      createdBy: "alice",
      assignee: "bob", // Assigned to Bob - will be updated with Bob's actual DID
    },
  ];

  // Keep track of database addresses
  let storachaTestDatabaseAddresses = new Set();

  // Initialize WebAuthn support using the service
  async function initializeWebAuthnSupport() {
    try {
      webAuthnStatus = await identityService.initializeWebAuthnSupport();
    } catch (error) {
      console.error("WebAuthn support check failed:", error);
      webAuthnStatus = {
        supported: false,
        platformAvailable: false,
        message: "Unable to check WebAuthn support",
        checking: false,
      };
    }
  }

  // Initialize on component mount
  initializeWebAuthnSupport();

  // Set up OrbitDB service event callbacks
  orbitDBService.setEventCallbacks({
    addReplicationEvent,
    updatePeerConnectionStatus: (connectionState) => {
      // Update local state from OrbitDB service
      aliceMultiaddrs = connectionState.aliceMultiaddrs;
      bobMultiaddrs = connectionState.bobMultiaddrs;
      alicePeerId = connectionState.alicePeerId;
      bobPeerId = connectionState.bobPeerId;
      aliceConnectedPeers = connectionState.aliceConnectedPeers;
      bobConnectedPeers = connectionState.bobConnectedPeers;
      aliceAddressReady = connectionState.aliceAddressReady;
      bobAddressReady = connectionState.bobAddressReady;
      peersConnected = connectionState.peersConnected;
    },
    addResult,
  });

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

  // Identity creation functions now handled by IdentityService

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

  // OrbitDB instance creation now handled by OrbitDBService
  async function createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    openDatabase = true,
  ) {
    // Use OrbitDB service to create instance
    return await orbitDBService.createOrbitDBInstance(
      persona,
      instanceId,
      databaseName,
      databaseConfig,
      {
        openDatabase,
        replicationEnabled,
        sharedIdentity,
        bobIdentity,
        sharedDatabaseAddress,
      },
    );
  }

  // Database event listeners now handled by OrbitDBService

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
        identityResult = await identityService.createIdentity(
          identityMethod,
          "shared",
        );
        if (identityMethod === "webauthn") {
          sharedWebAuthnCredential = identityResult.webauthnCredential;
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

      // 🔐 UCAN ACCESS CONTROLLER CONFIGURATION
      console.log("\n🔐 Configuring UCAN Access Controller for Alice:");
      console.log("   🆔 Alice Identity ID:", sharedIdentity.id);
      console.log("   🏷️ Identity Type:", sharedIdentity.type);
      console.log(
        "   🔑 Identity Key (for access):",
        sharedIdentity.key?.slice(0, 32) + "..." || "NO KEY",
      );

      const writePermissions = [sharedIdentity.id];
      console.log("   ✍️ Initial Write Permissions:", writePermissions);
      console.log("   🔒 Access Control Type: UCAN");

      // Register the UCAN access controller for full delegation support
      console.log("   📋 Registering UCAN access controller with OrbitDB...");
      useAccessController(UCANOrbitDBAccessController);
      console.log("   ✅ UCAN access controller registered");

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // Use UCAN OrbitDB Access Controller for delegation support
        // Specify the access controller by type and pass options via AccessController
        AccessController: UCANOrbitDBAccessController({
          write: writePermissions,
          storachaClient: storachaClient,
        }),
      };

      console.log("   ⚙️ Final Database Config:", {
        type: databaseConfig.type,
        accessControllerType: "UCAN",
        writePermissions: writePermissions,
        hasAccessController: !!databaseConfig.AccessController,
        accessControllerType: typeof databaseConfig.AccessController,
      });

      // DEBUG: Test the access controller function directly before using it
      console.log("   🧪 Testing UCAN access controller function directly...");
      try {
        const testAccessController = UCANOrbitDBAccessController({
          write: writePermissions,
          storachaClient: storachaClient,
        });
        console.log(
          "   ✅ UCAN access controller function created successfully:",
          {
            type: typeof testAccessController,
            hasCanAppend: typeof testAccessController.canAppend,
            hasGrant: typeof testAccessController.grant,
            hasType: !!testAccessController.type,
          },
        );
      } catch (acError) {
        console.error("   ❌ UCAN access controller function failed:", acError);
        throw new Error(
          `UCAN access controller creation failed: ${acError.message}`,
        );
      }

      console.log(
        "   🚀 Creating OrbitDB instance with UCAN access controller...",
      );
      let instance;
      try {
        instance = await createOrbitDBInstance(
          "alice",
          "instance",
          "shared-todos-webauthn", // Shared database name for replication
          databaseConfig,
          true, // Open database immediately
        );
        console.log("   ✅ OrbitDB instance created successfully");
      } catch (dbError) {
        console.error("   ❌ OrbitDB instance creation failed:", dbError);
        throw dbError;
      }
      // Get instances from OrbitDB service
      const alicePeer = orbitDBService.getPeer("alice");
      aliceOrbitDB = alicePeer.orbitdb;
      aliceDatabase = alicePeer.database;
      aliceHelia = alicePeer.helia;
      aliceLibp2p = alicePeer.libp2p;

      // Store reference to Alice's UCAN access controller for granting access to Bob
      aliceUCANAccessController = aliceDatabase.access;

      // Debug: Check what's actually in the access controller
      console.log("\n🔍 Debug: Checking database access controller:");
      console.log("   📊 Type:", typeof aliceUCANAccessController);
      console.log("   🏷️ Access type:", aliceUCANAccessController?.type);
      console.log(
        "   📋 Available properties:",
        Object.keys(aliceUCANAccessController || {}),
      );
      console.log("   🔧 Has grant?", typeof aliceUCANAccessController?.grant);
      console.log(
        "   🔧 Has revoke?",
        typeof aliceUCANAccessController?.revoke,
      );
      console.log(
        "   🔧 Has canAppend?",
        typeof aliceUCANAccessController?.canAppend,
      );

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

      // First, create Bob's identity so we can assign todos to his actual DID
      if (!bobIdentity) {
        console.log("\n🆔 Creating Bob's identity for todo assignment...");
        let bobIdentityResult;
        bobIdentityResult = await identityService.createIdentity(
          identityMethod,
          "bob",
        );
        bobIdentity = bobIdentityResult.identity;
        bobIdentities = bobIdentityResult.identities;
        console.log(`   ✅ Bob\'s identity created: ${bobIdentity.id}`);
      }

      for (let i = 0; i < originalTodos.length; i++) {
        const todo = { ...originalTodos[i] }; // Create a copy to modify

        // Update assignee field with Bob's actual DID if it was assigned to "bob"
        if (todo.assignee === "bob") {
          todo.assignee = bobIdentity.id;
          console.log(
            `   🎯 Updated todo "${todo.text}" assignee to Bob's DID: ${bobIdentity.id}`,
          );
        }

        console.log(`📝 Adding todo ${i + 1}: ${todo.text}`);

        const hash = await aliceDatabase.put(todo.id, todo);

        console.log(
          `✅ Todo ${i + 1} added with hash: ${hash.slice(0, 16)}...`,
        );

        // 🔍 DETAILED WEBAUTHN SIGNATURE VERIFICATION
        const entry = await aliceDatabase.log.get(hash);
        if (entry) {
          console.log(
            `\n🔐 =============== TODO ${i + 1} SIGNATURE ANALYSIS ===============`,
          );
          console.log("📄 Entry Hash:", hash);
          console.log("🆔 Entry Identity:", entry.identity);
          console.log(
            "🔑 Expected Identity (WebAuthn):",
            aliceOrbitDB.identity.id,
          );
          console.log("🔑 Expected Identity Hash:", aliceOrbitDB.identity.hash);

          // Check both DID and hash matches (OrbitDB may convert DID to hash for oplog)
          const didMatch = entry.identity === aliceOrbitDB.identity.id;
          const hashMatch = entry.identity === aliceOrbitDB.identity.hash;
          const isMatch = didMatch || hashMatch;

          console.log("✅ Identity Match:", isMatch ? "✅ YES" : "❌ NO");
          console.log("   📊 DID Match:", didMatch ? "✅ YES" : "❌ NO");
          console.log("   📊 Hash Match:", hashMatch ? "✅ YES" : "❌ NO");

          // Signature Analysis
          if (entry.sig) {
            console.log("🔐 Signature Present: ✅ YES");
            console.log(
              "   📏 Signature Length:",
              entry.sig.length,
              "characters",
            );
            console.log(
              "   🔤 Signature Preview:",
              entry.sig.slice(0, 64) + "...",
            );
            console.log("   🔍 Signature Type: WebAuthn (base64url encoded)");

            // Try to decode and analyze the WebAuthn proof
            try {
              const proofBytes = new Uint8Array(
                Array.from(
                  atob(entry.sig.replace(/-/g, "+").replace(/_/g, "/")),
                  (c) => c.charCodeAt(0),
                ),
              );
              const proofText = new TextDecoder().decode(proofBytes);
              const webauthnProof = JSON.parse(proofText);

              console.log("   🧪 WebAuthn Proof Structure:");
              console.log(
                "      🆔 Credential ID:",
                webauthnProof.credentialId?.slice(0, 16) + "..." || "MISSING",
              );
              console.log(
                "      📊 Data Hash:",
                webauthnProof.dataHash?.slice(0, 16) + "..." || "MISSING",
              );
              console.log(
                "      🔐 Auth Data:",
                webauthnProof.authenticatorData ? "PRESENT" : "MISSING",
              );
              console.log(
                "      📱 Client Data:",
                webauthnProof.clientDataJSON ? "PRESENT" : "MISSING",
              );
              console.log(
                "      ⏰ Timestamp:",
                webauthnProof.timestamp
                  ? new Date(webauthnProof.timestamp).toISOString()
                  : "MISSING",
              );

              // Verify the credential ID matches our WebAuthn credential
              if (
                sharedWebAuthnCredential &&
                sharedWebAuthnCredential.credentialId
              ) {
                const credentialMatch =
                  webauthnProof.credentialId ===
                  sharedWebAuthnCredential.credentialId;
                console.log(
                  "      🔗 Credential Match:",
                  credentialMatch ? "✅ YES" : "❌ NO",
                );
                if (!credentialMatch) {
                  console.log(
                    "         Expected:",
                    sharedWebAuthnCredential.credentialId?.slice(0, 16) + "...",
                  );
                  console.log(
                    "         Got:",
                    webauthnProof.credentialId?.slice(0, 16) + "...",
                  );
                }
              }

              console.log(
                "   ✅ WebAuthn Proof Successfully Decoded and Analyzed!",
              );
            } catch (decodeError) {
              console.log(
                "   ⚠️ Could not decode WebAuthn proof:",
                decodeError.message,
              );
              console.log("   📄 Raw signature might not be WebAuthn format");
            }
          } else {
            console.log(
              "🔐 Signature Present: ❌ NO - This entry is NOT SIGNED!",
            );
            console.log(
              "   ⚠️ WARNING: Missing signature indicates signing failure!",
            );
          }

          // Clock and Payload Analysis
          console.log(
            "⏰ Clock Info:",
            entry.clock
              ? `{id: ${entry.clock.id?.slice(0, 16)}..., time: ${entry.clock.time}}`
              : "NO CLOCK",
          );
          console.log(
            "📦 Payload Operation:",
            entry.payload?.op || "NO OPERATION",
          );
          console.log(
            "🔑 Payload Key:",
            entry.payload?.key || entry.key || "NO KEY",
          );

          console.log(
            `🔐 =============== END TODO ${i + 1} ANALYSIS ===============\n`,
          );
        } else {
          console.log(`❌ Could not retrieve oplog entry for hash: ${hash}`);
        }
      }

      // Get all todos to verify and display
      aliceTodos = await aliceDatabase.all();

      // Grant Bob write access to Alice's database and create Storacha delegation
      console.log("\n🎁 Granting Bob access to Alice's database...");
      if (aliceUCANAccessController && bobIdentity) {
        try {
          // Grant Bob write access to Alice's database
          const delegationToken = await aliceUCANAccessController.grant(
            "write",
            bobIdentity.id,
          );
          console.log(`   ✅ Granted write access to Bob: ${bobIdentity.id}`);

          // Create Storacha UCAN delegation for Bob
          console.log("\n🚀 Creating Storacha delegation for Bob...");
          if (useBridgeDelegation) {
            console.log("   🌉 Using bridge delegation: EdDSA → P-256 → P-256");
            storachaDelegation = await ucanService.createDelegation(
              "bridge",
              bobIdentity.id,
              storachaClient,
              sharedIdentity,
            );
          } else {
            console.log("   📤 Using direct EdDSA delegation");
            storachaDelegation = await ucanService.createDelegation(
              "direct",
              bobIdentity.id,
              storachaClient,
            );
          }
          console.log(
            `   ✅ Storacha delegation created (${storachaDelegation.delegationType || "direct"})`,
          );
          console.log(
            `   📝 Delegation token length: ${storachaDelegation.delegationToken?.length || "N/A"}`,
          );
        } catch (grantError) {
          console.error(
            `   ❌ Failed to grant access or create delegation: ${grantError.message}`,
          );
        }
      } else {
        console.warn(
          "   ⚠️ Could not grant access - missing access controller or Bob identity",
        );
      }

      // 🔍 ITERATE OVER THE ENTIRE OPLOG HISTORY
      console.log(
        "\n🗂️ =============== COMPLETE OPLOG HISTORY ===============",
      );
      console.log("📊 Database:", aliceDatabase.name);
      console.log("📍 Address:", aliceDatabase.address);
      console.log("🆔 Database Identity:", aliceDatabase.identity?.id);
      console.log("📝 Total Todos Added:", aliceTodos.length);

      try {
        console.log("\n🔄 Iterating through oplog entries...");

        // Get the oplog from the database
        const oplog = aliceDatabase.log;
        console.log("📋 Oplog basic info:", {
          hasIterator: typeof oplog.iterator === "function",
          length: oplog.length || "unknown",
        });

        // Method 1: Use the correct OrbitDB API - log.iterator()
        let entryCount = 0;
        if (typeof oplog.iterator === "function") {
          console.log("\n📖 Using log.iterator() to traverse ALL entries:");

          try {
            for await (const entry of oplog.iterator()) {
              entryCount++;
              console.log(`\n📄 Entry #${entryCount}:`);
              console.log("   🔗 Hash:", entry.hash?.toString() || entry.hash);
              console.log("   🆔 Identity:", entry.identity);
              console.log("   🔑 Key:", entry.key || entry.payload?.key);
              console.log("   📋 Operation:", entry.payload?.op);
              console.log(
                "   💾 Value Preview:",
                JSON.stringify(entry.payload?.value || entry.value)?.slice(
                  0,
                  100,
                ) + "...",
              );
              console.log(
                "   🔐 Signature:",
                entry.sig
                  ? `${entry.sig.slice(0, 32)}... (${entry.sig.length} chars)`
                  : "NO SIGNATURE",
              );
              console.log(
                "   ⏰ Clock:",
                entry.clock
                  ? `{id: ${entry.clock.id?.slice(0, 16)}..., time: ${entry.clock.time}}`
                  : "NO CLOCK",
              );

              // Handle next and refs arrays safely
              const nextRefs = Array.isArray(entry.next)
                ? entry.next.map((n) => n.toString().slice(0, 16) + "...")
                : entry.next
                  ? [entry.next.toString().slice(0, 16) + "..."]
                  : [];
              const refs = Array.isArray(entry.refs)
                ? entry.refs.map((r) => r.toString().slice(0, 16) + "...")
                : entry.refs
                  ? [entry.refs.toString().slice(0, 16) + "..."]
                  : [];

              console.log(
                "   🔗 Next:",
                nextRefs.length > 0 ? nextRefs : "NO NEXT",
              );
              console.log("   📎 Refs:", refs.length > 0 ? refs : "NO REFS");

              // Show full entry structure (collapsed)
              console.log("   🏗️ Full Entry Structure:", {
                version: entry.v,
                id: entry.id,
                key: entry.key,
                identity: entry.identity?.slice
                  ? entry.identity.slice(0, 32) + "..."
                  : entry.identity,
                signature: entry.sig ? entry.sig.slice(0, 32) + "..." : null,
                payloadKeys: Object.keys(entry.payload || {}),
                hasNext: !!entry.next,
                hasRefs: !!entry.refs,
                hasClock: !!entry.clock,
              });

              // Limit output to prevent console overflow
              if (entryCount >= 10) {
                console.log(
                  "   ⚠️ Limiting output to first 10 entries to prevent console overflow...",
                );
                break;
              }
            }
          } catch (iteratorError) {
            console.error(
              "❌ Error using log.iterator():",
              iteratorError.message,
            );
            entryCount = 0; // Reset to try alternative methods
          }
        } else {
          console.log(
            "⚠️ log.iterator() not available, trying alternative methods...",
          );
        }

        // Method 2: Try using database.iterator() as fallback (for database entries)
        if (entryCount === 0) {
          console.log("\n📖 Trying database.iterator() as fallback:");
          try {
            for await (const record of aliceDatabase.iterator()) {
              entryCount++;
              console.log(`\n📄 Database Record #${entryCount}:`);
              console.log("   🔑 Key:", record.key);
              console.log(
                "   💾 Value:",
                JSON.stringify(record.value)?.slice(0, 100) + "...",
              );
              console.log("   🔗 Hash:", record.hash?.toString() || "NO HASH");

              // Try to get the actual oplog entry for this record
              if (record.hash) {
                try {
                  const oplogEntry = await aliceDatabase.log.get(record.hash);
                  if (oplogEntry) {
                    console.log(
                      "   🔐 Signature:",
                      oplogEntry.sig
                        ? `${oplogEntry.sig.slice(0, 32)}... (${oplogEntry.sig.length} chars)`
                        : "NO SIGNATURE",
                    );
                    console.log("   🆔 Entry Identity:", oplogEntry.identity);
                  }
                } catch (getError) {
                  console.log(
                    "   ⚠️ Could not get oplog entry for record:",
                    getError.message,
                  );
                }
              }

              // Limit output
              if (entryCount >= 10) {
                console.log("   ⚠️ Limiting output to first 10 records...");
                break;
              }
            }
          } catch (dbIteratorError) {
            console.error(
              "❌ Error using database.iterator():",
              dbIteratorError.message,
            );
          }
        }

        // Summary
        console.log(`\n📊 OPLOG SUMMARY:`);
        console.log(`   📝 Total Entries Found: ${entryCount}`);
        console.log(`   🗄️ Database Todos: ${aliceTodos.length}`);
        console.log(
          `   🔍 Match: ${entryCount >= aliceTodos.length ? "✅ YES" : "❌ NO - Missing entries"}`,
        );

        // 🔐 WEBAUTHN SIGNATURE VERIFICATION SUMMARY
        console.log(
          `\n🔐 =============== WEBAUTHN SIGNATURE SUMMARY ===============`,
        );

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
              const identityMatch =
                entry.identity === aliceOrbitDB.identity.id ||
                entry.identity === aliceOrbitDB.identity.hash;
              if (identityMatch) identityMatches++;

              // Try to decode WebAuthn proof
              try {
                const proofBytes = new Uint8Array(
                  Array.from(
                    atob(entry.sig.replace(/-/g, "+").replace(/_/g, "/")),
                    (c) => c.charCodeAt(0),
                  ),
                );
                const proofText = new TextDecoder().decode(proofBytes);
                const webauthnProof = JSON.parse(proofText);

                if (
                  webauthnProof.credentialId &&
                  webauthnProof.authenticatorData
                ) {
                  webauthnProofs++;

                  // Check credential match
                  if (
                    sharedWebAuthnCredential &&
                    webauthnProof.credentialId ===
                      sharedWebAuthnCredential.credentialId
                  ) {
                    credentialMatches++;
                  }
                }
              } catch (e) {
                // Not a WebAuthn proof format
              }
            }
          }
        } catch (iterError) {
          console.log(
            "   ⚠️ Could not iterate for signature analysis:",
            iterError.message,
          );
        }

        console.log("📊 Signature Analysis Results:");
        console.log(`   📝 Total Entries: ${entryCount}`);
        console.log(
          `   ✍️ Signed Entries: ${signedEntries}/${entryCount} (${entryCount > 0 ? Math.round((signedEntries / entryCount) * 100) : 0}%)`,
        );
        console.log(
          `   🔐 WebAuthn Proofs: ${webauthnProofs}/${signedEntries} (${signedEntries > 0 ? Math.round((webauthnProofs / signedEntries) * 100) : 0}%)`,
        );
        console.log(
          `   🆔 Identity Matches: ${identityMatches}/${entryCount} (${entryCount > 0 ? Math.round((identityMatches / entryCount) * 100) : 0}%)`,
        );
        console.log(
          `   🔗 Credential Matches: ${credentialMatches}/${webauthnProofs} (${webauthnProofs > 0 ? Math.round((credentialMatches / webauthnProofs) * 100) : 0}%)`,
        );

        // Overall assessment
        const allSigned = signedEntries === entryCount && entryCount > 0;
        const allWebAuthn =
          webauthnProofs === signedEntries && signedEntries > 0;
        const allMatchingIdentity =
          identityMatches === entryCount && entryCount > 0;
        const allMatchingCredential =
          credentialMatches === webauthnProofs && webauthnProofs > 0;

        console.log("\n🏆 Overall Assessment:");
        console.log(
          `   📝 All entries signed: ${allSigned ? "✅ YES" : "❌ NO"}`,
        );
        console.log(
          `   🔐 All signatures are WebAuthn: ${allWebAuthn ? "✅ YES" : "❌ NO"}`,
        );
        console.log(
          `   🆔 All identities match: ${allMatchingIdentity ? "✅ YES" : "❌ NO"}`,
        );
        console.log(
          `   🔗 All credentials match: ${allMatchingCredential ? "✅ YES" : "❌ NO"}`,
        );

        const perfect =
          allSigned &&
          allWebAuthn &&
          allMatchingIdentity &&
          allMatchingCredential;
        console.log(
          `   🎯 WebAuthn Integration: ${perfect ? "🎉 PERFECT!" : "⚠️ NEEDS ATTENTION"}`,
        );

        console.log(`🔐 =============== END WEBAUTHN SUMMARY ===============`);

        // Additional oplog info
        console.log(`\n🔧 Oplog Technical Details:`);
        console.log(`   📊 Oplog Length:`, oplog.length || "unknown");
        console.log(`   🆔 Oplog Type:`, typeof oplog);
        console.log(
          `   📋 Available Methods:`,
          Object.getOwnPropertyNames(oplog).filter(
            (prop) => typeof oplog[prop] === "function",
          ),
        );
      } catch (error) {
        console.error("❌ Error iterating oplog:", error);
        console.error("   Error details:", error.message);
        console.error("   Error stack:", error.stack?.slice(0, 500) + "...");
      }

      console.log("🗂️ =============== END OPLOG HISTORY ===============\n");

      // 🔒 ACCESS CONTROLLER INSPECTION
      console.log(
        "\n🔒 =============== ACCESS CONTROLLER ANALYSIS ===============",
      );
      try {
        const database = aliceDatabase;
        console.log("🎯 Database Access Controller Details:");
        console.log("   📊 Database Name:", database.name);
        console.log("   🆔 Database Identity:", database.identity?.id);
        console.log("   📍 Database Address:", database.address);

        // Check if access controller exists
        if (database.access) {
          console.log("\n🔐 Access Controller Found:");
          console.log(
            "   🏷️ Type:",
            database.access.type || typeof database.access,
          );
          console.log(
            "   📋 Available Methods:",
            Object.getOwnPropertyNames(database.access).filter(
              (prop) => typeof database.access[prop] === "function",
            ),
          );

          // Check for write permissions
          if (database.access.write) {
            console.log("\n✍️ Write Permissions:");
            if (Array.isArray(database.access.write)) {
              console.log("   📝 Write Array:", database.access.write);
              console.log("   📊 Total Writers:", database.access.write.length);

              // Check if wildcard is present
              if (database.access.write.includes("*")) {
                console.log(
                  "   🌟 WILDCARD ACCESS: * found - ALL identities can write",
                );
                console.log(
                  "   ⚠️ WARNING: Using wildcard access - this was the old configuration!",
                );
              } else {
                console.log(
                  "   🔒 RESTRICTED ACCESS: Only specific identities can write",
                );
                console.log(
                  "   ✅ GOOD: Using identity-based access control as intended",
                );
              }

              // Additional security analysis
              const hasWildcard = database.access.write.includes("*");
              const hasSpecificIdentities = database.access.write.some(
                (id) => id !== "*",
              );

              if (hasWildcard && hasSpecificIdentities) {
                console.log(
                  "   ⚠️ MIXED ACCESS: Both wildcard (*) AND specific identities present",
                );
                console.log(
                  "   📝 This means the wildcard makes specific identities redundant",
                );
              } else if (hasWildcard) {
                console.log(
                  "   🌍 OPEN ACCESS: Only wildcard present - any identity can write",
                );
              } else {
                console.log(
                  "   🔐 SECURE ACCESS: Only specific identities can write (recommended)",
                );
              }

              // Check if our WebAuthn identity is in the list
              const ourIdentityId = database.identity?.id;
              if (
                ourIdentityId &&
                database.access.write.includes(ourIdentityId)
              ) {
                console.log(
                  "   ✅ OUR IDENTITY ALLOWED:",
                  ourIdentityId.slice(0, 32) + "...",
                );
              } else if (ourIdentityId) {
                console.log(
                  "   ❌ OUR IDENTITY NOT IN LIST:",
                  ourIdentityId.slice(0, 32) + "...",
                );
                console.log("   ⚠️ This might cause write failures!");
              }

              // Show each allowed identity
              database.access.write.forEach((identity, index) => {
                if (identity === "*") {
                  console.log(
                    `   ${index + 1}. 🌟 WILDCARD: * (allows all identities)`,
                  );
                } else {
                  const isOurs = identity === ourIdentityId;
                  console.log(
                    `   ${index + 1}. ${isOurs ? "👤 OUR IDENTITY" : "👥 OTHER IDENTITY"}: ${identity.slice(0, 32)}...`,
                  );
                }
              });
            } else {
              console.log(
                "   📝 Write Property (not array):",
                database.access.write,
              );
            }
          } else {
            console.log("   ⚠️ No write property found on access controller");
          }

          // Test access controller methods
          if (typeof database.access.canAppend === "function") {
            console.log("\n🧪 Testing Access Controller canAppend method:");

            // Create a mock entry to test access
            const mockEntry = {
              identity: database.identity?.id,
              payload: { op: "PUT", key: "test", value: "test" },
              v: 2,
              clock: { id: database.identity?.id, time: 1 },
            };

            try {
              const canAppend = await database.access.canAppend(mockEntry);
              console.log(
                "   🧪 Mock Entry Test Result:",
                canAppend ? "✅ ALLOWED" : "❌ DENIED",
              );

              if (!canAppend) {
                console.log(
                  "   ⚠️ WARNING: Mock entry would be denied - this explains write failures!",
                );
              }
            } catch (canAppendError) {
              console.log(
                "   ❌ Error testing canAppend:",
                canAppendError.message,
              );
            }
          } else {
            console.log("   ⚠️ No canAppend method found on access controller");
          }
        } else {
          console.log("\n❌ No access controller found on database");
          console.log("   ⚠️ This might indicate a configuration issue");
        }

        // Check the original database configuration
        console.log("\n📋 Database Configuration Analysis:");
        console.log("   🏗️ Database Type:", database.type || "unknown");
        console.log(
          "   📊 Database Options Keys:",
          Object.keys(database.options || {}),
        );

        if (database.options?.AccessController) {
          console.log(
            "   🔐 AccessController in options:",
            typeof database.options.AccessController,
          );
        }

        // Show the actual access controller constructor/function
        if (database.access && database.access.constructor) {
          console.log(
            "   🏗️ Access Controller Constructor:",
            database.access.constructor.name,
          );
        }
      } catch (accessError) {
        console.error("❌ Error inspecting access controller:", accessError);
        console.error("   Error details:", accessError.message);
      }

      console.log(
        "🔒 =============== END ACCESS CONTROLLER ANALYSIS ===============\n",
      );

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
        accessController: UCANOrbitDBAccessController({
          write: [sharedIdentity.id], // Use the actual WebAuthn identity ID
          storachaClient: storachaClient,
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
    if (bobRunning) return;

    // Check that Alice has completed her setup first
    if (!aliceDatabase || !bobIdentity || !sharedDatabaseAddress) {
      addResult(
        "bob",
        "Error",
        "error",
        "Alice must complete setup first (add todos and create shared database)",
      );
      return;
    }

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
    bobStep = "Creating Bob's OrbitDB instance...";

    try {
      // Bob already has his identity created by Alice during todo assignment
      addResult(
        "bob",
        "Identity",
        "success",
        `Using Bob's existing identity: ${bobIdentity.id}`,
        {
          identityId: bobIdentity.id,
          identityType: bobIdentity.type || identityMethod,
        },
      );

      addResult(
        "bob",
        "Setup",
        "running",
        "Setting up Bob's OrbitDB instance for P2P replication...",
      );

      // Create Bob's OrbitDB instance without opening database yet
      const bobDatabaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        // Access controller already set when Alice created the database
      };

      const instance = await createOrbitDBInstance(
        "bob",
        "replication-instance",
        "shared-todos-webauthn",
        bobDatabaseConfig,
        false, // Don't open database yet - wait for connection first
      );
      // Get instances from OrbitDB service
      const bobPeerInstance = orbitDBService.getPeer("bob");
      bobOrbitDB = bobPeerInstance.orbitdb;
      bobHelia = bobPeerInstance.helia;
      bobLibp2p = bobPeerInstance.libp2p;
      // Note: bobDatabase is still null at this point

      // Wait for Bob to have dialable addresses before attempting connection
      console.log("⏳ Waiting for Bob to have dialable multiaddresses...");
      bobStep = "Waiting for Bob's P2P addresses to be ready...";

      addResult(
        "bob",
        "Address Check",
        "running",
        "Waiting for Bob to have dialable multiaddresses before connecting to Alice...",
      );

      bobStep = "Connecting to Alice via P2P...";

      addResult(
        "bob",
        "Connection",
        "running",
        "Bob connecting to Alice to establish P2P connection...",
      );

      // Now that Bob has addresses, try to connect to Alice
      console.log("📞 Bob attempting to connect directly to Alice...");

      const connected = await orbitDBService.forceDirectConnection();
      console.log(`📋 forceDirectConnection() returned: ${connected}`);

      if (!connected) {
        console.warn(
          "⚠️  Direct connection failed - proceeding anyway (may rely on discovery)",
        );
      } else {
        console.log("✅ Direct connection to Alice established!");
      }

      // Wait and verify that Bob is actually connected to Alice before opening database
      console.log("⏳ Waiting to verify connection with Alice...");
      bobStep = "Verifying connection with Alice...";

      addResult(
        "bob",
        "Connection Verification",
        "running",
        "Verifying Bob is connected to Alice before opening database...",
      );

      // Skip direct P2P connection verification for UCAN delegation demo
      // The UCAN access control works through IPFS/DHT without requiring direct peer connections
      console.log(
        "🚀 Skipping P2P connection verification for UCAN delegation demo",
      );
      console.log(
        "   💡 UCAN access control works through IPFS/DHT, not direct peer connections",
      );
      console.log(
        "   🔗 Alice and Bob will communicate via OrbitDB replication over IPFS",
      );

      const connectionVerified = false; // Skip connection verification

      console.log(
        "✅ Proceeding with database opening using UCAN delegation and IPFS/DHT",
      );

      // Now that connection is verified (or timed out), open Alice's shared database
      console.log("📛 Bob now opening Alice's shared database...");
      bobStep = "Opening Alice's shared database...";

      addResult(
        "bob",
        "Database Open",
        "running",
        "Bob opening Alice's shared database after verifying connection...",
      );

      // Register the UCAN access controller for Bob's OrbitDB instance too
      useAccessController(UCANOrbitDBAccessController);

      // DEBUG: Test identity resolution across Alice and Bob's systems
      console.log("\n🔍 [IDENTITY DEBUG] Testing cross-identity resolution...");
      console.log(`   Alice's identities instance: ${!!sharedIdentities}`);
      console.log(`   Bob's identities instance: ${!!bobIdentities}`);
      console.log(`   Alice identity: ${sharedIdentity?.id}`);
      console.log(`   Bob identity: ${bobIdentity?.id}`);
      console.log(`   Alice identity hash: ${sharedIdentity?.hash}`);
      console.log(`   Bob identity hash: ${bobIdentity?.hash}`);

      // Test if Alice's identities can resolve Bob's identity
      try {
        if (sharedIdentities && bobIdentity) {
          console.log(
            "🔍 Testing: Can Alice's identities resolve Bob's identity?",
          );
          const resolvedByAlice = await sharedIdentities.getIdentity(
            bobIdentity.hash,
          );
          if (resolvedByAlice) {
            console.log(
              "✅ SUCCESS: Alice can resolve Bob's identity via IPFS",
            );
            console.log(`   Resolved ID: ${resolvedByAlice.id}`);
          } else {
            console.log(
              "❌ FAILED: Alice cannot resolve Bob's identity from IPFS",
            );
            console.log(
              "   ⚠️ This will cause replication access control issues",
            );
          }
        }
      } catch (resolveError) {
        console.log(
          `❌ ERROR resolving Bob\'s identity: ${resolveError.message}`,
        );
      }

      // Test if Bob's identities can resolve Alice's identity
      try {
        if (bobIdentities && sharedIdentity) {
          console.log(
            "🔍 Testing: Can Bob's identities resolve Alice's identity?",
          );
          const resolvedByBob = await bobIdentities.getIdentity(
            sharedIdentity.hash,
          );
          if (resolvedByBob) {
            console.log(
              "✅ SUCCESS: Bob can resolve Alice's identity via IPFS",
            );
            console.log(`   Resolved ID: ${resolvedByBob.id}`);
          } else {
            console.log(
              "❌ FAILED: Bob cannot resolve Alice's identity from IPFS",
            );
          }
        }
      } catch (resolveError) {
        console.log(
          `❌ ERROR resolving Alice\'s identity: ${resolveError.message}`,
        );
      }

      console.log("🔍 [IDENTITY DEBUG] End of identity resolution tests\n");

      // CRITICAL: Connect Alice and Bob's IPFS instances to enable identity sharing
      console.log(
        "🔗 [IPFS CONNECT] Connecting Alice and Bob's IPFS instances...",
      );
      try {
        if (aliceLibp2p && bobLibp2p && aliceHelia && bobHelia) {
          // Method 1: Try direct peer connection (browser-compatible)
          console.log("   Attempting direct libp2p peer connection...");
          const alicePeerId = aliceLibp2p.peerId;
          const aliceMultiaddrs = aliceLibp2p.getMultiaddrs();

          console.log(`   Alice Peer ID: ${alicePeerId.toString()}`);
          console.log(`   Alice Multiaddrs: ${aliceMultiaddrs.length}`);

          // Save Alice's peer info to Bob's peer store
          await bobLibp2p.peerStore.save(alicePeerId, {
            multiaddrs: aliceMultiaddrs.filter(
              (addr) =>
                addr.toString().includes("/webrtc") ||
                addr.toString().includes("/p2p-circuit"),
            ),
          });

          // Bob dials Alice directly for IPFS connectivity
          console.log("   Bob dialing Alice for IPFS data sharing...");
          const ipfsConnection = await bobLibp2p.dial(alicePeerId);
          console.log("✅ IPFS connection established!");
          console.log(
            `   Connection: ${ipfsConnection.remotePeer.toString().slice(-8)}`,
          );

          console.log("⚠️ Missing IPFS instances - cannot connect");
        }
      } catch (connectError) {
        console.log(`⚠️ IPFS connection failed: ${connectError.message}`);
        console.log(
          "   Proceeding anyway - identities may not resolve properly",
        );
      }

      // Open Alice's shared database by address
      bobDatabase = await bobOrbitDB.open(sharedDatabaseAddress);

      // Update the OrbitDB service with the opened database
      const bobPeerForUpdate = orbitDBService.getPeer("bob");
      if (bobPeerForUpdate) {
        bobPeerForUpdate.database = bobDatabase;
      }

      // Wait a bit for initial replication after database opening
      await new Promise((resolve) => setTimeout(resolve, 3000));
      bobTodos = await bobDatabase.all();

      updateLastResult(
        "bob",
        "success",
        `Bob ready - connected to Alice and opened shared database with ${bobTodos.length} replicated todos`,
        {
          bobOrbitDBId: bobOrbitDB.id,
          bobIdentityId: bobOrbitDB.identity.id,
          bobDatabaseAddress: bobDatabase.address,
          sharedAddress: sharedDatabaseAddress,
          bobPeerId: bobLibp2p.peerId.toString(),
          replicatedTodos: bobTodos.length,
          addressesMatch: bobDatabase.address === sharedDatabaseAddress,
          bobAddressesReady: bobAddressReady,
          connectionEstablished: connected,
          connectionVerified: connectionVerified,
          identityType: bobIdentity?.type || identityMethod,
          flowOrder:
            "1.Created OrbitDB -> 2.Got Addresses -> 3.Connected Alice -> 4.Verified Connection -> 5.Opened Database",
        },
      );

      bobStep =
        "Bob ready - connected to Alice and opened shared database for replication";
    } catch (error) {
      console.error("❌ Bob initialization failed:", error);
      bobError = error.message;
      bobStep = `Bob initialization failed: ${error.message}`;
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

      console.log("📋 Before adding - Bob todos:", bobTodos.length);
      if (aliceDatabase) {
        const aliceDataBefore = await aliceDatabase.all();
        console.log("📋 Before adding - Alice todos:", aliceDataBefore.length);
      }

      // Test write operation
      console.log("📝 Bob attempting to write todo to shared database...");
      await bobDatabase.put(bobTodo.id, bobTodo);
      console.log("✅ Bob added todo (should replicate to Alice):", bobTodo);

      // Wait a bit for replication
      console.log("⏳ Waiting for replication events...");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      bobTodos = await bobDatabase.all();
      if (aliceDatabase) {
        aliceTodos = await aliceDatabase.all();
      }

      addResult(
        "bob",
        "Replication Test",
        "success",
        "Bob added todo - should appear in Alice's database via replication",
        {
          todoAdded: bobTodo,
          bobTodos: bobTodos.length,
          aliceTodos: aliceTodos.length,
        },
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

  async function completeTodos() {
    if (bobRunning || !bobDatabase) return;

    bobRunning = true;
    bobStep = "Completing assigned todos...";

    try {
      addResult(
        "bob",
        "Complete Todos",
        "running",
        "Bob is completing todos assigned to him in the shared database...",
      );

      // Get all todos from the shared database
      const allTodos = await bobDatabase.all();
      console.log(`   📄 Found ${allTodos.length} todos in shared database`);

      // Find todos assigned to Bob
      const bobsTodos = allTodos.filter(
        (todo) =>
          todo.value.assignee === bobIdentity.id && !todo.value.completed,
      );

      console.log(
        `   🎯 Bob has ${bobsTodos.length} incomplete assigned todos`,
      );

      if (bobsTodos.length === 0) {
        updateLastResult(
          "bob",
          "success",
          "No incomplete todos assigned to Bob",
          { todosFound: allTodos.length, bobsTodos: 0 },
        );
        return;
      }

      // Complete each of Bob's assigned todos
      let completedCount = 0;
      for (const todoRecord of bobsTodos) {
        const todo = { ...todoRecord.value };
        todo.completed = true;
        todo.completedAt = new Date().toISOString();
        todo.completedBy = bobIdentity.id;

        console.log(`   ✅ Bob completing todo: "${todo.text}"`);

        // Update the todo in the shared database
        await bobDatabase.put(todo.id, todo);
        completedCount++;

        console.log(`   💾 Updated todo ${todo.id} in shared database`);
      }

      // Wait a moment for replication
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify the updates
      const updatedTodos = await bobDatabase.all();
      bobTodos = updatedTodos;
      if (aliceDatabase) {
        aliceTodos = await aliceDatabase.all();
      }

      const completedByBob = updatedTodos.filter(
        (todo) => todo.value.completedBy === bobIdentity.id,
      );

      updateLastResult(
        "bob",
        "success",
        `Bob completed ${completedCount} todos in shared database`,
        {
          todosCompleted: completedCount,
          totalTodos: updatedTodos.length,
          completedByBob: completedByBob.length,
          completedTodos: completedByBob.map((t) => ({
            id: t.value.id,
            text: t.value.text,
            completedAt: t.value.completedAt,
          })),
        },
      );

      bobStep = "Bob completed todos - changes should replicate to Alice";
    } catch (error) {
      console.error(`❌ Bob failed to complete todos: ${error.message}`);
      bobError = error.message;
      bobStep = `Failed to complete todos: ${error.message}`;
      updateLastResult("bob", "Complete Todos", "error", error.message);
    } finally {
      bobRunning = false;
    }
  }

  async function backupWithDelegation() {
    if (bobRunning || !bobOrbitDB || !storachaDelegation) return;

    bobRunning = true;
    bobStep = "Backing up to Storacha with delegation...";

    try {
      addResult(
        "bob",
        "Backup with Delegation",
        "running",
        "Bob is backing up Alice's updated database to Storacha using his delegation...",
      );

      // Get Alice's database reference from Bob's results
      const aliceDBResult = bobResults.find((r) => r.aliceDatabase);
      if (!aliceDBResult) {
        throw new Error("Could not find Alice's database reference");
      }

      const aliceDBForBob = aliceDBResult.aliceDatabase;
      console.log(
        `📦 Bob backing up Alice's database: ${aliceDBForBob.address}`,
      );

      // Create Storacha client with Bob's delegation
      let bobStorachaClient;
      if (storachaDelegation.isFallback && storachaDelegation.tempPrincipal) {
        // Fallback: use the temporary principal created for Bob
        console.log("   🔄 Using fallback delegation with temp principal");
        const { StoreMemory } = await import("@storacha/client/stores/memory");
        const Client = await import("@storacha/client");

        const store = new StoreMemory();
        bobStorachaClient = await Client.create({
          principal: storachaDelegation.tempPrincipal,
          store,
        });

        // Parse and add the delegation
        const Delegation = await import("@le-space/ucanto-client");
        const delegationBytes = Buffer.from(
          storachaDelegation.delegationToken,
          "base64",
        );
        const delegation = await Delegation.extract(delegationBytes);

        if (delegation.ok) {
          const space = await bobStorachaClient.addSpace(delegation.ok);
          await bobStorachaClient.setCurrentSpace(space.did());
          console.log("   ✅ Bob's delegation client ready with space access");
        } else {
          throw new Error("Failed to parse delegation token");
        }
      } else {
        // Direct delegation to Bob's DID (preferred approach)
        console.log("   🔑 Using direct delegation to Bob's DID");
        // In this case, Bob would need to create a client with his existing identity
        // and add the delegation - this requires more complex key derivation
        throw new Error(
          "Direct DID delegation not yet implemented - using fallback",
        );
      }

      // Create bridge with Bob's delegated Storacha access
      const bridgeCredentials = {
        method: "ucan",
        ucanClient: bobStorachaClient,
        spaceDID: bobStorachaClient.currentSpace()?.did(),
      };

      const bridge = createStorachaBridge(bridgeCredentials);

      // Backup Alice's database using Bob's delegated access
      const backupResult = await bridge.backupLogEntriesOnly(
        bobOrbitDB, // Bob's OrbitDB instance
        aliceDBForBob.address, // Alice's database address
        {
          dbConfig: {
            type: "keyvalue",
            create: true,
            sync: true,
            accessController: UCANOrbitDBAccessController({
              write: [sharedIdentity.id, bobIdentity.id],
              storachaClient: bobStorachaClient,
            }),
          },
          timeout: 60000,
        },
      );

      if (!backupResult.success) {
        throw new Error(`Backup failed: ${backupResult.error}`);
      }

      updateLastResult(
        "bob",
        "success",
        `Bob successfully backed up Alice's database using delegation`,
        {
          manifestCID: backupResult.manifestCID,
          databaseAddress: backupResult.databaseAddress,
          blocksTotal: backupResult.blocksTotal,
          blocksUploaded: backupResult.blocksUploaded,
          delegationType: storachaDelegation.isFallback ? "fallback" : "direct",
          bobIdentity: bobIdentity.id,
        },
      );

      bobStep = "Bob backup complete - Alice can now restore";
    } catch (error) {
      console.error(`❌ Bob's backup with delegation failed: ${error.message}`);
      bobError = error.message;
      bobStep = `Backup failed: ${error.message}`;
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
      const identityInfo = `his own ${identityMethod} identity`;

      addResult(
        "bob",
        "Restore",
        "running",
        `Restoring database from Storacha backup using ${identityInfo}...`,
      );

      // Bob always uses his own separate identity
      const identityForAccess = bobIdentity;

      const databaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: UCANOrbitDBAccessController({
          write: [identityForAccess.id], // Use the appropriate identity ID
          storachaClient: storachaClient,
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
          usingSeparateIdentity: true,
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

  // Alice's drop and restore function
  async function revokeAccess() {
    if (aliceRunning || !aliceUCANAccessController || !bobIdentity) return;

    aliceRunning = true;
    aliceStep = "Revoking Bob's access...";

    try {
      addResult(
        "alice",
        "Revoke Access",
        "running",
        "Alice is revoking Bob's access to her database...",
      );

      console.log(`🚫 Revoking access for Bob: ${bobIdentity.id}`);

      // Revoke Bob's write access
      await aliceUCANAccessController.revoke("write", bobIdentity.id);
      console.log(`   ✅ Revoked write access for Bob`);

      // Revoke the Storacha delegation using UCAN service
      const revoked = ucanService.revokeDelegation(bobIdentity.id);
      storachaDelegation = null;
      console.log(
        `   🗑️ ${revoked ? "Revoked and cleared" : "Cleared"} Storacha delegation reference`,
      );

      updateLastResult(
        "alice",
        "success",
        "Successfully revoked Bob's access and delegation",
        {
          revokedIdentity: bobIdentity.id,
          revokedAt: new Date().toISOString(),
          note: "Bob's UCAN token remains valid until expiration (1 hour)",
        },
      );

      aliceStep = "Bob's access revoked - UCAN token expires in 1 hour";
    } catch (error) {
      console.error(`❌ Failed to revoke access: ${error.message}`);
      aliceError = error.message;
      aliceStep = `Failed to revoke access: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  async function dropAndRestoreAlice() {
    if (aliceRunning || !aliceDatabase) return;

    aliceRunning = true;
    aliceStep = "Dropping database and restoring from Storacha...";

    try {
      addResult(
        "alice",
        "Drop & Restore",
        "running",
        "Alice is dropping her local database and restoring from Storacha...",
      );

      // Store backup result reference
      const currentBackupResult = backupResult;
      if (!currentBackupResult) {
        throw new Error("No backup available to restore from");
      }

      console.log(`\n🗑️ Step 1: Dropping Alice's local database...`);

      // Close and cleanup Alice's current database
      await aliceDatabase.close();
      await aliceOrbitDB.stop();
      await aliceHelia.stop();
      await aliceLibp2p.stop();

      console.log(`   ✅ Alice's local database and OrbitDB instance stopped`);

      // Clear Alice's state
      aliceOrbitDB = null;
      aliceDatabase = null;
      aliceHelia = null;
      aliceLibp2p = null;
      aliceTodos = [];
      aliceUCANAccessController = null;

      console.log(
        `\n🆕 Step 2: Creating new clean OrbitDB instance for Alice...`,
      );

      // Create fresh OrbitDB instance for Alice
      const newDatabaseConfig = {
        type: "keyvalue",
        create: true,
        sync: true,
        accessController: UCANOrbitDBAccessController({
          write: [sharedIdentity.id],
          storachaClient: storachaClient,
        }),
      };

      const newInstance = await createOrbitDBInstance(
        "alice",
        "restore",
        "alice-todos-restored", // New clean database name
        newDatabaseConfig,
        true, // Open database immediately
      );

      // Get instances from OrbitDB service
      const alicePeer = orbitDBService.getPeer("alice");
      aliceOrbitDB = alicePeer.orbitdb;
      aliceDatabase = alicePeer.database;
      aliceHelia = alicePeer.helia;
      aliceLibp2p = alicePeer.libp2p;
      aliceUCANAccessController = aliceDatabase.access;

      console.log(`   ✅ New clean Alice OrbitDB instance created`);
      console.log(`   📊 New database address: ${aliceDatabase.address}`);

      console.log(`\n📥 Step 3: Restoring from Storacha space...`);

      // Create bridge for restore
      const bridge = createStorachaBridge(storachaCredentials);

      // Restore from Storacha space (this will find the backup Bob made)
      const restoreResult = await bridge.restoreLogEntriesOnly(aliceOrbitDB, {
        dbName: "alice-todos-restored",
        dbConfig: newDatabaseConfig,
        timeout: 120000,
      });

      if (!restoreResult.success) {
        throw new Error(`Restore failed: ${restoreResult.error}`);
      }

      console.log(`   ✅ Restore successful`);

      // Get the restored database
      const restoredDatabase = restoreResult.database;

      // Wait for indexing
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const restoredTodos = await restoredDatabase.all();

      console.log(`\n🔍 Step 4: Verifying restored todos...`);
      console.log(`   📊 Restored ${restoredTodos.length} todos`);

      // Check for todos completed by Bob
      const todosCompletedByBob = restoredTodos.filter(
        (todo) => todo.value.completedBy === bobIdentity?.id,
      );

      console.log(
        `   🎯 Found ${todosCompletedByBob.length} todos completed by Bob`,
      );

      if (todosCompletedByBob.length > 0) {
        todosCompletedByBob.forEach((todo) => {
          console.log(
            `     ✅ "${todo.value.text}" completed at ${todo.value.completedAt}`,
          );
        });
      }

      // Update Alice's todos state
      aliceTodos = restoredTodos;

      updateLastResult(
        "alice",
        "success",
        `Alice successfully restored database with ${restoredTodos.length} todos (${todosCompletedByBob.length} completed by Bob)`,
        {
          originalDatabase: "alice-todos",
          restoredDatabase: "alice-todos-restored",
          newDatabaseAddress: aliceDatabase.address,
          totalTodos: restoredTodos.length,
          todosCompletedByBob: todosCompletedByBob.length,
          completedTodos: todosCompletedByBob.map((t) => ({
            id: t.value.id,
            text: t.value.text,
            completedAt: t.value.completedAt,
            completedBy: t.value.completedBy,
          })),
          restoredAt: new Date().toISOString(),
        },
      );

      aliceStep = "Alice database restored with Bob's completed todos";
    } catch (error) {
      console.error(`❌ Alice drop and restore failed: ${error.message}`);
      aliceError = error.message;
      aliceStep = `Drop and restore failed: ${error.message}`;
      updateLastResult("alice", "error", error.message);
    } finally {
      aliceRunning = false;
    }
  }

  // Cleanup functions
  async function cleanup() {
    console.log("🧹 Cleaning up all instances...");

    // Use OrbitDB service for cleanup
    await orbitDBService.cleanup();
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
    bobIdentity = null;
    bobIdentities = null;

    sharedIdentity = null;
    sharedIdentities = null;
    sharedWebAuthnCredential = null;
    backupResult = null;
    restoreResult = null;
    storachaTestDatabaseAddresses.clear();

    // Clear all UCAN delegations
    ucanService.clearAllDelegations();
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

  // Old DefaultLibp2pBrowserOptions removed - now using p2p.js module
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
        {#if webAuthnStatus.checking}
          <div
            style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;"
          >
            <Loading withOverlay={false} small />
            <span style="font-size:0.875rem;">Checking WebAuthn support...</span
            >
          </div>
        {:else}
          <InlineNotification
            kind={webAuthnStatus.supported
              ? webAuthnStatus.platformAvailable
                ? "success"
                : "info"
              : "warning"}
            title={webAuthnStatus.supported
              ? "WebAuthn Supported"
              : "WebAuthn Not Available"}
            subtitle={webAuthnStatus.message}
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
            disabled={!webAuthnStatus.supported}
          />
        </RadioButtonGroup>

        {#if identityMethod === "webauthn" && webAuthnStatus.supported}
          <div
            style="margin-top:1rem;padding:1rem;background:var(--cds-layer-accent);border-radius:0.25rem;"
          >
            <div
              style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;"
            >
              <Fingerprint size={16} />
              <strong style="font-size:0.875rem;">WebAuthn Benefits:</strong>
            </div>
            <ul
              style="font-size:0.875rem;color:var(--cds-text-secondary);margin:0;padding-left:1rem;"
            >
              <li>Private keys never leave secure hardware</li>
              <li>Face ID, Touch ID, or Windows Hello authentication</li>
              <li>No seed phrases to manage or lose</li>
              <li>Quantum-resistant when using modern authenticators</li>
            </ul>
          </div>
        {:else if identityMethod === "mnemonic"}
          <div
            style="margin-top:1rem;padding:1rem;background:var(--cds-layer-accent);border-radius:0.25rem;"
          >
            <div
              style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;"
            >
              <Key size={16} />
              <strong style="font-size:0.875rem;"
                >Mnemonic Seed Benefits:</strong
              >
            </div>
            <ul
              style="font-size:0.875rem;color:var(--cds-text-secondary);margin:0;padding-left:1rem;"
            >
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

  <!-- UCAN Delegation Method Configuration -->
  <Row>
    <Column>
      <Tile style="margin-bottom:2rem;">
        <h4 style="font-size:1rem;font-weight:600;margin-bottom:1rem;">
          🌉 UCAN Delegation Method
        </h4>
        <div
          style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;"
        >
          <span style="font-size:0.875rem;font-weight:500;">
            Delegation Signing Method:
          </span>
          <Toggle
            size="sm"
            labelText=""
            toggled={useBridgeDelegation}
            on:toggle={() => (useBridgeDelegation = !useBridgeDelegation)}
            disabled={aliceRunning || bobRunning || storachaDelegation}
          >
            {useBridgeDelegation ? "P-256 Bridge" : "Direct EdDSA"}
          </Toggle>
        </div>
        <p style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;">
          {#if useBridgeDelegation}
            🌉 <strong>Bridge Delegation:</strong> Alice's Storacha EdDSA agent delegates
            to Alice's P-256 OrbitDB identity, then Alice's P-256 identity delegates
            to Bob's P-256 identity. Final delegation is P-256 signed.
          {:else}
            📤 <strong>Direct EdDSA:</strong> Alice's Storacha EdDSA agent delegates
            directly to Bob's P-256 OrbitDB identity. Final delegation is EdDSA signed.
          {/if}
        </p>
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
          <img
            src="/orbitdb.png"
            alt="OrbitDB"
            style="width:32px;height:32px;object-fit:contain;"
          />
          <h3 style="font-size:1.25rem;font-weight:bold;margin:0;">
            Alice & Bob Backup/Restore Demo with {identityMethod === "webauthn"
              ? "WebAuthn"
              : "Mnemonic"}
          </h3>
        </div>
        <p style="color:var(--cds-text-secondary);margin:0;">
          Alice creates a shared OrbitDB with WebAuthn identity and adds todos.
          Bob connects via P2P, opens the shared database, and data replicates
          in real-time. Both can add/modify todos with instant P2P
          synchronization, plus backup to Storacha using UCAN delegation.
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
              <div
                style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;"
              >
                <div style="display:flex;align-items:center;gap:0.5rem;">
                  <CloudUpload size={16} />
                  <h5 style="font-size:0.875rem;font-weight:600;margin:0;">
                    Upload Progress
                  </h5>
                </div>
                <span
                  style="font-size:0.875rem;color:var(--cds-text-secondary);"
                >
                  {uploadProgress.current}/{uploadProgress.total} ({uploadProgress.percentage}%)
                </span>
              </div>

              <div
                style="width:100%;background-color:var(--cds-layer-accent);border-radius:0.25rem;overflow:hidden;height:0.5rem;"
              >
                <div
                  style="width:{uploadProgress.percentage}%;background-color:var(--cds-support-info);height:100%;transition:width 0.3s ease;"
                ></div>
              </div>

              {#if uploadProgress.currentBlock}
                <div
                  style="margin-top:0.5rem;font-size:0.75rem;color:var(--cds-text-secondary);"
                >
                  Current block: <code
                    >{uploadProgress.currentBlock.hash?.slice(0, 16)}...</code
                  >
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
              <div
                style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;"
              >
                <div style="display:flex;align-items:center;gap:0.5rem;">
                  <CloudDownload size={16} />
                  <h5 style="font-size:0.875rem;font-weight:600;margin:0;">
                    Download Progress
                  </h5>
                </div>
                <span
                  style="font-size:0.875rem;color:var(--cds-text-secondary);"
                >
                  {downloadProgress.current}/{downloadProgress.total} ({downloadProgress.percentage}%)
                </span>
              </div>

              <div
                style="width:100%;background-color:var(--cds-layer-accent);border-radius:0.25rem;overflow:hidden;height:0.5rem;"
              >
                <div
                  style="width:{downloadProgress.percentage}%;background-color:var(--cds-support-success);height:100%;transition:width 0.3s ease;"
                ></div>
              </div>

              {#if downloadProgress.currentBlock}
                <div
                  style="margin-top:0.5rem;font-size:0.75rem;color:var(--cds-text-secondary);"
                >
                  Current file: <code
                    >{downloadProgress.currentBlock.storachaCID?.slice(
                      0,
                      16,
                    )}...</code
                  >
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
    <Column sm={16} md={16} lg={8} xl={8} style="margin-bottom: 1rem;">
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
            Alice (Data Creator) - {identityMethod === "webauthn"
              ? "Biometric"
              : "Mnemonic"}
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
            icon={aliceRunning
              ? undefined
              : identityMethod === "webauthn"
                ? Fingerprint
                : DataBase}
            on:click={initializeAlice}
            disabled={aliceRunning || aliceOrbitDB || !storachaAuthenticated}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Alice ({identityMethod === "webauthn"
              ? "Biometric Auth"
              : "Mnemonic"})
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

          <Button
            size="sm"
            kind="danger-tertiary"
            icon={aliceRunning ? undefined : Shield}
            on:click={revokeAccess}
            disabled={aliceRunning ||
              !aliceUCANAccessController ||
              !bobIdentity ||
              !storachaDelegation}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            4. Revoke Bob's Access
          </Button>

          <Button
            size="sm"
            kind="danger-tertiary"
            icon={aliceRunning ? undefined : Reset}
            on:click={dropAndRestoreAlice}
            disabled={aliceRunning || !backupResult || !storachaAuthenticated}
            style="width:100%;"
          >
            {#if aliceRunning}<Loading withOverlay={false} small />{/if}
            5. Drop DB & Restore from Storacha
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
    <Column sm={16} md={16} lg={8} xl={8}>
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
            Bob (P2P Replication) - {identityMethod === "webauthn"
              ? "Biometric"
              : "Mnemonic"}
          </h4>
        </div>

        <!-- Bob always uses his own separate identity for cross-identity data sharing -->
        <InlineNotification
          kind="info"
          title="Identity Configuration"
          subtitle="Bob creates his own {identityMethod === 'webauthn'
            ? 'biometric'
            : 'mnemonic'} identity to demonstrate cross-identity data sharing with UCAN delegation."
          style="margin-bottom:1rem;"
        />

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

        <!-- DEBUG: Bob Button State -->
        <div
          style="font-size:0.75rem;color:var(--cds-text-secondary);margin-bottom:0.5rem;padding:0.5rem;background:rgba(0,0,0,0.05);border-radius:4px;"
        >
          <strong>🔍 Bob Button Debug:</strong><br />
          • bobRunning: {bobRunning ? "❌" : "✅"}<br />
          • bobOrbitDB exists: {bobOrbitDB
            ? "❌ already exists"
            : "✅ ready to create"}<br />
          • storachaAuthenticated: {storachaAuthenticated ? "✅" : "❌"}<br />
          • aliceDatabase: {aliceDatabase ? "✅" : "❌"}<br />
          • bobIdentity: {bobIdentity ? "✅" : "❌"}<br />
          •
          <strong
            >storachaDelegation: {storachaDelegation
              ? "✅ ready"
              : '❌ MISSING ← Alice needs to click "Add Todos"!'}</strong
          >
        </div>

        <!-- Bob's Actions -->
        <div
          style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1rem;"
        >
          <Button
            size="sm"
            kind="secondary"
            icon={bobRunning
              ? undefined
              : identityMethod === "webauthn"
                ? Fingerprint
                : DataBase}
            on:click={initializeBob}
            disabled={bobRunning ||
              bobOrbitDB ||
              !storachaAuthenticated ||
              !aliceDatabase ||
              !bobIdentity ||
              !storachaDelegation}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            1. Initialize Bob & Open Alice's DB
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : Add}
            on:click={addBobTodo}
            disabled={bobRunning || !bobDatabase}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            2. Add Todo (Test Replication)
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : Checkmark}
            on:click={completeTodos}
            disabled={bobRunning || !bobDatabase}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            3. Complete Assigned Todos
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            icon={bobRunning ? undefined : CloudUpload}
            on:click={backupWithDelegation}
            disabled={bobRunning || !bobDatabase || !storachaDelegation}
            style="width:100%;"
          >
            {#if bobRunning}<Loading withOverlay={false} small />{/if}
            4. Backup to Storacha (Delegated)
          </Button>
        </div>

        <!-- P2P Connection Status -->
        {#if replicationEnabled}
          <div style="margin-bottom:1rem;">
            <div
              style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;"
            >
              {#if peersConnected}
                <div
                  style="width:8px;height:8px;border-radius:50%;background-color:var(--cds-support-success);"
                ></div>
                <span
                  style="font-size:0.75rem;color:var(--cds-support-success);"
                  >P2P Connected</span
                >
              {:else if aliceLibp2p && bobLibp2p}
                <div
                  style="width:8px;height:8px;border-radius:50%;background-color:var(--cds-support-warning);"
                ></div>
                <span
                  style="font-size:0.75rem;color:var(--cds-support-warning);"
                  >Connecting...</span
                >
              {:else}
                <div
                  style="width:8px;height:8px;border-radius:50%;background-color:var(--cds-support-error);"
                ></div>
                <span style="font-size:0.75rem;color:var(--cds-support-error);"
                  >Not Connected</span
                >
              {/if}
              <span style="font-size:0.75rem;color:var(--cds-text-secondary);"
                >| Alice: {aliceConnectedPeers.length} peers • Bob: {bobConnectedPeers.length}
                peers
              </span>
            </div>
            {#if replicationEvents.length > 0}
              <div style="font-size:0.625rem;color:var(--cds-text-helper);">
                Last event: {replicationEvents[replicationEvents.length - 1]
                  .type} • {replicationEvents.length} total
              </div>
            {/if}
          </div>
        {/if}

        <!-- Delegation Status Indicator -->
        {#if !storachaDelegation}
          <InlineNotification
            kind="info"
            title="Waiting"
            subtitle="Waiting for Alice to grant access and create delegation..."
            style="margin-bottom:1rem;"
          />
        {:else if !aliceDatabase}
          <InlineNotification
            kind="warning"
            title="Dependencies Missing"
            subtitle="Alice must complete setup first"
            style="margin-bottom:1rem;"
          />
        {:else}
          <InlineNotification
            kind="success"
            title="Ready"
            subtitle="Bob has access delegation from Alice"
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
                  <span
                    style="margin-left:auto;font-size:0.625rem;color:var(--cds-text-secondary);"
                  >
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
          <div
            style="margin-top:1rem;padding:0.5rem;background:var(--cds-layer-01);border-radius:0.25rem;"
          >
            <p
              style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;text-align:center;"
            >
              📊 {bobTodos.length} restored todos • {bobResults.length} progress
              items
              {#if bobTodos.length > 0}
                • Identity: 🆔 Own {identityMethod}
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
          title="Success! P2P Replication Working 🎆"
          subtitle={`Alice created ${aliceTodos.length} todos using ${identityMethod === "webauthn" ? "biometric authentication" : "mnemonic seed"}. Bob connected via P2P and both databases show ${bobTodos.length} synchronized todos with real-time replication!`}
          style="margin-top:2rem;"
        >
          {#if backupResult && restoreResult}
            <p style="font-size:0.75rem;margin-top:0.5rem;">
              Backup: {backupResult.blocksUploaded}/{backupResult.blocksTotal} blocks
              • Restore: {restoreResult.entriesRecovered} entries recovered • Identity:
              Separate (${identityMethod}) - Cross-identity sharing • Method: {identityMethod ===
              "webauthn"
                ? "🔐 Hardware-Secured Biometric"
                : "🔑 Mnemonic Seed Phrase"}
            </p>
          {/if}
        </InlineNotification>
      </Column>
    </Row>
  {/if}
</Grid>
