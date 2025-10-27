/**
 * Identity Service - Handles WebAuthn and Mnemonic identity creation
 * Extracted from StorachaTestWithWebAuthn.svelte for better maintainability
 */

import { Identities, useIdentityProvider } from "@orbitdb/core";
import OrbitDBIdentityProviderDID from "@orbitdb/identity-provider-did";
import { Ed25519Provider } from "key-did-provider-ed25519";
import * as KeyDIDResolver from "key-did-resolver";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { createHash } from "crypto";
import {
  WebAuthnDIDProvider,
  OrbitDBWebAuthnIdentityProviderFunction,
  registerWebAuthnProvider,
  checkWebAuthnSupport,
  storeWebAuthnCredential,
  loadWebAuthnCredential,
} from "@le-space/orbitdb-identity-provider-webauthn-did";
import { logger } from "../../../../lib/logger.js";

export class IdentityService {
  constructor() {
    this.webAuthnSupported = false;
    this.webAuthnPlatformAvailable = false;
    this.webAuthnSupportMessage = "";
    this.webAuthnChecking = true;
  }

  /**
   * Initialize WebAuthn support detection
   */
  async initializeWebAuthnSupport() {
    try {
      const support = await checkWebAuthnSupport();
      this.webAuthnSupported = support.supported;
      this.webAuthnPlatformAvailable = support.platformAuthenticator;
      this.webAuthnSupportMessage = support.message;

      logger.info(
        "WebAuthn support detected, provider will be registered when creating identity",
      );
      return {
        supported: this.webAuthnSupported,
        platformAvailable: this.webAuthnPlatformAvailable,
        message: this.webAuthnSupportMessage,
      };
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "WebAuthn support check failed:");
      this.webAuthnSupportMessage = "Unable to check WebAuthn support";
      throw error;
    } finally {
      this.webAuthnChecking = false;
    }
  }

  /**
   * Convert 64-bit seed to 32-bit seed (same as deContact)
   */
  convertTo32BitSeed(origSeed) {
    const hash = createHash("sha256");
    hash.update(Buffer.from(origSeed, "hex"));
    return hash.digest();
  }

  /**
   * Convert Uint8Array to hex (browser-safe)
   */
  toHex(u8) {
    return Array.from(u8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Generate master seed from mnemonic
   */
  generateMasterSeed(mnemonicSeedphrase, password = "password") {
    return this.toHex(mnemonicToSeedSync(mnemonicSeedphrase, password));
  }

  /**
   * Create a reusable OrbitDB identity from seed (mnemonic-based)
   */
  async createMnemonicIdentity(persona = "shared") {
    logger.info(`🆔 Creating ${persona} identity from mnemonic...`);

    // Generate a test seed phrase for consistent identity
    const seedPhrase = generateMnemonic(english);
    const masterSeed = this.generateMasterSeed(
      seedPhrase,
      `${persona}-password`,
    );
    const seed32 = this.convertTo32BitSeed(masterSeed);

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
  async createWebAuthnIdentity(persona = "shared") {
    logger.info(`🆔 Creating ${persona} identity with WebAuthn...`);

    if (!this.webAuthnSupported) {
      throw new Error("WebAuthn is not supported in this browser");
    }

    // Create or load WebAuthn credential (persona-specific storage key)
    const storageKey = `webauthn-credential-${persona}`;
    let webauthnCredential = loadWebAuthnCredential(storageKey);

    if (!webauthnCredential) {
      // Create new WebAuthn credential for this specific persona
      logger.info(`🔐 Creating NEW WebAuthn credential for ${persona}...`);
      webauthnCredential = await WebAuthnDIDProvider.createCredential({
        userId: `${persona}@orbitdb.org`,
        displayName: `OrbitDB ${persona} Identity`,
      });
      // Store credential with persona-specific key
      storeWebAuthnCredential(webauthnCredential, storageKey);
      logger.info(
        `🔐 New WebAuthn credential created and stored for ${persona}`,
      );
      logger.info(`   🏷️ Storage key: ${storageKey}`);
      logger.info(
        `   🆔 Credential ID: ${webauthnCredential.credentialId?.slice(0, 16)}...`,
      );
    } else {
      logger.info(`🔐 Existing WebAuthn credential loaded for ${persona}`);
      logger.info(`   🏷️ Storage key: ${storageKey}`);
      logger.info(
        `   🆔 Credential ID: ${webauthnCredential.credentialId?.slice(0, 16)}...`,
      );
    }

    // Register the WebAuthn provider (like DID provider does)
    useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);

    // Create OrbitDB identities instance with default keystore
    const identities = await Identities();

    // Ensure the WebAuthn provider is registered with OrbitDB
    logger.info("🔧 Registering WebAuthn identity provider with OrbitDB...");

    const registrationSuccess = registerWebAuthnProvider();
    logger.info("📋 Registration result:", registrationSuccess);

    if (!registrationSuccess) {
      throw new Error("Failed to register WebAuthn provider with OrbitDB");
    }

    // Create the identity using OrbitDB's standard identity creation
    logger.info(
      "🆔 Creating WebAuthn identity via OrbitDB identities.createIdentity...",
    );
    const identity = await identities.createIdentity({
      provider: OrbitDBWebAuthnIdentityProviderFunction({ webauthnCredential }),
    });

    logger.info("✅ Created OrbitDB-compatible WebAuthn identity:", {
      id: identity.id,
      type: identity.type,
      publicKey: identity.publicKey,
      hasSign: typeof identity.sign === "function",
      hasVerify: typeof identity.verify === "function",
      hasHash: !!identity.hash,
    });

    // Test the signing function directly
    await this.testIdentitySigning(identity);

    // Test identity resolution
    await this.testIdentityResolution(identity, identities);

    logger.info(`✅ ${persona} WebAuthn identity created: ${identity.id}`);
    return { identity, identities, webauthnCredential };
  }

  /**
   * Test identity signing functionality
   */
  async testIdentitySigning(identity) {
    logger.info("🔍 Testing WebAuthn identity signing function directly...");
    try {
      const testData = "test-signing-data";
      logger.info(
        "🧪 Calling identity.sign() with test data - this should trigger WebAuthn!",
      );

      const testSignature = await identity.sign(identity, testData);
      logger.info("✅ Direct signing test successful!");
      logger.info("   📏 Signature length:", testSignature?.length);
      logger.info(
        "   🔤 Signature preview:",
        testSignature?.slice(0, 64) + "...",
      );

      // Try to decode as WebAuthn proof
      try {
        const proofBytes = new Uint8Array(
          Array.from(
            atob(testSignature.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        );
        const proofText = new TextDecoder().decode(proofBytes);
        const webauthnProof = JSON.parse(proofText);
        logger.info(
          "   🎉 SUCCESS: Direct signing produced WebAuthn proof format!",
        );
        logger.info(
          "   🆔 Credential ID in proof:",
          webauthnProof.credentialId?.slice(0, 16) + "...",
        );
      } catch (decodeError) {
        logger.info(
          "   ⚠️ WARNING: Direct signing did NOT produce WebAuthn proof format",
        );
        logger.info(
          "   📝 Signature appears to be:",
          testSignature?.startsWith("30")
            ? "DER-encoded ECDSA"
            : "Unknown format",
        );
      }
    } catch (signError) {
      logger.info("❌ Direct signing test failed:", signError.message);
      logger.info(
        "   ⚠️ This explains why OrbitDB falls back to default signing!",
      );
      throw signError;
    }
  }

  /**
   * Test identity resolution
   */
  async testIdentityResolution(identity, identities) {
    logger.info("🔍 Testing identity resolution...");
    logger.info(`   🆔 Identity ID: ${identity.id}`);
    logger.info(`   📦 Identity hash: ${identity.hash}`);

    // Try resolving by both ID and hash
    const resolvedByID = await identities.getIdentity(identity.id);
    const resolvedByHash = await identities.getIdentity(identity.hash);

    logger.info(`   🔍 Resolved by ID: ${resolvedByID ? "✅" : "❌"}`);
    logger.info(`   🔍 Resolved by hash: ${resolvedByHash ? "✅" : "❌"}`);

    if (resolvedByID || resolvedByHash) {
      logger.info(
        "✅ Identity resolution test passed - access controller should work",
      );
      return true;
    } else {
      logger.warn(
        "⚠️ Identity resolution test failed - this may cause access control issues",
      );
      return false;
    }
  }

  /**
   * Get WebAuthn support status
   */
  getWebAuthnStatus() {
    return {
      supported: this.webAuthnSupported,
      platformAvailable: this.webAuthnPlatformAvailable,
      message: this.webAuthnSupportMessage,
      checking: this.webAuthnChecking,
    };
  }

  /**
   * Create identity based on method
   */
  async createIdentity(method, persona = "shared") {
    if (method === "webauthn") {
      return await this.createWebAuthnIdentity(persona);
    } else if (method === "mnemonic") {
      return await this.createMnemonicIdentity(persona);
    } else {
      throw new Error(`Unknown identity method: ${method}`);
    }
  }
}

// Export a singleton instance for easy use
export const identityService = new IdentityService();
