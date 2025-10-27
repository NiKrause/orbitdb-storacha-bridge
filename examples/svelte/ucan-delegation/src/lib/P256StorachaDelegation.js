/**
 * Create UCAN delegation using Alice's P-256 OrbitDB identity
 * This bypasses Storacha's EdDSA agent and uses Alice's WebAuthn P-256 keys directly
 */

import { delegate } from "@le-space/ucanto-client";
import { Verifier } from "@le-space/ucanto-principal";

/**
 * Create Storacha delegation using Alice's P-256 OrbitDB identity
 * @param {Object} aliceP256Signer - Alice's P-256 OrbitDB signer (from WebAuthn)
 * @param {string} bobP256DID - Bob's P-256 DID string
 * @param {string} storachaSpaceDID - Alice's Storacha space DID
 * @returns {Object} P-256 signed delegation
 */
export async function createP256StorachaDelegation(
  aliceP256Signer,
  bobP256DID,
  storachaSpaceDID,
) {
  console.log("🎯 Creating P-256 Storacha delegation...");
  console.log(`   - Alice P-256 DID: ${aliceP256Signer.did()}`);
  console.log(`   - Bob P-256 DID: ${bobP256DID}`);
  console.log(`   - Storacha Space: ${storachaSpaceDID}`);

  try {
    // Create P-256 verifier for Bob
    const bobVerifier = Verifier.parse(bobP256DID);

    // Define Storacha capabilities Alice wants to delegate
    const capabilities = [
      { with: storachaSpaceDID, can: "space/blob/add" },
      { with: storachaSpaceDID, can: "space/index/add" },
      { with: storachaSpaceDID, can: "upload/add" },
      { with: storachaSpaceDID, can: "upload/list" },
      { with: storachaSpaceDID, can: "store/add" },
      { with: storachaSpaceDID, can: "filecoin/offer" },
    ];

    // Create delegation signed with Alice's P-256 keys
    const delegation = await delegate({
      issuer: aliceP256Signer, // Alice's P-256 WebAuthn signer
      audience: bobVerifier, // Bob's P-256 DID
      capabilities: capabilities, // Storacha permissions
      expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
    });

    console.log("✅ P-256 delegation created successfully!");
    console.log(`   - Signed by: ${aliceP256Signer.did()} (P-256)`);
    console.log(`   - Delegated to: ${bobP256DID} (P-256)`);
    console.log(`   - Capabilities: ${capabilities.length} permissions`);

    return delegation;
  } catch (error) {
    console.error("❌ P-256 delegation creation failed:", error);
    throw error;
  }
}

/**
 * The key question: Can Storacha accept P-256 signed delegations?
 *
 * UCAN spec supports P-256, but Storacha service might expect:
 * 1. Delegations signed by EdDSA keys (their standard)
 * 2. Specific space ownership proofs
 * 3. Service-specific validation
 *
 * This would work if:
 * - Alice's P-256 DID is somehow associated with the Storacha space
 * - Storacha service validates P-256 signatures (not just EdDSA)
 * - The space DID accepts P-256 issuer delegations
 */

/**
 * Alternative approach: Create a "bridge" delegation
 * Alice's EdDSA Storacha agent delegates to Alice's P-256 OrbitDB DID,
 * then Alice's P-256 DID delegates to Bob's P-256 DID
 */
export async function createBridgeDelegation(
  storachaClient,
  aliceP256Signer,
  bobP256DID,
) {
  console.log("🌉 Creating bridge delegation: EdDSA → P-256 → P-256");

  try {
    // Step 1: Storacha EdDSA agent delegates to Alice's P-256 DID
    const { delegate } = await import("@le-space/ucanto-client/delegation");
    const { Verifier } = await import("@le-space/ucanto-principal");

    const aliceP256Verifier = Verifier.parse(aliceP256Signer.did());
    const spaceDID = storachaClient.currentSpace().did();

    const eddsaToP256Delegation = await delegate({
      issuer: storachaClient.agent, // Alice's EdDSA Storacha agent
      audience: aliceP256Verifier, // Alice's P-256 OrbitDB DID
      capabilities: [
        { with: spaceDID, can: "space/blob/add" },
        { with: spaceDID, can: "space/index/add" },
        { with: spaceDID, can: "upload/add" },
        { with: spaceDID, can: "store/add" },
      ],
      expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });

    console.log("✅ Step 1: EdDSA → P-256 delegation created");

    // Step 2: Alice's P-256 DID delegates to Bob's P-256 DID
    const bobVerifier = Verifier.parse(bobP256DID);

    const p256ToP256Delegation = await delegate({
      issuer: aliceP256Signer, // Alice's P-256 OrbitDB signer
      audience: bobVerifier, // Bob's P-256 DID
      capabilities: [
        { with: spaceDID, can: "space/blob/add" },
        { with: spaceDID, can: "space/index/add" },
        { with: spaceDID, can: "upload/add" },
        { with: spaceDID, can: "store/add" },
      ],
      proofs: [eddsaToP256Delegation], // Include the EdDSA delegation as proof!
      expiration: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });

    console.log("✅ Step 2: P-256 → P-256 delegation created");
    console.log("🌉 Bridge delegation complete: EdDSA → P-256 → P-256");

    return {
      eddsaToP256: eddsaToP256Delegation,
      p256ToP256: p256ToP256Delegation,
      finalDelegation: p256ToP256Delegation, // Bob uses this
    };
  } catch (error) {
    console.error("❌ Bridge delegation failed:", error);
    throw error;
  }
}

/**
 * Usage example for Bob:
 *
 * Bob would use the p256ToP256Delegation when creating Storacha invocations.
 * The delegation chain would be:
 * 1. Alice EdDSA (Storacha) → Alice P-256 (OrbitDB)
 * 2. Alice P-256 (OrbitDB) → Bob P-256 (OrbitDB)  ← Bob uses this
 *
 * When Bob makes a request, the validation chain is:
 * - Storacha verifies Alice's EdDSA signature on delegation #1
 * - Storacha verifies Alice's P-256 signature on delegation #2
 * - Storacha verifies Bob's P-256 signature on the invocation
 *
 * Result: Bob can use Storacha with his P-256 WebAuthn identity! 🎉
 */
