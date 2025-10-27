/**
 * AgentSanitizer - Wrapper to clean undefined properties from Storacha agents
 *
 * This addresses the IPLD encoding error: "undefined is not supported by the IPLD Data Model"
 * which can occur when Storacha agents have internal properties set to undefined.
 */

import { logger } from "../../../lib/logger.js";

/**
 * Detect signature algorithm from DID or agent properties
 * @param {Object} agent - The agent to analyze
 * @returns {string} - The signature algorithm
 */
function detectSignatureAlgorithm(agent) {
  // First try to get from agent properties
  if (agent.signatureAlgorithm && agent.signatureAlgorithm !== undefined) {
    return agent.signatureAlgorithm;
  }

  // Try to detect from DID format
  try {
    const did = agent.did();
    if (did && typeof did === "string") {
      // Extract the multibase part from did:key: format
      if (did.startsWith("did:key:")) {
        // const keyPart = did.slice(8); // Remove 'did:key:' prefix
        // Different key types have different prefixes when base58btc decoded
        // For now, default to ES256 which works for most cases
        return "ES256";
      }
    }
  } catch (error) {
    logger.warn({ error: error.message }, "Could not detect signature algorithm from DID:");
  }

  // Default fallback
  return "ES256";
}

/**
 * Detect signature code from agent or algorithm
 * @param {Object} agent - The agent to analyze
 * @param {string} algorithm - The detected algorithm
 * @returns {number} - The signature code
 */
function detectSignatureCode(agent, algorithm) {
  // First try to get from agent properties
  if (agent.signatureCode && agent.signatureCode !== undefined) {
    return agent.signatureCode;
  }

  // Map algorithm to code
  switch (algorithm) {
    case "ES256":
      return 1;
    case "ES384":
      return 2;
    case "ES512":
      return 3;
    case "EdDSA":
      return 0;
    default:
      return 1; // Default to ES256
  }
}

/**
 * Creates a sanitized wrapper around a Storacha agent that removes undefined properties
 * @param {Object} agent - The original Storacha agent
 * @returns {Object} - A sanitized agent wrapper
 */
export function sanitizeAgent(agent) {
  if (!agent) {
    throw new Error("Agent is required for sanitization");
  }

  // Debug: Inspect the original agent
  logger.info("🔍 Agent sanitization debugging:");
  logger.info("   - Agent type:", typeof agent);
  logger.info("   - Agent constructor:", agent.constructor?.name);
  logger.info("   - Agent has did():", typeof agent.did === "function");
  logger.info("   - Agent has sign():", typeof agent.sign === "function");
  logger.info("   - Agent has issuer:", !!agent.issuer);
  logger.info("   - Agent.issuer type:", typeof agent.issuer);
  logger.info(
    "   - Agent.issuer has sign():",
    agent.issuer && typeof agent.issuer.sign === "function",
  );
  logger.info("   - Agent signatureAlgorithm:", agent.signatureAlgorithm);
  logger.info("   - Agent signatureCode:", agent.signatureCode);

  // For Storacha _Agent, the actual signer is in the issuer property
  const actualSigner = agent.issuer || agent;
  logger.info("   - Using actual signer:", actualSigner.constructor?.name);
  logger.info(
    "   - Actual signer has sign():",
    typeof actualSigner.sign === "function",
  );
  logger.info(
    "   - Actual signer signatureAlgorithm:",
    actualSigner.signatureAlgorithm,
  );

  // Detect signature algorithm and code from the actual signer
  const detectedAlgorithm = detectSignatureAlgorithm(actualSigner);
  const detectedCode = detectSignatureCode(actualSigner, detectedAlgorithm);

  logger.info(
    `   - Detected algorithm="${detectedAlgorithm}", code=${detectedCode}`,
  );

  // Additional check for signing capability
  if (typeof actualSigner.sign !== "function") {
    const agentKeys = Object.getOwnPropertyNames(agent).concat(
      Object.getOwnPropertyNames(Object.getPrototypeOf(agent)),
    );
    const methods = agentKeys.filter((key) => typeof agent[key] === "function");
    logger.error(
      "⚠️ WARNING: Neither agent nor agent.issuer has a sign() method!",
    );
    logger.info("   - Agent methods:", methods.slice(0, 10));
    throw new Error("Cannot find a signing method in agent or agent.issuer");
  }

  // Create a clean wrapper that only exposes the necessary methods and properties
  const sanitizedAgent = {
    // Essential methods for UCAN delegation
    did() {
      return agent.did();
    },

    async sign(payload) {
      logger.info("🔐 Forwarding sign() call to actual signer...");
      try {
        const result = await actualSigner.sign(payload);
        logger.info("✅ Sign operation completed successfully");
        return result;
      } catch (error) {
        logger.error("❌ Sign operation failed:", error);
        throw error;
      }
    },

    // Essential properties for UCAN delegation (guaranteed not undefined)
    get signatureAlgorithm() {
      return detectedAlgorithm;
    },

    get signatureCode() {
      return detectedCode;
    },
  };

  // Only add defined properties from the original agent
  const allowedProperties = ["code", "name", "version", "type"];

  for (const prop of allowedProperties) {
    if (agent[prop] !== undefined) {
      sanitizedAgent[prop] = agent[prop];
    }
  }

  return sanitizedAgent;
}

/**
 * Deep sanitize an object to remove all undefined values
 * @param {any} obj - Object to sanitize
 * @returns {any} - Sanitized object
 */
export function deepSanitize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj === undefined ? null : obj;
  }

  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item !== undefined)
      .map((item) => deepSanitize(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      sanitized[key] = deepSanitize(value);
    }
  }

  return sanitized;
}
