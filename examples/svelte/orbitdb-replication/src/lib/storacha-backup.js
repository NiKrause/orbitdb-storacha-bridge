/**
 * Storacha Authentication and Management Functions for Demo
 *
 * Provides various authentication methods for Storacha:
 * - Email-based account creation
 * - Key/Proof credentials
 * - UCAN delegation
 * - Seed phrase derived identities
 */

import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { Signer } from "@storacha/client/principal/ed25519";
import * as Proof from "@storacha/client/proof";
import * as Delegation from "@ucanto/core/delegation";
import * as ed25519 from "@ucanto/principal/ed25519";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { createHash } from "crypto";

/**
 * Initialize Storacha client with key/proof credentials
 */
export async function initializeStorachaClient(storachaKey, storachaProof) {
  try {
    console.log("🔐 Initializing Storacha client with credentials...");

    const principal = Signer.parse(storachaKey);
    const store = new StoreMemory();
    const client = await Client.create({ principal, store });

    const proof = await Proof.parse(storachaProof);
    const space = await client.addSpace(proof);
    await client.setCurrentSpace(space.did());

    console.log(`✅ Storacha client initialized with space: ${space.did()}`);
    return client;
  } catch (error) {
    console.error("❌ Failed to initialize Storacha client:", error);
    throw error;
  }
}

/**
 * Initialize Storacha client with UCAN delegation
 */
export async function initializeStorachaClientWithUCAN(
  ucanToken,
  recipientKey,
) {
  try {
    console.log("🔐 Initializing Storacha client with UCAN...");

    // Parse recipient identity from JSON archive
    const recipientKeyData = JSON.parse(recipientKey);
    const fixedArchive = {
      id: recipientKeyData.id,
      keys: {
        [recipientKeyData.id]: new Uint8Array(
          Object.values(recipientKeyData.keys[recipientKeyData.id]),
        ),
      },
    };

    const recipientPrincipal = Signer.from(fixedArchive);
    const store = new StoreMemory();
    const client = await Client.create({
      principal: recipientPrincipal,
      store,
    });

    // Parse delegation token
    const delegationBytes = Buffer.from(ucanToken, "base64");
    const delegation = await Delegation.extract(delegationBytes);

    if (!delegation.ok) {
      throw new Error("Failed to extract delegation from token");
    }

    // Add space using delegation
    const space = await client.addSpace(delegation.ok);
    await client.setCurrentSpace(space.did());

    console.log(
      `✅ Storacha client initialized with UCAN space: ${space.did()}`,
    );
    return client;
  } catch (error) {
    console.error("❌ Failed to initialize Storacha client with UCAN:", error);
    throw error;
  }
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
 * Create Storacha identity from seed phrase
 */
export async function createStorachaIdentityFromSeed(
  seedPhrase,
  password = "password",
  derivationIndex = 1,
) {
  try {
    console.log("🌱 Creating Storacha identity from seed phrase...");

    const masterSeed = generateMasterSeed(seedPhrase, password);
    const seed32 = convertTo32BitSeed(masterSeed);

    // Create derived seed for Storacha (different from OrbitDB)
    const derivedSeed = new Uint8Array(32);
    derivedSeed.set(seed32);
    derivedSeed[31] ^= derivationIndex; // Derivation index

    const principal = await ed25519.derive(derivedSeed);
    const signer = Signer.from(principal.toArchive());

    console.log(`✅ Storacha identity created: ${signer.did()}`);
    return {
      principal: signer,
      did: signer.did(),
      privateKey: signer.toArchive(),
      seedPhrase,
      masterSeed,
    };
  } catch (error) {
    console.error("❌ Failed to create Storacha identity from seed:", error);
    throw error;
  }
}

/**
 * Initialize Storacha client with seed-derived identity and delegation
 */
export async function initializeStorachaClientWithSeed(
  seedPhrase,
  password = "password",
  delegationToken = null,
) {
  try {
    console.log("🌱 Initializing Storacha client with seed phrase...");

    const identity = await createStorachaIdentityFromSeed(seedPhrase, password);
    const store = new StoreMemory();
    const client = await Client.create({
      principal: identity.principal,
      store,
    });

    if (delegationToken) {
      // Use provided delegation
      const delegationBytes = Buffer.from(delegationToken, "base64");
      const delegation = await Delegation.extract(delegationBytes);

      if (!delegation.ok) {
        throw new Error("Failed to extract delegation from token");
      }

      const space = await client.addSpace(delegation.ok);
      await client.setCurrentSpace(space.did());

      console.log(
        `✅ Storacha client initialized with seed + delegation: ${space.did()}`,
      );
    } else {
      console.log(
        `✅ Storacha client initialized with seed identity: ${identity.did}`,
      );
      console.log("⚠️ No delegation provided - limited functionality");
    }

    return { client, identity };
  } catch (error) {
    console.error("❌ Failed to initialize Storacha client with seed:", error);
    throw error;
  }
}

/**
 * Create new Storacha account with email (placeholder - requires w3 CLI integration)
 */
export async function createStorachaAccount(email) {
  try {
    console.log(`📧 Creating Storacha account for: ${email}`);

    // This is a placeholder - in reality, this would integrate with w3 CLI
    // or require the user to manually create an account
    return {
      success: false,
      message:
        "Account creation requires manual setup. Please visit web3.storage to create an account and get your credentials.",
      error: "Manual setup required",
    };
  } catch (error) {
    console.error("❌ Failed to create Storacha account:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * List spaces for authenticated client
 */
export async function listSpaces(client) {
  try {
    console.log("📋 Listing Storacha spaces...");

    const spaces = [];

    // Try to get current space
    const currentSpace = client.currentSpace();
    if (currentSpace) {
      spaces.push({
        did: currentSpace.did(),
        name: currentSpace.name || "Current Space",
      });
    }

    // Try to get accounts and their spaces
    try {
      const accounts = client.accounts();
      for (const account of accounts) {
        const accountSpaces = account.spaces();
        for (const space of accountSpaces) {
          const spaceInfo = {
            did: space.did(),
            name: space.name || "Unnamed Space",
          };

          // Avoid duplicates
          if (!spaces.find((s) => s.did === spaceInfo.did)) {
            spaces.push(spaceInfo);
          }
        }
      }
    } catch (accountError) {
      console.warn("⚠️ Could not list account spaces:", accountError.message);
    }

    console.log(`✅ Found ${spaces.length} spaces`);
    return spaces;
  } catch (error) {
    console.error("❌ Failed to list spaces:", error);
    throw error;
  }
}

/**
 * Create new space
 */
export async function createSpace(client, spaceName) {
  try {
    console.log(`🆕 Creating space: ${spaceName}`);

    // This requires account-based authentication
    const accounts = client.accounts();
    if (accounts.length === 0) {
      throw new Error(
        "No accounts found - space creation requires account-based authentication",
      );
    }

    const account = accounts[0];
    const space = await account.createSpace(spaceName);

    console.log(`✅ Space created: ${space.did()}`);
    return {
      success: true,
      space: {
        did: space.did(),
        name: spaceName,
      },
    };
  } catch (error) {
    console.error("❌ Failed to create space:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Generate a new seed phrase
 */
export function generateSeedPhrase() {
  return generateMnemonic(english);
}

/**
 * Validate seed phrase
 */
export function validateSeedPhrase(seedPhrase) {
  try {
    // Basic validation - check if it's a valid mnemonic
    const words = seedPhrase.trim().split(/\s+/);
    return words.length >= 12 && words.length <= 24;
  } catch (error) {
    return false;
  }
}
