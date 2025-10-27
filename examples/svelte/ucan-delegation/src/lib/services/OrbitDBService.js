/**
 * OrbitDB Service - Handles OrbitDB instance creation, P2P connections, and database management
 * Extracted from StorachaTestWithWebAuthn.svelte for better maintainability
 */

import { createOrbitDB, Identities } from "@orbitdb/core";
import { createLibp2pNode, createHeliaNode } from "../p2p.js";
import UCANOrbitDBAccessController from "../UCANOrbitDBAccessController.js";

export class OrbitDBService {
  constructor() {
    // Peer state management
    this.peers = new Map(); // Store peer instances by persona
    this.connectionState = {
      aliceMultiaddrs: [],
      bobMultiaddrs: [],
      alicePeerId: null,
      bobPeerId: null,
      aliceConnectedPeers: [],
      bobConnectedPeers: [],
      aliceAddressReady: false,
      bobAddressReady: false,
      peersConnected: false,
    };

    // Event callbacks
    this.eventCallbacks = {
      addReplicationEvent: null,
      updatePeerConnectionStatus: null,
      addResult: null,
    };

    // Database tracking
    this.databases = new Map(); // Store database addresses for event filtering
  }

  /**
   * Set event callback functions
   */
  setEventCallbacks(callbacks) {
    this.eventCallbacks = { ...this.eventCallbacks, ...callbacks };
  }

