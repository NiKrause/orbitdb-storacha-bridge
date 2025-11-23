#!/usr/bin/env node
/**
 * Create a proper UCAN delegation from Storacha credentials
 * Then test authentication with ONLY the UCAN (no private key/proof needed)
 *
 * UPDATED: Now uses @storacha/client instead of @web3-storage/w3up-client
 */

import "dotenv/config";
import * as Client from "@storacha/client";
import { StoreMemory } from "@storacha/client/stores/memory";
import { Signer } from "@storacha/client/principal/ed25519";
import * as Proof from "@storacha/client/proof";
import * as Delegation from "@ucanto/core/delegation";
import { promises as fs } from "fs";
import { logger } from "../lib/logger.js";

async function createProperUCAN() {
  logger.info("🚀 Creating Proper UCAN from Storacha Credentials");
  logger.info("=".repeat(60));

  // Step 1: Check if we have the necessary Storacha credentials
  const storachaKey =
    process.env.STORACHA_KEY || process.env.NEXT_PUBLIC_STORACHA_PRIVATE_KEY;
  const storachaProof =
    process.env.STORACHA_PROOF || process.env.NEXT_PUBLIC_STORACHA_DELEGATION;

  logger.info(
    { hasKey: !!storachaKey, hasProof: !!storachaProof },
    `📋 Storacha Key: ${storachaKey ? "Present" : "Missing"}`,
  );
  logger.info(`📋 Storacha Proof: ${storachaProof ? "Present" : "Missing"}`);

  if (!storachaKey || !storachaProof) {
    logger.error("❌ Missing Storacha credentials!");
    logger.error("   Need: STORACHA_KEY and STORACHA_PROOF in .env");
    return null;
  }

  try {
    logger.info(
      "\\n🔐 Step 1: Initialize Storacha client with existing credentials...",
    );

    // Initialize the "authority" client (the one that can create delegations)
    const authorityPrincipal = Signer.parse(storachaKey);
    const store = new StoreMemory();
    const authorityClient = await Client.create({
      principal: authorityPrincipal,
      store,
    });

    logger.info(
      { authorityDID: authorityPrincipal.did() },
      `   ✅ Authority identity: ${authorityPrincipal.did()}`,
    );

    // Add the existing proof to get space access
    const proof = await Proof.parse(storachaProof);
    const space = await authorityClient.addSpace(proof);
    await authorityClient.setCurrentSpace(space.did());

    logger.info(
      { spaceDID: space.did() },
      `   ✅ Space connected: ${space.did()}`,
    );

    logger.info(
      "\\n🎯 Step 2: Create a new identity for delegation (recipient)...",
    );

    // Create a NEW identity that will receive the delegation
    const recipientPrincipal = await Signer.generate();
    logger.info(
      { recipientDID: recipientPrincipal.did() },
      `   ✅ Recipient identity: ${recipientPrincipal.did()}`,
    );

    logger.info("\\n📜 Step 3: Create UCAN delegation...");

    // Define the capabilities we want to delegate
    const capabilities = [
      "space/blob/add",
      "space/index/add",
      "upload/add",
      "upload/list", // Add listing capability
      "store/add",
      "filecoin/offer",
    ];

    logger.info(
      { capabilities, recipientDID: recipientPrincipal.did() },
      `   📋 Delegating capabilities: ${capabilities.join(", ")}`,
    );
    logger.info(`   🎯 To recipient: ${recipientPrincipal.did()}`);
    logger.info(`   ⏰ Expires in: 24 hours`);

    // Create the delegation
    const expiration = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

    const delegation = await authorityClient.createDelegation(
      recipientPrincipal, // Pass the principal object, not the DID string
      capabilities,
      { expiration },
    );

    logger.info("   ✅ UCAN delegation created!");

    logger.info("\\n💾 Step 4: Export UCAN delegation...");

    // Archive the delegation
    const archive = await delegation.archive();
    if (!archive.ok) {
      throw new Error("Failed to archive delegation");
    }

    // Save as base64 token (like w3 CLI does)
    const delegationToken = Buffer.from(archive.ok).toString("base64");
    logger.info(
      { size: delegationToken.length },
      `   📏 Delegation size: ${delegationToken.length} characters`,
    );
    logger.info(
      `   📋 Delegation preview: ${delegationToken.substring(0, 100)}...`,
    );

    // Print full base64 token in parallel
    logger.info("\n🔗 FULL BASE64 DELEGATION TOKEN:");
    logger.info("=".repeat(80));
    logger.info(delegationToken);
    logger.info("=".repeat(80));

    // Also save the base64 token to a separate file for easy copying
    const recipientKey = recipientPrincipal.toArchive();
    await Promise.all([
      fs.writeFile("ucan-delegation.car", archive.ok),
      fs.writeFile("recipient-key.txt", JSON.stringify(recipientKey, null, 2)),
      fs.writeFile("delegation-token.txt", delegationToken),
    ]);

    logger.info("   💾 Saved to: ucan-delegation.car");
    logger.info("   🔑 Recipient key saved to: recipient-key.txt");
    logger.info("   📋 Base64 token saved to: delegation-token.txt");

    logger.info("\\n🧪 Step 5: Test authentication with ONLY the UCAN...");

    // Now test if we can authenticate with ONLY the delegation
    await testUCANOnlyAuthentication(delegationToken, recipientPrincipal);

    return {
      delegation: delegationToken,
      recipientPrincipal,
      spaceDID: space.did(),
    };
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "❌ Error creating UCAN",
    );
    return null;
  }
}

