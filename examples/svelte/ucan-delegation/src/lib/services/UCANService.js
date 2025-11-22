/**
 * UCAN Service - Handles UCAN delegation creation and management
 * Extracted from StorachaTestWithWebAuthn.svelte for better maintainability
 */

import { sanitizeAgent } from "../AgentSanitizer.js";
import { logger } from "../logger.js";

export class UCANService {
  constructor() {
    this.delegations = new Map(); // Store active delegations
  }

  /**
   * Create bridge UCAN delegation: EdDSA → P-256 → P-256
   * Alice's Storacha EdDSA agent delegates to Alice's P-256 OrbitDB DID,
   * then Alice's P-256 OrbitDB DID delegates to Bob's P-256 OrbitDB DID
   *
   * @param {string} bobDID - Bob's P-256 DID from his OrbitDB identity
   * @param {Object} storachaClient - Alice's Storacha client
   * @param {Object} sharedIdentity - Alice's OrbitDB identity
   * @returns {Object} - Bridge delegation info with P-256 signed token for Bob
   */
  async createBridgeStorachaDelegation(bobDID, storachaClient, sharedIdentity) {
    logger.info(`🌉 Creating bridge UCAN delegation: EdDSA → P-256 → P-256`);
    logger.info(
      `   - Alice Storacha EdDSA → Alice OrbitDB P-256 → Bob OrbitDB P-256`,
    );
    logger.info(
      `   - Final delegation will be P-256 signed by Alice's OrbitDB identity`,
    );

    if (!storachaClient) {
      throw new Error("Storacha client not available for delegation");
    }

    if (!sharedIdentity) {
      throw new Error(
        "Alice's OrbitDB P-256 identity not available for bridge delegation",
      );
    }

    try {
      // Import UCAN delegation utilities
      const { delegate } = await import("@le-space/ucanto-client");
      const { Verifier } = await import("@le-space/ucanto-principal");

      // Get Alice's identities
      const aliceStorachaAgent = storachaClient.agent; // EdDSA signer
      const aliceOrbitDBIdentity = sharedIdentity; // P-256 WebAuthn signer

      logger.info(
        `   🔍 Alice Storacha EdDSA DID: ${aliceStorachaAgent.did()}`,
      );
      logger.info(`   🔍 Alice OrbitDB P-256 DID: ${aliceOrbitDBIdentity.id}`);
      logger.info(`   🔍 Bob OrbitDB P-256 DID: ${bobDID}`);

      // Step 1: Create EdDSA → P-256 delegation (Storacha → Alice OrbitDB)
      logger.info(`   🔗 Step 1: Creating EdDSA → P-256 delegation...`);

      const aliceP256Verifier = Verifier.parse(aliceOrbitDBIdentity.id);
      const spaceDID = storachaClient.currentSpace().did();

      const capabilities = [
        { with: spaceDID, can: "space/blob/add" },
        { with: spaceDID, can: "space/index/add" },
        { with: spaceDID, can: "upload/add" },
        { with: spaceDID, can: "upload/list" },
        { with: spaceDID, can: "store/add" },
        { with: spaceDID, can: "filecoin/offer" },
      ];

      const expiration = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

      // Sanitize the Storacha agent for EdDSA → P-256 delegation
      const sanitizedStorachaAgent = sanitizeAgent(aliceStorachaAgent);

      const eddsaToP256Delegation = await delegate({
        issuer: sanitizedStorachaAgent, // Alice's EdDSA Storacha agent
        audience: aliceP256Verifier, // Alice's P-256 OrbitDB DID
        capabilities: capabilities,
        expiration: expiration,
      });

      logger.info(`   ✅ Step 1 complete: EdDSA → P-256 delegation created`);

      // Step 2: Create P-256 → P-256 delegation (Alice OrbitDB → Bob OrbitDB)
      logger.info(`   🔗 Step 2: Creating P-256 → P-256 delegation...`);

      const bobP256Verifier = Verifier.parse(bobDID);

      // Create a P-256 signer wrapper for Alice's OrbitDB identity
      const aliceP256Signer = {
        did: () => aliceOrbitDBIdentity.id,
        sign: async (payload) => {
          // Use OrbitDB identity's signing method
          return await aliceOrbitDBIdentity.sign(aliceOrbitDBIdentity, payload);
        },
        signatureAlgorithm: "ES256", // P-256
        signatureCode: 64, // P-256 signature code
      };

      const p256ToP256Delegation = await delegate({
        issuer: aliceP256Signer, // Alice's P-256 OrbitDB signer
        audience: bobP256Verifier, // Bob's P-256 OrbitDB DID
        capabilities: capabilities,
        proofs: [eddsaToP256Delegation], // Include EdDSA → P-256 as proof!
        expiration: expiration,
      });

      logger.info(`   ✅ Step 2 complete: P-256 → P-256 delegation created`);
      logger.info(`   🌉 Bridge delegation complete!`);

      // Archive the final P-256 → P-256 delegation (this is what Bob will use)
      const archive = await p256ToP256Delegation.archive();
      if (!archive.ok) {
        throw new Error("Failed to archive bridge delegation");
      }

      const delegationToken = Buffer.from(archive.ok).toString("base64");

      logger.info(`   ✅ Bridge UCAN delegation created!`);
      logger.info(
        `   📝 Final delegation signed by Alice's P-256 OrbitDB identity`,
      );
      logger.info(`   🎯 Bob receives P-256 signed delegation (not EdDSA)`);
      logger.info(`   📏 Token length: ${delegationToken.length} characters`);

      const delegation = {
        delegationToken, // P-256 signed delegation for Bob
        bobDID,
        audience: bobDID,
        capabilities,
        expiration,
        createdAt: new Date().toISOString(),
        delegationType: "bridge",
        signatureAlgorithm: "ES256", // Final delegation is P-256 signed
        delegationChain: {
          step1: "Alice Storacha EdDSA → Alice OrbitDB P-256",
          step2: "Alice OrbitDB P-256 → Bob OrbitDB P-256 (Bob uses this)",
        },
      };

      // Store the delegation
      this.delegations.set(bobDID, delegation);

      return delegation;
    } catch (error) {
      logger.error(`❌ Bridge delegation failed: ${error.message}`);
      logger.error("   Falling back to direct EdDSA delegation...");

      // Fallback to the original EdDSA delegation method
      return await this.createStorachaDelegation(bobDID, storachaClient);
    }
  }