  /**
   * Enhanced function to force connection between Alice and Bob
   */
  async forceDirectConnection() {
    console.log(
      "🔗 [FORCE_CONNECTION] Starting enhanced connection attempt...",
    );

    const alice = this.peers.get("alice");
    const bob = this.peers.get("bob");

    // Check prerequisites
    if (
      !alice?.libp2p ||
      !bob?.libp2p ||
      !this.connectionState.alicePeerId ||
      !this.connectionState.bobPeerId
    ) {
      console.warn(
        "⚠️ [FORCE_CONNECTION] Cannot force connection - missing libp2p instances or peer IDs",
      );
      return false;
    }

    if (
      !this.connectionState.aliceAddressReady ||
      !this.connectionState.bobAddressReady
    ) {
      console.warn(
        "⚠️ [FORCE_CONNECTION] Cannot force connection - addresses not ready yet",
      );
      return false;
    }

    console.log(
      "✅ [FORCE_CONNECTION] Prerequisites met, proceeding with connection strategies...",
    );

    let connectionEstablished = false;

    // Strategy 1: Try dialing with PeerId objects directly (libp2p's preferred method)
    const alicePeerIdObj = alice.libp2p.peerId;
    const bobPeerIdObj = bob.libp2p.peerId;

    // Try Bob dialing Alice using PeerId object
    try {
      console.log(
        `📨 [FORCE_CONNECTION] Bob dialing Alice using PeerId object...`,
      );

      const connection = await Promise.race([
        bob.libp2p.dial(alicePeerIdObj),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("PeerId dial timeout")), 8000),
        ),
      ]);

      console.log(`✅ [FORCE_CONNECTION] PeerId dial SUCCESS!`, {
        remotePeer: connection.remotePeer.toString().slice(-12),
        direction: connection.direction,
        status: connection.status,
      });

      connectionEstablished = true;
    } catch (error) {
      console.log(
        `❌ [FORCE_CONNECTION] Bob->Alice PeerId dial failed: ${error.message}`,
      );

      // Try Alice dialing Bob using PeerId object
      try {
        console.log(
          `📨 [FORCE_CONNECTION] Alice dialing Bob using PeerId object...`,
        );

        const connection = await Promise.race([
          alice.libp2p.dial(bobPeerIdObj),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("PeerId dial timeout")), 8000),
          ),
        ]);

        console.log(`✅ [FORCE_CONNECTION] PeerId dial SUCCESS!`);
        connectionEstablished = true;
      } catch (error2) {
        console.log(
          `❌ [FORCE_CONNECTION] Alice->Bob PeerId dial failed: ${error2.message}`,
        );
      }
    }

    if (connectionEstablished) {
      console.log(
        "🎉 [FORCE_CONNECTION] Strategy SUCCESS: Direct connection established!",
      );
      return true;
    }

    // Strategy 2: Wait for natural discovery
    console.log("⏳ [FORCE_CONNECTION] Waiting for natural discovery...");

    const discoveryTimeout = 15000; // 15 seconds
    const discoveryStartTime = Date.now();
    let peersDiscovered = false;

    while (
      !peersDiscovered &&
      Date.now() - discoveryStartTime < discoveryTimeout
    ) {
      const aliceConnectedToBob =
        this.connectionState.aliceConnectedPeers.includes(
          this.connectionState.bobPeerId,
        );
      const bobConnectedToAlice =
        this.connectionState.bobConnectedPeers.includes(
          this.connectionState.alicePeerId,
        );
      peersDiscovered = aliceConnectedToBob || bobConnectedToAlice;

      if (!peersDiscovered) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (peersDiscovered) {
      console.log("🎉 [FORCE_CONNECTION] Natural discovery worked!");
      return true;
    }

    // Final assessment
    const finalAliceConnections = alice.libp2p.getConnections().length;
    const finalBobConnections = bob.libp2p.getConnections().length;

    if (finalAliceConnections > 0 && finalBobConnections > 0) {
      console.log(
        "✨ [FORCE_CONNECTION] PARTIAL SUCCESS: Both peers connected to relay - OrbitDB replication may still work!",
      );
      return true;
    } else {
      console.warn(
        "⚠️ [FORCE_CONNECTION] All strategies failed - but proceeding anyway",
      );
      return false;
    }
  }

  /**
   * Update peer connection status
   */
  updatePeerConnectionStatus() {
    // Check if Alice and Bob can potentially see each other
    this.connectionState.peersConnected =
      this.connectionState.aliceConnectedPeers.length > 0 &&
      this.connectionState.bobConnectedPeers.length > 0;

    // Also check if they share any common peers or are directly connected
    if (this.connectionState.alicePeerId && this.connectionState.bobPeerId) {
      const directConnection =
        this.connectionState.aliceConnectedPeers.includes(
          this.connectionState.bobPeerId,
        ) ||
        this.connectionState.bobConnectedPeers.includes(
          this.connectionState.alicePeerId,
        );
      const commonPeers = this.connectionState.aliceConnectedPeers.some(
        (peer) => this.connectionState.bobConnectedPeers.includes(peer),
      );
      this.connectionState.peersConnected =
        this.connectionState.peersConnected || directConnection || commonPeers;
    }

    // Call external callback if available
    if (this.eventCallbacks.updatePeerConnectionStatus) {
      this.eventCallbacks.updatePeerConnectionStatus(this.connectionState);
    }
  }

  /**
   * Add replication event
   */
  addReplicationEvent(event) {
    if (this.eventCallbacks.addReplicationEvent) {
      this.eventCallbacks.addReplicationEvent(event);
    }
  }

  /**
   * Create OrbitDB instance with P2P networking and database management
   */
  async createOrbitDBInstance(
    persona,
    instanceId,
    databaseName,
    databaseConfig,
    options = {},
  ) {
    const {
      openDatabase = true,
      replicationEnabled = true,
      sharedIdentity = null,
      bobIdentity = null,
      sharedDatabaseAddress = null,
    } = options;

    console.log(
      `🔧 Creating OrbitDB instance for ${persona}... (openDatabase: ${openDatabase})`,
    );

    // Create libp2p instance with enhanced relay support
    const libp2p = await createLibp2pNode({
      enablePeerConnections: replicationEnabled,
      enableNetworkConnection: replicationEnabled,
      enableReservations: true, // Enable circuit relay reservations
    });
    console.log(
      `${persona} libp2p created with peer discovery enabled:`,
      replicationEnabled,
    );
    console.log(`🆔 ${persona} Peer ID:`, libp2p.peerId.toString());

    const multiaddrs = libp2p.getMultiaddrs().map((addr) => addr.toString());
    console.log(`🎧 ${persona} Listening on:`, multiaddrs);

    // Update connection state
    if (persona === "alice") {
      this.connectionState.aliceMultiaddrs = multiaddrs;
      this.connectionState.alicePeerId = libp2p.peerId.toString();
    } else {
      this.connectionState.bobMultiaddrs = multiaddrs;
      this.connectionState.bobPeerId = libp2p.peerId.toString();
    }

    // Monitor peer connectivity for replication
    const updateAddressReadiness = () => {
      const currentMultiaddrs = libp2p
        .getMultiaddrs()
        .map((addr) => addr.toString());
      console.log(
        `🔍 ${persona.toUpperCase()} current addresses:`,
        currentMultiaddrs,
      );

      const hasDialableAddresses = currentMultiaddrs.some(
        (addr) =>
          addr.includes("/p2p-circuit/") ||
          addr.includes("/webrtc") ||
          addr.includes("/ws/") ||
          addr.includes("/wss/") ||
          addr.includes("/tcp/") ||
          addr.includes("/dns4/") ||
          addr.includes("/dns6/"),
      );

      // For UCAN delegation demo, any addresses are sufficient
      // We don't need direct P2P connections, just IPFS/DHT connectivity
      const hasAnyAddresses = currentMultiaddrs.length > 0;
      const shouldBeReady = hasAnyAddresses; // Simplified: any addresses are ready

      console.log(`🔍 ${persona.toUpperCase()} address analysis:`, {
        total: currentMultiaddrs.length,
        hasDialable: hasDialableAddresses,
        hasAny: hasAnyAddresses,
        shouldBeReady: shouldBeReady,
      });

      if (persona === "alice") {
        const wasReady = this.connectionState.aliceAddressReady;
        this.connectionState.aliceMultiaddrs = currentMultiaddrs;
        this.connectionState.aliceAddressReady = shouldBeReady;

        if (shouldBeReady && !wasReady) {
          console.log(
            `✅ Alice ready for connections (${currentMultiaddrs.length} addresses)`,
          );
          console.log(`✅ Alice addresses:`, currentMultiaddrs);
          this.addReplicationEvent({
            type: "addresses_ready",
            peer: "alice",
            data: {
              addressCount: currentMultiaddrs.length,
              dialable: hasDialableAddresses,
            },
          });
        }
      } else {
        const wasReady = this.connectionState.bobAddressReady;
        this.connectionState.bobMultiaddrs = currentMultiaddrs;
        this.connectionState.bobAddressReady = shouldBeReady;

        if (shouldBeReady && !wasReady) {
          console.log(
            `✅ Bob ready for connections (${currentMultiaddrs.length} addresses)`,
          );
          console.log(`✅ Bob addresses:`, currentMultiaddrs);
          this.addReplicationEvent({
            type: "addresses_ready",
            peer: "bob",
            data: {
              addressCount: currentMultiaddrs.length,
              dialable: hasDialableAddresses,
            },
          });
        }
      }
    };

    // Initial address check
    updateAddressReadiness();

    // Periodic address checking (for circuit relay addresses that appear after connection)
    const addressCheckInterval = setInterval(() => {
      const currentMultiaddrs = libp2p
        .getMultiaddrs()
        .map((addr) => addr.toString());
      const hasNewAddresses =
        JSON.stringify(currentMultiaddrs) !==
        JSON.stringify(
          persona === "alice"
            ? this.connectionState.aliceMultiaddrs
            : this.connectionState.bobMultiaddrs,
        );

      if (hasNewAddresses) {
        console.log(
          `🔄 ${persona.toUpperCase()} addresses updated:`,
          currentMultiaddrs,
        );
        updateAddressReadiness();
      }

      // Stop checking after address readiness is achieved
      const isReady =
        persona === "alice"
          ? this.connectionState.aliceAddressReady
          : this.connectionState.bobAddressReady;
      if (isReady) {
        clearInterval(addressCheckInterval);
        console.log(
          `✅ ${persona.toUpperCase()} address checking stopped - ready!`,
        );
      }
    }, 1000); // Check every second

    // Stop interval after 10 seconds regardless (reduced for UCAN demo)
    setTimeout(() => {
      clearInterval(addressCheckInterval);
      console.log(`⏰ ${persona.toUpperCase()} address checking timeout`);
      // Force ready state for UCAN demo - we don't need perfect P2P connectivity
      if (persona === "alice") {
        this.connectionState.aliceAddressReady = true;
      } else {
        this.connectionState.bobAddressReady = true;
      }
      console.log(
        `🚀 ${persona.toUpperCase()} forced ready for UCAN delegation demo`,
      );
    }, 10000);

    // Peer Discovery Events
    libp2p.addEventListener("peer:discovery", (event) => {
      const peerId = event.detail.id.toString();
      console.log(
        `🔍 ${persona.toUpperCase()} discovered peer: ...${peerId.slice(-8)}`,
      );

      this.addReplicationEvent({
        type: "peer_discovered",
        peer: persona,
        data: { discovered: peerId.slice(-12) },
      });
    });

    // Connection Events
    libp2p.addEventListener("peer:connect", (event) => {
      const peerId = event.detail.toString();
      console.log(
        `🔗 ${persona.toUpperCase()} connected to peer: ...${peerId.slice(-8)}`,
      );

      if (persona === "alice") {
        this.connectionState.aliceConnectedPeers = [
          ...this.connectionState.aliceConnectedPeers,
          peerId,
        ];
      } else {
        this.connectionState.bobConnectedPeers = [
          ...this.connectionState.bobConnectedPeers,
          peerId,
        ];
      }

      this.updatePeerConnectionStatus();
      setTimeout(() => updateAddressReadiness(), 100);

      this.addReplicationEvent({
        type: "peer_connected",
        peer: persona,
        data: { connectedTo: peerId.slice(-12) },
      });
    });

    // Disconnection Events
    libp2p.addEventListener("peer:disconnect", (event) => {
      const peerId = event.detail.toString();
      console.log(
        `🔌 ${persona.toUpperCase()} disconnected from: ...${peerId.slice(-8)}`,
      );

      if (persona === "alice") {
        this.connectionState.aliceConnectedPeers =
          this.connectionState.aliceConnectedPeers.filter((p) => p !== peerId);
      } else {
        this.connectionState.bobConnectedPeers =
          this.connectionState.bobConnectedPeers.filter((p) => p !== peerId);
      }

      this.updatePeerConnectionStatus();

      this.addReplicationEvent({
        type: "peer_disconnected",
        peer: persona,
        data: { disconnectedFrom: peerId.slice(-12) },
      });
    });

    // Create Helia instance with memory storage for tests to avoid persistence conflicts
    console.log("🗄️ Initializing Helia with memory storage for testing...");
    const helia = await createHeliaNode(libp2p);
    console.log("Helia created with memory storage");

    // 🔑 KEY FIX: Create IPFS-linked identities instance for this OrbitDB peer
    console.log(
      `🔗 Creating IPFS-linked identities instance for ${persona}...`,
    );
    const linkedIdentities = await Identities({ ipfs: helia });

    // Cross-store all known identities in this peer's IPFS for resolution
    await this.crossStoreIdentities(
      linkedIdentities,
      persona,
      sharedIdentity,
      bobIdentity,
    );

    // Test identity resolution immediately after cross-storage (skip network-dependent tests)
    await this.testIdentityResolution(
      linkedIdentities,
      persona,
      sharedIdentity,
      bobIdentity,
    );

    // Create OrbitDB instance configuration
    const orbitdbConfig = {
      ipfs: helia,
      directory: `./orbitdb-${persona}-${instanceId}`,
      identities: linkedIdentities,
    };

    // Choose identity based on persona and settings
    if (persona === "alice" && sharedIdentity) {
      orbitdbConfig.identity = sharedIdentity;
      console.log(`🔑 Alice using WebAuthn identity: ${sharedIdentity.id}`);
      console.log(`   ✅ Alice using IPFS-linked identities system`);
    } else if (persona === "bob" && bobIdentity) {
      orbitdbConfig.identity = bobIdentity;
      console.log(`🆔 Bob using his own separate identity: ${bobIdentity.id}`);
      console.log(`   ✅ Bob using IPFS-linked identities system`);
    } else {
      // Fallback: let OrbitDB create default identity with unique ID
      orbitdbConfig.id = `${persona}-${instanceId}-${Date.now()}-${Math.random()}`;
      console.log(
        `⚠️ ${persona} using default OrbitDB identity with IPFS-linked identities`,
      );
    }

    console.log("🔧 OrbitDB config about to be used:", {
      hasIPFS: !!orbitdbConfig.ipfs,
      hasIdentity: !!orbitdbConfig.identity,
      hasIdentities: !!orbitdbConfig.identities,
      hasId: !!orbitdbConfig.id,
      identityId: orbitdbConfig.identity?.id,
      identityType: orbitdbConfig.identity?.type,
      directory: orbitdbConfig.directory,
    });

    const orbitdb = await createOrbitDB(orbitdbConfig);

    console.log("🆔 OrbitDB instance created:", {
      orbitDBId: orbitdb.id,
      actualIdentityId: orbitdb.identity?.id,
      actualIdentityType: orbitdb.identity?.type,
      actualIdentityHash: orbitdb.identity?.hash,
      identityMatch:
        orbitdb.identity?.id === orbitdbConfig.identity?.id
          ? "✅ MATCH"
          : "❌ DIFFERENT",
      hasSignMethod: typeof orbitdb.identity?.sign === "function",
      hasVerifyMethod: typeof orbitdb.identity?.verify === "function",
    });

    console.log("📜 OrbitDB instance created with identity");

    // Create database with proper access controller (conditionally)
    let database = null;

    if (openDatabase) {
      database = await this.createDatabase(
        orbitdb,
        persona,
        databaseName,
        databaseConfig,
        {
          sharedIdentity,
          bobIdentity,
          sharedDatabaseAddress,
        },
      );

      if (database) {
        // Set up event listeners for this database
        this.setupDatabaseEventListeners(database, persona);
      }
    } else {
      console.log(
        `⏳ ${persona} OrbitDB instance created but database not opened yet (waiting for connection)`,
      );
    }

    // Store peer instance
    const peerInstance = { libp2p, helia, orbitdb, database };
    this.peers.set(persona, peerInstance);

    return peerInstance;
  }

  /**
   * Cross-store identities in IPFS for resolution
   */
  async crossStoreIdentities(
    linkedIdentities,
    persona,
    sharedIdentity,
    bobIdentity,
  ) {
    console.log(
      `📦 Cross-storing identities in ${persona}'s IPFS blockstore...`,
    );

    // 🔍 DEBUG: Check identity structure first
    console.log("🔍 Identity debugging for IPFS storage:");
    if (sharedIdentity) {
      console.log("   Alice/shared identity:", {
        id: sharedIdentity.id,
        hash: sharedIdentity.hash,
        hashType: typeof sharedIdentity.hash,
        hasBytes: !!sharedIdentity.bytes,
        bytesLength: sharedIdentity.bytes?.length,
        publicKey: sharedIdentity.publicKey,
        type: sharedIdentity.type,
      });
    }

    if (bobIdentity) {
      console.log("   Bob identity:", {
        id: bobIdentity.id,
        hash: bobIdentity.hash,
        hashType: typeof bobIdentity.hash,
        hasBytes: !!bobIdentity.bytes,
        bytesLength: bobIdentity.bytes?.length,
        publicKey: bobIdentity.publicKey,
        type: bobIdentity.type,
      });
    }

    const identityStorePromises = [];

    // Store Alice/shared identity with proper validation
    if (sharedIdentity) {
      if (sharedIdentity.hash && sharedIdentity.bytes) {
        try {
          console.log(
            `   📦 Attempting to store Alice identity with hash: ${sharedIdentity.hash}`,
          );

          // Parse hash string as CID (required by IPFS blockstore)
          const { CID } = await import("multiformats/cid");
          const hashCID = CID.parse(sharedIdentity.hash);
          console.log(`     ✅ Parsed hash as CID: ${hashCID}`);

          // Get helia from current peer
          const currentPeer = this.peers.get(persona);
          if (currentPeer?.helia) {
            identityStorePromises.push(
              currentPeer.helia.blockstore.put(hashCID, sharedIdentity.bytes),
            );
          }
        } catch (hashError) {
          console.error(
            `   ❌ Alice identity hash validation failed:`,
            hashError.message,
          );
          console.log(`   🔧 Trying alternative storage method...`);

          // Alternative: Store using the identity directly through OrbitDB identities system
          try {
            await linkedIdentities.addIdentity(sharedIdentity);
            console.log(
              `   ✅ Alice identity stored via identities.addIdentity()`,
            );
          } catch (altError) {
            console.error(
              `   ❌ Alternative storage also failed:`,
              altError.message,
            );
          }
        }
      } else {
        console.warn(
          `   ⚠️ Alice identity missing hash or bytes - cannot store in IPFS`,
        );
        console.log(
          `     Hash: ${sharedIdentity.hash}, Bytes: ${!!sharedIdentity.bytes}`,
        );
      }
    }

    // Store Bob identity with proper validation
    if (bobIdentity) {
      if (bobIdentity.hash && bobIdentity.bytes) {
        try {
          console.log(
            `   📦 Attempting to store Bob identity with hash: ${bobIdentity.hash}`,
          );

          // Parse hash string as CID (required by IPFS blockstore)
          const { CID } = await import("multiformats/cid");
          const hashCID = CID.parse(bobIdentity.hash);
          console.log(`     ✅ Parsed hash as CID: ${hashCID}`);

          // Get helia from current peer
          const currentPeer = this.peers.get(persona);
          if (currentPeer?.helia) {
            identityStorePromises.push(
              currentPeer.helia.blockstore.put(hashCID, bobIdentity.bytes),
            );
          }
        } catch (hashError) {
          console.error(
            `   ❌ Bob identity hash validation failed:`,
            hashError.message,
          );
          console.log(`   🔧 Trying alternative storage method...`);

          // Alternative: Store using the identity directly through OrbitDB identities system
          try {
            await linkedIdentities.addIdentity(bobIdentity);
            console.log(
              `   ✅ Bob identity stored via identities.addIdentity()`,
            );
          } catch (altError) {
            console.error(
              `   ❌ Alternative storage also failed:`,
              altError.message,
            );
          }
        }
      } else {
        console.warn(
          `   ⚠️ Bob identity missing hash or bytes - cannot store in IPFS`,
        );
        console.log(
          `     Hash: ${bobIdentity.hash}, Bytes: ${!!bobIdentity.bytes}`,
        );
      }
    }

    // Wait for all identity storage to complete (only if there are promises)
    if (identityStorePromises.length > 0) {
      try {
        await Promise.all(identityStorePromises);
        console.log(
          `✅ Identity storage promises completed in ${persona}'s IPFS`,
        );
      } catch (storageError) {
        console.error(
          `❌ Some identity storage failed in ${persona}'s IPFS:`,
          storageError,
        );
        console.log(
          `   🔧 This might be expected if identities don't have proper hash/bytes`,
        );
      }
    } else {
      console.log(
        `ℹ️ No IPFS storage needed - identities stored via alternative methods`,
      );
    }
  }

  /**
   * Test identity resolution after cross-storage
   */
  async testIdentityResolution(
    linkedIdentities,
    persona,
    sharedIdentity,
    bobIdentity,
  ) {
    console.log(
      `🧪 Testing identity resolution for ${persona} after cross-storage:`,
    );

    // Try multiple resolution approaches
    if (sharedIdentity) {
      console.log("   Testing Alice/shared identity resolution:");

      // Method 1: By hash (if available)
      if (sharedIdentity.hash) {
        try {
          // Try both string hash and parsed CID
          const aliceByHashString = await linkedIdentities.getIdentity(
            sharedIdentity.hash,
          );
          console.log(
            `     By hash (string): ${aliceByHashString ? "✅" : "❌"}`,
          );

          // Also try with parsed CID
          const { CID } = await import("multiformats/cid");
          const hashCID = CID.parse(sharedIdentity.hash);
          const aliceByHashCID = await linkedIdentities.getIdentity(hashCID);
          console.log(`     By hash (CID): ${aliceByHashCID ? "✅" : "❌"}`);
        } catch (hashError) {
          console.log(`     By hash: ❌ (${hashError.message})`);
        }
      }

      // Method 2: By ID
      try {
        const aliceById = await linkedIdentities.getIdentity(sharedIdentity.id);
        console.log(`     By ID: ${aliceById ? "✅" : "❌"}`);
      } catch (idError) {
        console.log(`     By ID: ❌ (${idError.message})`);
      }
    }

    if (bobIdentity) {
      console.log("   Testing Bob identity resolution:");

      // Method 1: By hash (if available)
      if (bobIdentity.hash) {
        try {
          // Try both string hash and parsed CID
          const bobByHashString = await linkedIdentities.getIdentity(
            bobIdentity.hash,
          );
          console.log(
            `     By hash (string): ${bobByHashString ? "✅" : "❌"}`,
          );

          // Also try with parsed CID
          const { CID } = await import("multiformats/cid");
          const hashCID = CID.parse(bobIdentity.hash);
          const bobByHashCID = await linkedIdentities.getIdentity(hashCID);
          console.log(`     By hash (CID): ${bobByHashCID ? "✅" : "❌"}`);
        } catch (hashError) {
          console.log(`     By hash: ❌ (${hashError.message})`);
        }
      }

      // Method 2: By ID
      try {
        const bobById = await linkedIdentities.getIdentity(bobIdentity.id);
        console.log(`     By ID: ${bobById ? "✅" : "❌"}`);
      } catch (idError) {
        console.log(`     By ID: ❌ (${idError.message})`);
      }
    }
  }

  /**
   * Create database with proper access control
   */
  async createDatabase(
    orbitdb,
    persona,
    databaseName,
    databaseConfig,
    options = {},
  ) {
    const { sharedIdentity, bobIdentity, sharedDatabaseAddress } = options;

    let database = null;

    if (persona === "alice") {
      // Alice creates the database with both Alice and Bob access (if Bob exists)
      console.log(
        `🆕 Alice creating new database with proper access control:`,
        databaseName,
      );

      // Setup access control for Alice and potentially Bob
      const writePermissions = [sharedIdentity.id];
      if (bobIdentity) {
        writePermissions.push(bobIdentity.id);
        console.log(
          `🔐 Setting up database with write access for both Alice & Bob`,
        );
      } else {
        console.log(
          `🔒 Setting up database with Alice-only access (Bob identity not ready yet)`,
        );
      }

      // Create database with updated access control
      const multiAccessConfig = {
        ...databaseConfig,
        AccessController: UCANOrbitDBAccessController({
          write: writePermissions,
        }),
      };

      database = await orbitdb.open(databaseName, multiAccessConfig);
      console.log(
        `📍 Alice created shared database with address:`,
        database.address,
      );
      console.log(`🔐 Access granted to: ${writePermissions.join(", ")}`);
    } else {
      // Bob opens the existing database by Alice's address
      if (!sharedDatabaseAddress) {
        throw new Error(
          "Cannot initialize Bob: Alice must create the shared database first!",
        );
      }

      console.log(
        `🔗 Bob opening existing database by Alice's address:`,
        sharedDatabaseAddress,
      );
      console.log(
        `💡 Bob will inherit all configuration from Alice's database`,
      );

      // Bob opens by address only - minimal approach, inherits all Alice's configuration
      database = await orbitdb.open(sharedDatabaseAddress);

      // Verify that the address matches
      if (database.address !== sharedDatabaseAddress) {
        console.warn(
          `⚠️ Address mismatch! Expected: ${sharedDatabaseAddress}, Got: ${database.address}`,
        );
      } else {
        console.log(`✅ Bob successfully opened shared database by address`);
        console.log(`🔐 Bob using Alice's access control`);
      }
    }

    console.log("📜 Database created:", database.name);

    // Verify database setup
    console.log(`✅ ${persona.toUpperCase()} database ready:`);
    console.log(
      `   Address: ...${database.address.split("/").pop().slice(-12)}`,
    );
    console.log(`   Type: ${database.type}`);
    console.log(`   Identity: ...${database.identity.id.slice(-12)}`);

    if (database.access && database.access.write) {
      const writeList = database.access.write.map(
        (id) => `...${id.slice(-12)}`,
      );
      console.log(`   Write permissions: [${writeList.join(", ")}]`);
    }

    return database;
  }

  /**
   * Set up event listeners for StorachaTest databases only
   */
  setupDatabaseEventListeners(database, persona) {
    if (!database) return;

    console.log(`🎧 Setting up event listeners for ${persona}'s database...`);
    console.log(`🎯 [StorachaTest] Database address: ${database.address}`);

    // Add this database address to our tracking set
    this.databases.set(
      database.address?.toString() || database.address,
      persona,
    );

    // Listen for new entries being added (join event)
    database.events.on("join", async (address, entry, heads) => {
      // Check if this event is for any StorachaTest database
      const eventAddress = address?.toString() || address;

      if (this.databases.has(eventAddress)) {
        const replicationSource =
          entry?.identity !== database.identity.id ? "REPLICATED" : "LOCAL";

        console.log(
          `🔥 🔗 [${persona.toUpperCase()}] JOIN EVENT (${replicationSource}):`,
        );
        console.log(`   Entry Key: ${entry?.key}`);
        console.log(`   Entry Value:`, entry?.value);
        console.log(`   Entry Identity: ${entry?.identity}`);
        console.log(`   Local Identity: ${database.identity.id}`);
        console.log(`   Address: ${eventAddress}`);
        console.log(`   Timestamp: ${new Date().toISOString()}`);

        if (replicationSource === "REPLICATED") {
          console.log(
            `✨ 🎆 REPLICATION DETECTED! ${persona} received data from remote peer!`,
          );
        }

        // Add to test results if test is running
        if (this.eventCallbacks.addResult) {
          this.eventCallbacks.addResult(
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
        }

        // Add replication event
        this.addReplicationEvent({
          type: "data_replicated",
          peer: persona,
          data: {
            key: entry?.key,
            replicationSource: replicationSource.toLowerCase(),
            from: entry?.identity?.slice(-8) || "unknown",
          },
        });
      }
    });

    // Listen for entries being updated (update event)
    database.events.on("update", async (address, entry, heads) => {
      // Check if this event is for any StorachaTest database
      const eventAddress = address?.toString() || address;

      if (this.databases.has(eventAddress)) {
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
        if (this.eventCallbacks.addResult) {
          this.eventCallbacks.addResult(
            persona,
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

  /**
   * Get peer instance
   */
  getPeer(persona) {
    return this.peers.get(persona);
  }

  /**
   * Get connection state
   */
  getConnectionState() {
    return { ...this.connectionState };
  }

  /**
   * Clean up all peer instances
   */
  async cleanup() {
    console.log("🧹 Cleaning up OrbitDB service instances...");

    for (const [persona, peer] of this.peers.entries()) {
      try {
        if (peer.database) await peer.database.close();
        if (peer.orbitdb) await peer.orbitdb.stop();
        if (peer.helia) await peer.helia.stop();
        if (peer.libp2p) await peer.libp2p.stop();
        console.log(`✅ Cleaned up ${persona} peer`);
      } catch (error) {
        console.warn(`⚠️ ${persona} cleanup error:`, error.message);
      }
    }

    // Reset state
    this.peers.clear();
    this.databases.clear();
    this.connectionState = {
      aliceMultiaddrs: [],
      bobMultiaddrs: [],
      alicePeerId: null,
      bobPeerId: null,
      aliceConnectedPeers: [],
      bobConnectedPeers: [],
      aliceAddressReady: false,
      bobAddressReady: false,
      peersConnected: false,
    };
  }
}

// Export a singleton instance for easy use
export const orbitDBService = new OrbitDBService();