async function testUCANOnlyAuthentication(delegationToken, recipientPrincipal) {
  logger.info("\\n🔬 Testing UCAN-only authentication...");

  try {
    // Create a NEW client session using ONLY the recipient identity and delegation
    const store = new StoreMemory();
    const client = await Client.create({
      principal: recipientPrincipal,
      store,
    });

    logger.info(
      { clientDID: recipientPrincipal.did() },
      `   🤖 Client identity: ${recipientPrincipal.did()}`,
    );

    // Parse the delegation token
    const delegationBytes = Buffer.from(delegationToken, "base64");
    const delegation = await Delegation.extract(delegationBytes);

    if (!delegation.ok) {
      throw new Error("Failed to extract delegation from token");
    }

    logger.info("   ✅ Delegation parsed successfully");
    logger.info(
      { capabilityCount: delegation.ok.capabilities.length },
      `   📋 Capabilities: ${delegation.ok.capabilities.length}`,
    );

    // Add the delegation as a space
    const space = await client.addSpace(delegation.ok);
    await client.setCurrentSpace(space.did());

    logger.info(
      { spaceDID: space.did() },
      `   ✅ Space connected via UCAN: ${space.did()}`,
    );

    logger.info("\\n📤 Step 6: Test file upload with UCAN authentication...");

    // Create a test file
    const testContent = `Hello from UCAN! Uploaded at ${new Date().toISOString()}`;
    const testFile = new File([testContent], "ucan-test.txt", {
      type: "text/plain",
    });

    logger.info(
      { fileName: testFile.name, fileSize: testFile.size },
      `   📄 Test file: ${testFile.name} (${testFile.size} bytes)`,
    );

    // Try to upload using ONLY UCAN authentication
    const result = await client.uploadFile(testFile);

    logger.info("   ✅ Upload successful with UCAN-only authentication!");
    logger.info({ cid: result.toString() }, `   🔗 Uploaded CID: ${result}`);
    logger.info(`   🌐 IPFS URL: https://w3s.link/ipfs/${result}`);

    logger.info("\\n🎉 SUCCESS! UCAN-only authentication works!");
    logger.info("\\n📋 Summary:");
    logger.info("   ✅ Created UCAN delegation from Storacha credentials");
    logger.info("   ✅ Authenticated with ONLY the UCAN token");
    logger.info("   ✅ Uploaded file without original private key/proof");
    logger.info("   ✅ No Storacha credentials needed for the upload!");

    return true;
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "❌ UCAN-only authentication failed",
    );
    return false;
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  createProperUCAN()
    .then((result) => {
      if (result) {
        logger.info("\\n🚀 Next Steps:");
        logger.info("   1. Use the delegation token in your OrbitDB bridge");
        logger.info(
          "   2. The recipient identity can be temporary or persistent",
        );
        logger.info(
          "   3. No original Storacha credentials needed for operations",
        );
        logger.info("\\n💡 This proves UCAN delegation works as intended!");
      } else {
        logger.error("\\n💥 Failed to create proper UCAN delegation");
      }
    })
    .catch((err) =>
      logger.error({ error: err.message, stack: err.stack }, "Error"),
    );
}

export { createProperUCAN };
