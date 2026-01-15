/**
 * Test Upload Service Helper
 * 
 * Sets up an in-memory Storacha upload service for testing without hitting
 * the live Storacha network. Based on @storacha/upload-api test utilities.
 * 
 * Usage:
 *   import { setupTestUploadService, createTestClient } from './helpers/test-upload-service.js'
 *   
 *   const testService = await setupTestUploadService()
 *   const client = await createTestClient(testService)
 *   // ... run tests ...
 *   await teardownTestUploadService(testService)
 */

import { createContext, cleanupContext } from '@storacha/upload-api/test/context';
import { createServer, connect } from '@storacha/upload-api';
import * as ed25519 from '@ucanto/principal/ed25519';
import { delegate } from '@ucanto/core';
import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import { Signer } from '@storacha/client/principal/ed25519';
import http from 'http';
import { once } from 'events';

/**
 * Create an in-memory upload service for testing
 * @param {Object} options - Configuration options
 * @param {boolean} options.requirePaymentPlan - Whether to require payment plans (default: false)
 * @param {boolean} options.withHTTP - Whether to create HTTP server (default: true)
 * @returns {Promise<Object>} Test service context with serverURL and cleanup method
 */
export async function setupTestUploadService(options = {}) {
  const { requirePaymentPlan = false, withHTTP = true } = options;

  // Create in-memory context (all storage is in-memory, no Docker/external services)
  const context = await createContext({
    requirePaymentPlan,
  });

  // Create connection to the service
  const connection = connect({
    id: context.id,
    channel: createServer(context),
  });

  let httpServer = null;
  let serverURL = null;

  if (withHTTP) {
    // Create HTTP server wrapper for compatibility with @storacha/client
    const httpResult = await createHTTPServer(context);
    httpServer = httpResult.server;
    serverURL = httpResult.serverURL;
  }

  return {
    context,
    connection,
    serviceDID: context.id.did(),
    httpServer,
    serverURL,
  };
}

/**
 * Cleanup test upload service
 */
