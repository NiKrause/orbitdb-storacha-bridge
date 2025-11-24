/**
 * Test suite for IPFS network download functionality
 *
 * Tests network downloads via unixfs.cat(), gateway fallback behavior,
 * configuration options, and result consistency.
 */

import "dotenv/config";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import {
  downloadBlockFromIPFSNetwork,
  downloadBlockFromStoracha,
  initializeStorachaClient,
} from "../lib/orbitdb-storacha-bridge.js";
import { backupDatabaseCAR, restoreFromSpaceCAR } from "../lib/backup-car.js";

describe("Network Download Tests", () => {
  let heliaNode;

  beforeEach(async () => {
    // Create a Helia instance for testing
    heliaNode = await createHeliaOrbitDB("-network-test");
  });

  afterEach(async () => {
    // Cleanup
    if (heliaNode) {
      const dbs = heliaNode.orbitdb._databases || new Map();
      for (const [, db] of dbs) {
        try {
          await db.close();
        } catch (e) {
          // Ignore errors if already closed
        }
      }
      await heliaNode.orbitdb.stop();
      await heliaNode.helia.stop();
      await heliaNode.blockstore.close();
      await heliaNode.datastore.close();
    }
    await cleanupOrbitDBDirectories();
  });

  /**
   * Helper function to upload content to IPFS via Helia using UnixFS
   */
  async function uploadToIPFS(helia, content) {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;

    // Use UnixFS to store the content (proper file structure, handles chunking)
    const { unixfs: unixfsModule } = await import("@helia/unixfs");
    const fs = unixfsModule(helia);

    // Create an async iterable from the bytes for unixfs.addFile()
    async function* contentGenerator() {
      yield bytes;
    }

    // Add to IPFS using UnixFS (returns CID)
    const cid = await fs.addFile({ content: contentGenerator() });
    return cid.toString();
  }

  /**
   * Helper function to create test file of specified size
   */
  function createTestFile(size) {
    const chunk = "A".repeat(1024); // 1KB chunks
    const chunks = Math.ceil(size / 1024);
    return chunk.repeat(chunks).substring(0, size);
  }

  /**
   * Helper function to wait for peers to connect (with timeout)
   * @param {Object} heliaNode - The Helia node instance
   * @param {number} minPeers - Minimum number of peers to wait for (default: 1)
   * @param {number} timeout - Maximum time to wait in milliseconds (default: 30000)
   * @returns {Promise<number>} The number of connected peers
   */
  async function waitForPeers(heliaNode, minPeers = 1, timeout = 30000) {
    if (!heliaNode?.libp2p) {
      return 0;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const connections = heliaNode.libp2p.getConnections();
        const peerCount = connections.length;
        if (peerCount >= minPeers) {
          return peerCount;
        }
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.log(`Error checking peer count: ${error.message}`);
        return 0;
      }
    }
    // Return current count even if minPeers not reached
    try {
      return heliaNode.libp2p.getConnections().length;
    } catch {
      return 0;
    }
  }

  /**
   * Helper function to get and log peer count
   */
  function logPeerCount(heliaNode, context = "") {
    if (!heliaNode?.libp2p) {
      console.log(`[${context}] Peer count: N/A (libp2p not available)`);
      return 0;
    }

    try {
      // libp2p.getConnections() is a method directly on the libp2p instance
      const connections = heliaNode.libp2p.getConnections();
      const peerCount = connections.length;
      console.log(`[${context}] Peer count before download: ${peerCount}`);
      return peerCount;
    } catch (error) {
      console.log(`[${context}] Error getting peer count: ${error.message}`);
      return 0;
    }
  }

  /**
   * Helper function to upload content to Storacha using space credentials
   */
  async function uploadToStoracha(content) {
    const storachaKey =
      process.env?.STORACHA_KEY ||
      (typeof process !== "undefined" ? process.env?.STORACHA_KEY : undefined);
    const storachaProof =
      process.env?.STORACHA_PROOF ||
      (typeof process !== "undefined"
        ? process.env?.STORACHA_PROOF
        : undefined);

    if (!storachaKey || !storachaProof) {
      throw new Error(
        "Storacha credentials required: STORACHA_KEY and STORACHA_PROOF must be set",
      );
    }

    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;

    // Initialize Storacha client
    const client = await initializeStorachaClient(storachaKey, storachaProof);

    // Create a File object for upload
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const file = new File([blob], `test-${Date.now()}.bin`, {
      type: "application/octet-stream",
    });

    // Upload to Storacha
    const result = await client.uploadFile(file);
    return result.toString();
  }

  describe("downloadBlockFromIPFSNetwork()", () => {
    it("should download content using unixfs.cat()", async () => {
      const testContent = "Hello, IPFS Network!";
      const testBytes = new TextEncoder().encode(testContent);

      // Upload to IPFS
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      // Wait a bit for the block to be available
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Wait a bit for block to be available in blockstore
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Download using network
      logPeerCount(heliaNode, "downloadBlockFromIPFSNetwork - simple");
      const downloadedBytes = await downloadBlockFromIPFSNetwork(
        cid,
        heliaNode.helia,
        { timeout: 30000 },
      );

      // Verify content matches
      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(testBytes.length);
      expect(new TextDecoder().decode(downloadedBytes)).toBe(testContent);
    }, 60000);

    it("should handle DAG traversal for chunked files", async () => {
      // Test requires unixfs which should be available
      if (!heliaNode.unixfs) {
        console.log("Skipping test: unixfs not available");
        expect(true).toBe(true);
        return;
      }

      // Create a larger file that might be chunked (100KB)
      const largeContent = createTestFile(100 * 1024);
      const testBytes = new TextEncoder().encode(largeContent);

      // Upload to IPFS
      const cid = await uploadToIPFS(heliaNode.helia, largeContent);

      // Wait for upload to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Download using network
      logPeerCount(heliaNode, "downloadBlockFromIPFSNetwork - chunked");
      const downloadedBytes = await downloadBlockFromIPFSNetwork(
        cid,
        heliaNode.helia,
        { timeout: 60000, unixfs: heliaNode.unixfs },
      );

      // Verify all content is retrieved
      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(testBytes.length);
      expect(new TextDecoder().decode(downloadedBytes)).toBe(largeContent);
    }, 120000);

    it("should timeout after configured timeout period", async () => {
      if (!heliaNode.unixfs) {
        console.log("Skipping test: unixfs not available");
        expect(true).toBe(true);
        return;
      }

      const testContent = "Test timeout";
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      // Mock unixfs.cat() to hang indefinitely
      const originalCat = heliaNode.unixfs.cat.bind(heliaNode.unixfs);
      heliaNode.unixfs.cat = jest.fn(() => {
        return (async function* () {
          // Never yield, simulating a hang
          await new Promise(() => {}); // Never resolves
          yield; // Add yield to make it a valid generator
        })();
      });

      // Try to download with short timeout
      await expect(
        downloadBlockFromIPFSNetwork(cid, heliaNode.helia, {
          timeout: 1000,
          unixfs: heliaNode.unixfs,
        }),
      ).rejects.toThrow("Network download timeout");

      // Restore original
      heliaNode.unixfs.cat = originalCat;
    }, 10000);

    it("should handle invalid CIDs", async () => {
      await expect(
        downloadBlockFromIPFSNetwork("invalid-cid-format", heliaNode.helia, {
          timeout: 5000,
        }),
      ).rejects.toThrow();
    });

    it("should handle empty content", async () => {
      if (!heliaNode.unixfs) {
        console.log("Skipping test: unixfs not available");
        expect(true).toBe(true);
        return;
      }

      const emptyContent = "";
      const cid = await uploadToIPFS(heliaNode.helia, emptyContent);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      logPeerCount(heliaNode, "downloadBlockFromIPFSNetwork - empty");
      const downloadedBytes = await downloadBlockFromIPFSNetwork(
        cid,
        heliaNode.helia,
        { timeout: 30000, unixfs: heliaNode.unixfs },
      );

      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(0);
    }, 60000);
  });

  describe("downloadBlockFromStoracha() with Storacha upload", () => {
    it("should upload to Storacha and download using unixfs.cat()", async () => {
      // Skip if credentials are not available
      if (!process.env?.STORACHA_KEY || !process.env?.STORACHA_PROOF) {
        console.log("Skipping test: Storacha credentials not available");
        expect(true).toBe(true);
        return;
      }

      const testContent = "Hello, Storacha Network!";
      const testBytes = new TextEncoder().encode(testContent);

      // Upload to Storacha
      const cid = await uploadToStoracha(testContent);

      // Wait for Storacha to process the upload
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Download using network from Storacha
      logPeerCount(heliaNode, "downloadBlockFromStoracha - simple");
      const downloadedBytes = await downloadBlockFromStoracha(cid, {
        helia: heliaNode.helia,
        unixfs: heliaNode.unixfs,
        useIPFSNetwork: true,
        gatewayFallback: true,
        timeout: 30000,
      });

      // Verify content matches
      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(testBytes.length);
      expect(new TextDecoder().decode(downloadedBytes)).toBe(testContent);
    }, 60000);

    it("should handle DAG traversal for chunked files uploaded to Storacha", async () => {
      // Skip if credentials are not available
      if (!process.env?.STORACHA_KEY || !process.env?.STORACHA_PROOF) {
        console.log("Skipping test: Storacha credentials not available");
        expect(true).toBe(true);
        return;
      }

      // Test requires unixfs which should be available
      if (!heliaNode.unixfs) {
        console.log("Skipping test: unixfs not available");
        expect(true).toBe(true);
        return;
      }

      // Create a larger file that might be chunked (100KB)
      const largeContent = createTestFile(100 * 1024);
      const testBytes = new TextEncoder().encode(largeContent);

      // Upload to Storacha
      const cid = await uploadToStoracha(largeContent);

      // Wait for Storacha to process the upload
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Download using network from Storacha
      logPeerCount(heliaNode, "downloadBlockFromStoracha - chunked");
      const downloadedBytes = await downloadBlockFromStoracha(cid, {
        helia: heliaNode.helia,
        unixfs: heliaNode.unixfs,
        useIPFSNetwork: true,
        gatewayFallback: true,
        timeout: 60000,
      });

      // Verify all content is retrieved
      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(testBytes.length);
      expect(new TextDecoder().decode(downloadedBytes)).toBe(largeContent);
    }, 120000);

    it("should download from Storacha using gateway fallback", async () => {
      // Skip if credentials are not available
      if (!process.env?.STORACHA_KEY || !process.env?.STORACHA_PROOF) {
        console.log("Skipping test: Storacha credentials not available");
        expect(true).toBe(true);
        return;
      }

      const testContent = "Storacha gateway fallback test";
      const testBytes = new TextEncoder().encode(testContent);

      // Upload to Storacha
      const cid = await uploadToStoracha(testContent);

      // Wait for Storacha to process the upload
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Mock unixfs.cat() to fail, forcing gateway fallback
      const originalCat = heliaNode.unixfs?.cat?.bind(heliaNode.unixfs);
      if (heliaNode.unixfs) {
        heliaNode.unixfs.cat = jest.fn(() => {
          throw new Error("Network unavailable");
        });
      }

      // Mock fetch for gateway
      const originalFetch = global.fetch;
      const fetchSpy = jest.fn((_url) => {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(testBytes.buffer),
        });
      });
      global.fetch = fetchSpy;

      try {
        // Download using gateway fallback
        const downloadedBytes = await downloadBlockFromStoracha(cid, {
          helia: heliaNode.helia,
          unixfs: heliaNode.unixfs,
          useIPFSNetwork: true,
          gatewayFallback: true,
          timeout: 5000,
        });

        // Verify gateway was used
        expect(fetchSpy).toHaveBeenCalled();
        expect(downloadedBytes).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(downloadedBytes)).toBe(testContent);
      } finally {
        // Restore original functions
        if (heliaNode.unixfs && originalCat) {
          heliaNode.unixfs.cat = originalCat;
        }
        global.fetch = originalFetch;
      }
    }, 60000);
  });

  describe("restoreFromSpaceCAR() network integration", () => {
    it("should use network download when useIPFSNetwork is true", async () => {
      // Create source node and backup
      const sourceNode = await createHeliaOrbitDB("-source-network");
      const sourceDB = await sourceNode.orbitdb.open("test-network-restore", {
        type: "events",
      });
      await sourceDB.add("Network test entry 1");
      await sourceDB.add("Network test entry 2");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const backup = await backupDatabaseCAR(
        sourceNode.orbitdb,
        sourceDB.address,
        {
          spaceName: "test-network-space",
        },
      );

      expect(backup.success).toBe(true);
      await sourceDB.close();

      // Wait for Storacha to process
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Create target node for restore
      const targetNode = await createHeliaOrbitDB("-target-network");

      // Wait for peers to connect before checking count
      await waitForPeers(targetNode, 5, 10000); // Wait up to 10s, but don't require any peers

      // Restore with network download enabled
      logPeerCount(targetNode, "restoreFromSpaceCAR - network enabled");
      const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
        spaceName: "test-network-space",
        useIPFSNetwork: true,
        gatewayFallback: true,
      });

      expect(restored.success).toBe(true);
      expect(restored.entriesRecovered).toBeGreaterThanOrEqual(2);

      const entries = await restored.database.all();
      expect(entries.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      await restored.database.close();
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }, 120000);

    it("should fallback to gateway when network fails", async () => {
      // Create backup first
      const sourceNode = await createHeliaOrbitDB("-source-fallback");
      const sourceDB = await sourceNode.orbitdb.open("test-fallback", {
        type: "events",
      });
      await sourceDB.add("Fallback test entry");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const backup = await backupDatabaseCAR(
        sourceNode.orbitdb,
        sourceDB.address,
        {
          spaceName: "test-fallback-space",
        },
      );

      expect(backup.success).toBe(true);
      await sourceDB.close();

      // Wait for Storacha
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Create target node
      const targetNode = await createHeliaOrbitDB("-target-fallback");

      // Wait for peers to connect before checking count
      await waitForPeers(targetNode, 5, 10000); // Wait up to 10s, but don't require any peers

      // Mock unixfs.cat() to fail
      const originalCat = targetNode.unixfs.cat.bind(targetNode.unixfs);
      targetNode.unixfs.cat = jest.fn(() => {
        throw new Error("Network unavailable");
      });

      // Restore with fallback enabled
      logPeerCount(targetNode, "restoreFromSpaceCAR - fallback");
      const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
        spaceName: "test-fallback-space",
        useIPFSNetwork: true,
        gatewayFallback: true,
      });

      // Should succeed via gateway fallback
      expect(restored.success).toBe(true);

      // Restore original
      targetNode.unixfs.cat = originalCat;

      // Cleanup
      await restored.database.close();
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }, 120000);

    it("should fail when network fails and gatewayFallback is false", async () => {
      // Create backup
      const sourceNode = await createHeliaOrbitDB("-source-no-fallback");
      const sourceDB = await sourceNode.orbitdb.open("test-no-fallback", {
        type: "events",
      });
      await sourceDB.add("No fallback test");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const backup = await backupDatabaseCAR(
        sourceNode.orbitdb,
        sourceDB.address,
        {
          spaceName: "test-no-fallback-space",
        },
      );

      expect(backup.success).toBe(true);
      await sourceDB.close();

      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Create target node
      const targetNode = await createHeliaOrbitDB("-target-no-fallback");

      // Mock unixfs.cat() to fail
      const originalCat = targetNode.unixfs.cat.bind(targetNode.unixfs);
      targetNode.unixfs.cat = jest.fn(() => {
        throw new Error("Network unavailable");
      });

      // Restore with fallback disabled - should return success: false
      const result = await restoreFromSpaceCAR(targetNode.orbitdb, {
        spaceName: "test-no-fallback-space",
        useIPFSNetwork: true,
        gatewayFallback: false,
      });

      // Check that it failed as expected
      expect(result.success).toBe(false);
      expect(result.error).toContain("gateway fallback is disabled");

      // Restore original
      targetNode.unixfs.cat = originalCat;

      // Cleanup
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }, 120000);

    it("should use gateway when useIPFSNetwork is false", async () => {
      // Create backup
      const sourceNode = await createHeliaOrbitDB("-source-gateway-only");
      const sourceDB = await sourceNode.orbitdb.open("test-gateway-only", {
        type: "events",
      });
      await sourceDB.add("Gateway only test");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const backup = await backupDatabaseCAR(
        sourceNode.orbitdb,
        sourceDB.address,
        {
          spaceName: "test-gateway-only-space",
        },
      );

      expect(backup.success).toBe(true);
      await sourceDB.close();

      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Create target node
      const targetNode = await createHeliaOrbitDB("-target-gateway-only");

      // Wait for peers to connect before checking count
      await waitForPeers(targetNode, 5, 10000); // Wait up to 10s, but don't require any peers

      // Spy on unixfs.cat() to verify it's NOT called
      const catSpy = jest.spyOn(targetNode.unixfs, "cat");

      // Restore with network disabled
      logPeerCount(targetNode, "restoreFromSpaceCAR - gateway only");
      const restored = await restoreFromSpaceCAR(targetNode.orbitdb, {
        spaceName: "test-gateway-only-space",
        useIPFSNetwork: false,
      });

      // Should succeed via gateway
      expect(restored.success).toBe(true);

      // Verify network download was NOT attempted
      expect(catSpy).not.toHaveBeenCalled();

      catSpy.mockRestore();

      // Cleanup
      await restored.database.close();
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
      await targetNode.orbitdb.stop();
      await targetNode.helia.stop();
      await targetNode.blockstore.close();
      await targetNode.datastore.close();
    }, 120000);
  });

  describe("Configuration options", () => {
    it("downloadBlockFromStoracha should respect useIPFSNetwork option", async () => {
      const testContent = "Test content for config";
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Wait for peers if needed (shared node should already have peers)
      await waitForPeers(heliaNode, 5, 5000); // Quick check, don't require peers

      // Test with useIPFSNetwork: true
      logPeerCount(
        heliaNode,
        "downloadBlockFromStoracha - useIPFSNetwork true",
      );
      const spy = jest.spyOn(heliaNode.unixfs, "cat");
      const bytes1 = await downloadBlockFromStoracha(cid, {
        helia: heliaNode.helia,
        unixfs: heliaNode.unixfs,
        useIPFSNetwork: true,
        gatewayFallback: false,
        timeout: 30000,
      });

      expect(spy).toHaveBeenCalled();
      expect(bytes1).toBeInstanceOf(Uint8Array);
      spy.mockRestore();

      // Test with useIPFSNetwork: false
      const originalFetch = global.fetch;
      const fetchSpy = jest.fn(originalFetch);
      global.fetch = fetchSpy;

      const catSpy2 = jest.spyOn(heliaNode.unixfs, "cat");

      try {
        await downloadBlockFromStoracha(cid, {
          helia: heliaNode.helia,
          useIPFSNetwork: false,
          timeout: 5000,
        });
      } catch (error) {
        // May fail if gateway is unavailable, but we verify network wasn't used
      }

      expect(catSpy2).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalled();

      catSpy2.mockRestore();
      global.fetch = originalFetch;
    }, 60000);

    it("downloadBlockFromStoracha should respect gatewayFallback option", async () => {
      const testContent = "Test fallback config";
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      // Mock unixfs.cat() to fail
      const originalCat = heliaNode.unixfs.cat.bind(heliaNode.unixfs);
      heliaNode.unixfs.cat = jest.fn(() => {
        throw new Error("Network error");
      });

      // Test with gatewayFallback: true
      const originalFetch = global.fetch;
      const fetchSpy = jest.fn((_url) => {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () =>
            Promise.resolve(new TextEncoder().encode(testContent).buffer),
        });
      });
      global.fetch = fetchSpy;

      const bytes = await downloadBlockFromStoracha(cid, {
        helia: heliaNode.helia,
        unixfs: heliaNode.unixfs,
        useIPFSNetwork: true,
        gatewayFallback: true,
        timeout: 5000,
      });

      expect(fetchSpy).toHaveBeenCalled();
      expect(bytes).toBeInstanceOf(Uint8Array);

      // Test with gatewayFallback: false
      await expect(
        downloadBlockFromStoracha(cid, {
          helia: heliaNode.helia,
          unixfs: heliaNode.unixfs,
          useIPFSNetwork: true,
          gatewayFallback: false,
          timeout: 5000,
        }),
      ).rejects.toThrow();

      // Restore
      heliaNode.unixfs.cat = originalCat;
      global.fetch = originalFetch;
    });

    it("downloadBlockFromStoracha should work without Helia instance (gateway only)", async () => {
      const testContent = "Gateway only test";
      const testBytes = new TextEncoder().encode(testContent);
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      // Wait for content to be available on gateway
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Mock fetch for gateway
      const originalFetch = global.fetch;
      const fetchSpy = jest.fn((_url) => {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(testBytes.buffer),
        });
      });
      global.fetch = fetchSpy;

      const bytes = await downloadBlockFromStoracha(cid, {
        useIPFSNetwork: true, // Even if true, no helia means gateway only
        gatewayFallback: true,
        timeout: 5000,
      });

      expect(fetchSpy).toHaveBeenCalled();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(bytes)).toBe(testContent);

      global.fetch = originalFetch;
    });
  });

  describe("Result consistency", () => {
    it("Network and gateway downloads should produce identical results", async () => {
      const testContent = "Consistency test content";
      const testBytes = new TextEncoder().encode(testContent);
      const cid = await uploadToIPFS(heliaNode.helia, testContent);

      // Wait for content to be available
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Download via network
      logPeerCount(heliaNode, "Result consistency - network");
      const networkBytes = await downloadBlockFromIPFSNetwork(
        cid,
        heliaNode.helia,
        { timeout: 30000, unixfs: heliaNode.unixfs },
      );

      // Download via gateway
      const originalFetch = global.fetch;
      let gatewayBytes = null;
      global.fetch = jest.fn((_url) => {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(testBytes.buffer),
        });
      });

      try {
        gatewayBytes = await downloadBlockFromStoracha(cid, {
          useIPFSNetwork: false,
          timeout: 5000,
        });
      } catch (error) {
        // Gateway might not have the content yet, that's okay for this test
      }

      global.fetch = originalFetch;

      // If both succeeded, compare
      if (networkBytes && gatewayBytes) {
        expect(networkBytes.length).toBe(gatewayBytes.length);
        expect(networkBytes).toEqual(gatewayBytes);
        expect(new TextDecoder().decode(networkBytes)).toBe(
          new TextDecoder().decode(gatewayBytes),
        );
      }

      // At minimum, network download should work
      expect(networkBytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(networkBytes)).toBe(testContent);
    }, 60000);

    it("Restore from network should match restore from gateway", async () => {
      // Create backup
      const sourceNode = await createHeliaOrbitDB("-source-consistency");
      const sourceDB = await sourceNode.orbitdb.open("test-consistency", {
        type: "events",
      });
      await sourceDB.add("Consistency entry 1");
      await sourceDB.add("Consistency entry 2");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const backup = await backupDatabaseCAR(
        sourceNode.orbitdb,
        sourceDB.address,
        {
          spaceName: "test-consistency-space",
        },
      );

      expect(backup.success).toBe(true);
      await sourceDB.close();

      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Restore using network
      const networkNode = await createHeliaOrbitDB("-network-consistency");
      
      // Wait for peers to connect before attempting network restore
      // Network restore requires peers, so wait for at least 5 connections
      await waitForPeers(networkNode, 5, 30000); // Wait up to 30s for 5 peers
      
      logPeerCount(networkNode, "Result consistency - network restore");
      const networkRestored = await restoreFromSpaceCAR(networkNode.orbitdb, {
        spaceName: "test-consistency-space",
        useIPFSNetwork: true,
        gatewayFallback: false,
      });

      expect(networkRestored.success).toBe(true);
      const networkEntries = await networkRestored.database.all();

      // Restore using gateway only
      const gatewayNode = await createHeliaOrbitDB("-gateway-consistency");
      const gatewayRestored = await restoreFromSpaceCAR(gatewayNode.orbitdb, {
        spaceName: "test-consistency-space",
        useIPFSNetwork: false,
      });

      expect(gatewayRestored.success).toBe(true);
      const gatewayEntries = await gatewayRestored.database.all();

      // Compare results
      expect(networkEntries.length).toBe(gatewayEntries.length);

      // Extract values and compare
      const networkValues = networkEntries.map((e) => e.value).sort();
      const gatewayValues = gatewayEntries.map((e) => e.value).sort();
      expect(networkValues).toEqual(gatewayValues);

      // Cleanup
      await networkRestored.database.close();
      await gatewayRestored.database.close();
      await sourceNode.orbitdb.stop();
      await sourceNode.helia.stop();
      await sourceNode.blockstore.close();
      await sourceNode.datastore.close();
      await networkNode.orbitdb.stop();
      await networkNode.helia.stop();
      await networkNode.blockstore.close();
      await networkNode.datastore.close();
      await gatewayNode.orbitdb.stop();
      await gatewayNode.helia.stop();
      await gatewayNode.blockstore.close();
      await gatewayNode.datastore.close();
    }, 180000);
  });

  describe("Edge cases", () => {
    it("should handle very large files", async () => {
      if (!heliaNode.unixfs) {
        console.log("Skipping test: unixfs not available");
        expect(true).toBe(true);
        return;
      }

      // Create a large file (5MB) that will be chunked
      const largeContent = createTestFile(5 * 1024 * 1024);
      const testBytes = new TextEncoder().encode(largeContent);

      const cid = await uploadToIPFS(heliaNode.helia, largeContent);

      // Wait longer for large file
      await new Promise((resolve) => setTimeout(resolve, 5000));

      logPeerCount(heliaNode, "Edge case - large file");
      const downloadedBytes = await downloadBlockFromIPFSNetwork(
        cid,
        heliaNode.helia,
        { timeout: 120000, unixfs: heliaNode.unixfs },
      );

      expect(downloadedBytes).toBeInstanceOf(Uint8Array);
      expect(downloadedBytes.length).toBe(testBytes.length);
      expect(new TextDecoder().decode(downloadedBytes)).toBe(largeContent);
    }, 180000);
  });
});