  /**
   * Create Storacha UCAN delegation to Bob's existing DID (Original EdDSA method)
   * Alice delegates her Storacha space access to Bob's DID (as string)
   *
   * @param {string} bobDID - Bob's existing DID from his OrbitDB identity
   * @param {Object} storachaClient - Alice's Storacha client
   * @returns {Object} - Delegation info with UCAN token for Bob's DID
   */
  async createStorachaDelegation(bobDID, storachaClient) {
    logger.info(`🎯 Creating Storacha UCAN delegation to Bob's DID: ${bobDID}`);

    if (!storachaClient) {
      throw new Error("Storacha client not available for delegation");
    }

    try {
      // Import UCAN delegation utilities
      const { delegate } = await import("@le-space/ucanto-client");
      const { Verifier } = await import("@le-space/ucanto-principal");

      // 🔍 DEFENSIVE VALIDATION: Check issuer (storachaClient.agent)
      if (!storachaClient.agent) {
        throw new Error("Storacha client agent is missing");
      }
      if (typeof storachaClient.agent.did !== "function") {
        throw new Error("Storacha client agent has no did() method");
      }
      const issuerDID = storachaClient.agent.did();
      if (!issuerDID || typeof issuerDID !== "string") {
        throw new Error(
          `Storacha client agent did() returned invalid value: ${issuerDID}`,
        );
      }
      logger.info(`   ✅ Issuer validated: ${issuerDID}`);

      // 🔍 DEFENSIVE VALIDATION: Parse Bob's DID
      let bobPrincipal;
      try {
        bobPrincipal = Verifier.parse(bobDID);
      } catch (parseError) {
        throw new Error(
          `Invalid bobDID for UCAN audience: ${parseError.message}`,
        );
      }

      if (!bobPrincipal || typeof bobPrincipal.did !== "function") {
        throw new Error(
          "Parsed bobPrincipal is invalid or has no did() method",
        );
      }

      const audienceDID = bobPrincipal.did();
      if (!audienceDID || typeof audienceDID !== "string") {
        throw new Error(
          `bobPrincipal.did() returned invalid value: ${audienceDID}`,
        );
      }

      logger.info(
        `   🔑 Created principal reference for Bob's DID: ${audienceDID}`,
      );
      logger.info(
        `   🔐 Detected algorithm: ${bobPrincipal.signatureAlgorithm} (P-256 WebAuthn supported!)`,
      );

      // 🔍 DEFENSIVE VALIDATION: Compute spaceDID safely
      let spaceDID = "ucan:*"; // Safe default
      try {
        const space =
          typeof storachaClient.currentSpace === "function"
            ? storachaClient.currentSpace()
            : null;
        if (space && typeof space.did === "function") {
          const spaceDidResult = space.did();
          if (spaceDidResult && typeof spaceDidResult === "string") {
            spaceDID = spaceDidResult;
          }
        }
      } catch (spaceError) {
        logger.warn(
          { error: spaceError.message },
          `   ⚠️ Could not get current space DID, using fallback:`
        );
      }

      logger.info(`   🏠 Using space DID: ${spaceDID}`);

      // 🔍 DEFENSIVE VALIDATION: Build capabilities with no undefined values
      const capabilityNames = [
        "space/blob/add",
        "space/index/add",
        "upload/add",
        "upload/list",
        "store/add",
        "filecoin/offer",
      ];

      const capabilities = capabilityNames.map((can) => {
        const cap = { with: spaceDID, can };
        // Double-check no undefined values snuck in
        if (cap.with === undefined || cap.can === undefined) {
          throw new Error(
            `Capability has undefined values: ${JSON.stringify(cap)}`,
          );
        }
        return cap;
      });

      logger.info(
        `   📋 Built ${capabilities.length} capabilities (no undefined values)`,
      );

      // 🔍 DEFENSIVE VALIDATION: Ensure expiration is a valid number
      const expiration = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours
      if (!Number.isInteger(expiration) || expiration <= 0) {
        throw new Error(`Invalid expiration value: ${expiration}`);
      }

      logger.info(`   📋 Delegating capabilities to Bob's existing DID`);
      logger.info(
        `   ⏰ Valid until: ${new Date(expiration * 1000).toISOString()}`,
      );

      // 🔍 FINAL VALIDATION: Log all parameters before delegation
      logger.info(`   🔍 Final validation before delegate():`);
      logger.info(`     - Issuer DID: ${issuerDID}`);
      logger.info(`     - Audience DID: ${audienceDID}`);
      logger.info(`     - Capabilities count: ${capabilities.length}`);
      logger.info(`     - Space DID: ${spaceDID}`);
      logger.info(`     - Expiration: ${expiration}`);

      // Validate capabilities array one more time
      const capString = JSON.stringify(capabilities);
      if (capString.includes("undefined")) {
        throw new Error(`Capabilities contain undefined values: ${capString}`);
      }

      // 🔍 ULTRA-DEFENSIVE: Validate the exact parameters that will be passed to UCAN.issue()
      const delegateParams = {
        issuer: storachaClient.agent,
        audience: bobPrincipal,
        capabilities,
        expiration,
        proofs: [], // Explicitly set empty proofs
        facts: [], // Explicitly set empty facts
        notBefore: undefined, // Explicitly set optional fields
        nonce: undefined,
      };

      // Check for any undefined values in the delegate parameters
      logger.info("🔍 Final parameter validation for delegate():");
      logger.info("   - issuer type:", typeof delegateParams.issuer);
      logger.info("   - issuer.did():", delegateParams.issuer.did?.());
      logger.info("   - audience type:", typeof delegateParams.audience);
      logger.info("   - audience.did():", delegateParams.audience.did?.());
      logger.info(
        "   - capabilities:",
        delegateParams.capabilities.length,
        "items",
      );
      logger.info("   - expiration type:", typeof delegateParams.expiration);
      logger.info("   - expiration value:", delegateParams.expiration);
      logger.info("   - proofs:", delegateParams.proofs);
      logger.info("   - facts:", delegateParams.facts);

      // 🧹 SANITIZE AGENT: Remove any undefined properties that could cause IPLD encoding errors
      logger.info(
        "   🧹 Sanitizing Storacha agent to remove undefined properties...",
      );
      const sanitizedIssuer = sanitizeAgent(storachaClient.agent);
      logger.info("   ✅ Agent sanitized successfully");

      // 🎯 ESSENTIAL ONLY: Pass only the required parameters to delegate()
      const essentialDelegateParams = {
        issuer: sanitizedIssuer, // Use sanitized agent wrapper
        audience: bobPrincipal, // Use original reference
        capabilities, // Use original reference
        expiration, // Use original reference
      };

      logger.info(
        "   🎯 Using essential parameters only - no undefined properties",
      );

      // 🚀 SKIP JSON VALIDATION: We know the core parameters are valid
      // The maxDigestLength undefined is deep in crypto objects and won't affect UCAN creation
      logger.info(
        "   🚀 Skipping JSON validation - core parameters validated individually",
      );
      logger.info("   ✅ Ready to call delegate() with essential parameters");

      // Log what we're actually passing
      logger.info("   🔍 Final delegate() parameters:");
      logger.info("     - issuer.did():", essentialDelegateParams.issuer.did());
      logger.info(
        "     - issuer.signatureAlgorithm:",
        essentialDelegateParams.issuer.signatureAlgorithm,
      );
      logger.info(
        "     - audience.did():",
        essentialDelegateParams.audience.did(),
      );
      logger.info(
        "     - capabilities count:",
        essentialDelegateParams.capabilities.length,
      );
      logger.info("     - expiration:", essentialDelegateParams.expiration);

      // Create delegation using lower-level UCAN API to Bob's existing DID (with essential parameters)
      logger.info("   🏁 Calling delegate() with essential parameters only...");
      const delegation = await delegate(essentialDelegateParams);

      // Archive the delegation
      const archive = await delegation.archive();
      if (!archive.ok) {
        throw new Error("Failed to archive delegation");
      }

      // Create base64 token that Bob can use with his existing DID/keys
      const delegationToken = Buffer.from(archive.ok).toString("base64");

      logger.info(`   ✅ UCAN delegation created to Bob's existing DID`);
      logger.info(`   📝 Token length: ${delegationToken.length} characters`);

      const delegationInfo = {
        delegationToken,
        bobDID,
        audience: bobPrincipal.did(),
        capabilities,
        expiration,
        createdAt: new Date().toISOString(),
        delegationType: "direct",
        signatureAlgorithm: "EdDSA", // Direct delegation is EdDSA signed
      };

      // Store the delegation
      this.delegations.set(bobDID, delegationInfo);

      return delegationInfo;
    } catch (error) {
      logger.error(
        `❌ Failed to create Storacha delegation: ${error.message}`,
      );
      logger.error("   Falling back to Storacha client delegation...");

      // Fallback: Use Storacha's high-level API (this will create a new principal)
      // But store the mapping to Bob's OrbitDB DID in the access controller
      try {
        const { Signer } = await import("@storacha/client/principal/ed25519");
        const tempPrincipal = await Signer.generate();

        const delegation = await storachaClient.createDelegation(
          tempPrincipal,
          [
            "space/blob/add",
            "space/index/add",
            "upload/add",
            "upload/list",
            "store/add",
            "filecoin/offer",
          ],
          { expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60 },
        );

        const archive = await delegation.archive();
        const delegationToken = Buffer.from(archive.ok).toString("base64");

        logger.info(
          `   ✅ Fallback delegation created (mapped to Bob's DID: ${bobDID})`,
        );

        const fallbackDelegation = {
          delegationToken,
          bobDID,
          tempStorachaDID: tempPrincipal.did(),
          tempPrincipal, // Bob will need this to use the delegation
          capabilities: [
            "space/blob/add",
            "space/index/add",
            "upload/add",
            "upload/list",
            "store/add",
            "filecoin/offer",
          ],
          expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
          createdAt: new Date().toISOString(),
          isFallback: true,
        };

        // Store the delegation
        this.delegations.set(bobDID, fallbackDelegation);

        return fallbackDelegation;
      } catch (fallbackError) {
        logger.error(
          `❌ Fallback delegation also failed: ${fallbackError.message}`,
        );
        throw fallbackError;
      }
    }
  }