export async function teardownTestUploadService(testService) {
  // Close HTTP server if exists
  if (testService?.httpServer) {
    await new Promise((resolve, reject) => {
      testService.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Cleanup context
  if (testService?.context) {
    await cleanupContext(testService.context);
  }
}

/**
 * Create a test space and provision it with the upload service
 * @param {Object} testService - Test service from setupTestUploadService
 * @param {string} spaceName - Optional space name
 * @returns {Promise<Object>} Space info with agent, space, proof, and DID
 */
export async function createTestSpace(testService, spaceName = 'test-space') {
  const { context } = testService;

  // Create space identity using ucanto ed25519 (same as ucan-upload-wall)
  const space = await ed25519.generate();
  const spaceDid = space.did();

  // Create agent identity using ucanto ed25519
  const spaceAgent = await ed25519.generate();

  // Create delegation from space to agent using raw delegate
  const spaceProof = await delegate({
    issuer: space,
    audience: spaceAgent,
    capabilities: [{ can: '*', with: spaceDid }],
    expiration: Infinity,
  });

  // Provision the space (register with upload service)
  await context.provisionsStorage.put({
    cause: spaceProof.cid,
    consumer: spaceDid,
    customer: context.id.did(),
    provider: context.id.did(),
  });

  return {
    space,
    spaceDid,
    spaceAgent,
    spaceProof,
    spaceName,
  };
}

/**
 * Create a Storacha client configured to use the test service
 * 
 * NOTE: This requires an HTTP server wrapper around the test service.
 * For direct testing without HTTP, use testService.connection directly.
 * 
 * @param {Object} testService - Test service from setupTestUploadService
 * @param {URL} serverURL - HTTP server URL (if available)
 * @param {Object} principal - Principal/signer for the client
 * @returns {Promise<Object>} Storacha client configured for test service
 */
export async function createTestClient(testService, serverURL, principal) {
  if (!serverURL) {
    throw new Error(
      'HTTP server URL required for @storacha/client. ' +
      'Use testService.connection for direct invocations without HTTP.'
    );
  }

  const store = new StoreMemory();
  const client = await Client.create({
    principal: principal || (await Signer.generate()),
    store,
    // Point client to test service instead of production
    serviceConf: {
      access: serverURL,
      upload: serverURL,
    },
    receiptsEndpoint: serverURL,
  });

  return client;
}

/**
 * Create delegation from one principal to another
 * @param {Object} options - Delegation options
 * @returns {Promise<Object>} Delegation
 */
export async function createTestDelegation(options) {
  const {
    space,
    issuer,
    audience,
    capabilities = null,
    proofs = [],
    expiration = undefined,
  } = options;

  const caps = capabilities || [
    { with: space.spaceDid, can: 'store/add' },
    { with: space.spaceDid, can: 'upload/add' },
    { with: space.spaceDid, can: 'upload/list' },
  ];

  return await delegate({
    issuer,
    audience,
    capabilities: caps,
    proofs,
    expiration,
  });
}

/**
 * Helper to create test credentials (key + proof) for backward compatibility
 * with existing tests that use STORACHA_KEY/STORACHA_PROOF pattern
 * 
 * This creates credentials in the same format as production Storacha,
 * allowing existing backup functions to work with the test service.
 * 
 * @param {Object} testService - Test service from setupTestUploadService
 * @returns {Promise<Object>} Test credentials { storachaKey, storachaProof, space, serverURL }
 */
export async function createTestCredentials(testService) {
  const space = await createTestSpace(testService);
  
  // Export space agent key in the format expected by Signer.parse()
  const agentArchive = space.spaceAgent.toArchive();
  const storachaKey = JSON.stringify(agentArchive);
  
  // Export space proof as base64 (same format as STORACHA_PROOF env var)
  // Note: Proof.parse() expects plain base64, not multibase format
  const proofArchive = await space.spaceProof.archive();
  if (!proofArchive.ok) {
    throw new Error('Failed to archive space proof');
  }
  const storachaProof = Buffer.from(proofArchive.ok).toString('base64');

  return {
    storachaKey,
    storachaProof,
    space,
    serverURL: testService.serverURL,
  };
}

/**
 * Create UCANTO invocation config for direct capability invocations
 * This bypasses @storacha/client to avoid JWT encoding issues
 * 
 * @param {Object} testService - Test service from setupTestUploadService
 * @returns {Promise<Object>} { connection, invocationConfig }
 */
export async function createUCANTOConfig(testService) {
  const space = await createTestSpace(testService);
  
  return {
    connection: testService.connection,
    invocationConfig: {
      issuer: space.spaceAgent,
      audience: testService.context.id,
      with: space.spaceDid,
      proofs: [space.spaceProof],
    },
    space,
  };
}

/**
 * Create HTTP server wrapper for the in-memory upload service
 * This allows @storacha/client to connect to the test service via HTTP
 * 
 * @param {Object} context - Upload service context
 * @returns {Promise<Object>} HTTP server and URL
 */
export async function createHTTPServer(context) {
  const server = createServer(context);

  const listener = async (req, res) => {
    try {
      // Parse request body
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      // Forward request to UCANTO service
      const response = await server.request({
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])
        ),
        body,
      });

      // Send response
      res.writeHead(response.status || 200, {
        'Content-Type': 'application/car',
        ...Object.fromEntries(
          Object.entries(response.headers || {}).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(', ') : v,
          ])
        ),
      });

      if (response.body) {
        res.write(response.body);
      }
      res.end();
    } catch (error) {
      console.error('HTTP server error:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  };

  const httpServer = http.createServer(listener);
  httpServer.listen();
  await once(httpServer, 'listening');

  const address = httpServer.address();
  const serverURL = new URL(`http://127.0.0.1:${address.port}`);

  return {
    server: httpServer,
    serverURL,
  };
}

/**
 * Wrapper for tests - automatically sets up and tears down test service
 * 
 * @param {Function} testFn - Test function that receives testService
 * @param {Object} options - Options for setupTestUploadService
 * @example
 *   await withTestService(async (testService) => {
 *     const space = await createTestSpace(testService)
 *     // ... run your test ...
 *   })
 */
export async function withTestService(testFn, options = {}) {
  const testService = await setupTestUploadService(options);
  try {
    await testFn(testService);
  } finally {
    await teardownTestUploadService(testService);
  }
}

/**
 * Create a working UCAN client that can upload to the test service
 * This avoids the JWT encoding issue by using proper UCAN client initialization
 * 
 * @param {Object} testService - Test service from setupTestUploadService  
 * @returns {Promise<Object>} { client, spaceDID }
 */
export async function createWorkingUCANClient(testService) {
  if (!testService.serverURL) {
    throw new Error('Test service must have HTTP server (serverURL) for @storacha/client');
  }
  
  // Create space
  const space = await createTestSpace(testService);
  
  // Create a proper w3up client with the space
  // IMPORTANT: Must configure serviceConf to point to test service
  const store = new StoreMemory();
  const client = await Client.create({
    principal: space.spaceAgent,
    store,
    serviceConf: {
      access: testService.serverURL,
      upload: testService.serverURL,
    },
    receiptsEndpoint: testService.serverURL,
  });
  
  // Add the space to the client using the proof
  await client.addSpace(space.spaceProof);
  await client.setCurrentSpace(space.spaceDid);
  
  return {
    client,
    spaceDID: space.spaceDid,
    space,
  };
}

/**
 * Get a block from the test service's storage
 * @param {Object} testService - Test service from setupTestUploadService
 * @param {string} cid - CID of the block to retrieve
 * @returns {Promise<Uint8Array|null>} Block bytes or null if not found
 */
export async function getBlockFromTestService(testService, cid) {
  try {
    const { context } = testService;
    // The context.blocks is a blockstore that implements get(cid)
    const block = await context.blocks.get(cid);
    return block?.bytes || null;
  } catch (error) {
    // Block not found
    return null;
  }
}
