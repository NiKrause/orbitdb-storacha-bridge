/**
 * Example: How Bob uses Alice's EdDSA delegation with his P-256 WebAuthn identity
 */

// Commented out unused imports
// import { invoke } from "@ucanto/core";
// import { Verifier } from "@ucanto/principal";
import { logger } from "../../../lib/logger.js";

/**
 * Bob creates a Storacha client using Alice's delegation
 * @param {Object} aliceDelegation - The EdDSA-signed delegation from Alice
 * @param {Object} bobWebAuthnSigner - Bob's P-256 WebAuthn signer
 * @param {string} bobDID - Bob's P-256 DID string
 */
export async function createBobStorachaClient(
  aliceDelegation,
  bobWebAuthnSigner,
  bobDID,
) {
  logger.info("🔄 Bob creating Storacha client with Alice's delegation...");

  // Import Storacha client
  const { create } = await import("@storacha/client");

  // Bob creates his own agent using his P-256 WebAuthn identity
  const bobAgent = {
    // Bob's P-256 DID and signing capability
    did: () => bobDID,
    sign: (payload) => bobWebAuthnSigner.sign(payload),
    signatureAlgorithm: "ES256", // P-256
    signatureCode: 64, // P-256 signature code
  };

  // Create Bob's Storacha client with Alice's delegation as proof
  const bobStorachaClient = await create({
    principal: bobAgent,
    store: new Map(), // In-memory store for this example

    // 🔑 KEY POINT: Bob includes Alice's delegation as proof
    // The delegation is EdDSA-signed by Alice, but Bob uses it with his P-256 identity
    proofs: [aliceDelegation], // Alice's EdDSA delegation
  });

  logger.info("✅ Bob can now use Storacha with Alice's permissions!");
  return bobStorachaClient;
}

/**
 * Bob uploads data to Storacha using Alice's delegation
 * @param {Object} bobStorachaClient - Bob's client with Alice's delegation
 * @param {File} file - File to upload
 */
export async function bobUploadToStoracha(bobStorachaClient, file) {
  logger.info("📤 Bob uploading file using Alice's delegation...");

  try {
    // Bob creates an invocation UCAN (signed with his P-256 keys)
    // and includes Alice's delegation (EdDSA-signed) as proof
    const result = await bobStorachaClient.uploadFile(file);

    logger.info("✅ Upload successful! Cross-algorithm delegation worked!");
    logger.info("   - Alice delegated with EdDSA");
    logger.info("   - Bob invoked with P-256");
    logger.info("   - Storacha verified both signatures");

    return result;
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "❌ Upload failed:");
    throw error;
  }
}

/**
 * The UCAN chain Bob creates looks like this:
 *
 * 1. Bob's Invocation UCAN (P-256 signed):
 *    {
 *      iss: "did:key:zDna...bob-p256",        // Bob's P-256 DID
 *      aud: "did:web:upload.web3.storage",    // Storacha
 *      att: [{ with: "space", can: "upload" }],
 *      prf: [aliceDelegation],                // Alice's EdDSA delegation!
 *      signature: "bob-p256-signature"        // Bob signs with P-256
 *    }
 *
 * 2. Alice's Delegation UCAN (EdDSA signed - included as proof):
 *    {
 *      iss: "did:key:z6Mk...alice-eddsa",     // Alice's EdDSA DID
 *      aud: "did:key:zDna...bob-p256",        // Bob's P-256 DID
 *      att: [{ with: "space", can: "upload" }],
 *      signature: "alice-eddsa-signature"     // Alice signed with EdDSA
 *    }
 *
 * Verification:
 * - Storacha verifies Bob's P-256 signature on the invocation
 * - Storacha verifies Alice's EdDSA signature on the delegation
 * - Chain is valid: Alice (EdDSA) → Bob (P-256) ✅
 */