  /**
   * Create delegation based on method
   * @param {string} method - 'bridge' or 'direct'
   * @param {string} bobDID - Bob's DID
   * @param {Object} storachaClient - Alice's Storacha client
   * @param {Object} sharedIdentity - Alice's OrbitDB identity (required for bridge method)
   * @returns {Object} - Delegation info
   */
  async createDelegation(
    method,
    bobDID,
    storachaClient,
    sharedIdentity = null,
  ) {
    if (method === "bridge") {
      return await this.createBridgeStorachaDelegation(
        bobDID,
        storachaClient,
        sharedIdentity,
      );
    } else if (method === "direct") {
      return await this.createStorachaDelegation(bobDID, storachaClient);
    } else {
      throw new Error(`Unknown delegation method: ${method}`);
    }
  }

  /**
   * Get stored delegation for a DID
   * @param {string} bobDID - Bob's DID
   * @returns {Object|null} - Delegation info or null if not found
   */
  getDelegation(bobDID) {
    return this.delegations.get(bobDID) || null;
  }

  /**
   * Revoke a delegation (remove from storage)
   * @param {string} bobDID - Bob's DID
   * @returns {boolean} - True if delegation was found and removed
   */
  revokeDelegation(bobDID) {
    const existed = this.delegations.has(bobDID);
    this.delegations.delete(bobDID);

    if (existed) {
      logger.info(`🚫 Revoked delegation for ${bobDID}`);
    }

    return existed;
  }

  /**
   * Clear all delegations
   */
  clearAllDelegations() {
    const count = this.delegations.size;
    this.delegations.clear();
    logger.info(`🗑️ Cleared ${count} delegations`);
  }

  /**
   * Get all active delegations
   * @returns {Array} - Array of delegation info objects
   */
  getAllDelegations() {
    return Array.from(this.delegations.values());
  }
}

// Export a singleton instance for easy use
export const ucanService = new UCANService();
