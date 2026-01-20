/**
 * Configuration for local.storage service
 * 
 * This configures tests to use a locally running w3up storage service
 * instead of production Storacha or in-memory test service.
 */

import * as client from '@ucanto/client';
import { CAR, HTTP } from '@ucanto/transport';
import * as DID from '@ipld/dag-ucan/did';

const localServiceURL = new URL('http://localhost:3000');
const localServicePrincipal = DID.parse('did:key:z6MktHg5dK59DyRbq2bdVr5x1u9NGbMyexbdtaGFF3Q9QJEP');

export const LOCAL_STORAGE_CONFIG = {
  // Service URL
  serviceURL: 'http://localhost:3000',
  
  // Service DID (from local.storage startup)
  serviceDID: 'did:key:z6MktHg5dK59DyRbq2bdVr5x1u9NGbMyexbdtaGFF3Q9QJEP',
  
  // Service configuration for @storacha/client
  serviceConf: {
    access: client.connect({
      id: localServicePrincipal,
      codec: CAR.outbound,
      channel: HTTP.open({
        url: localServiceURL,
        method: 'POST',
      }),
    }),
    upload: client.connect({
      id: localServicePrincipal,
      codec: CAR.outbound,
      channel: HTTP.open({
        url: localServiceURL,
        method: 'POST',
      }),
    }),
    filecoin: client.connect({
      id: localServicePrincipal,
      codec: CAR.outbound,
      channel: HTTP.open({
        url: localServiceURL,
        method: 'POST',
      }),
    }),
    gateway: client.connect({
      id: localServicePrincipal,
      codec: CAR.outbound,
      channel: HTTP.open({
        url: localServiceURL,
        method: 'POST',
      }),
    }),
  },
  
  // Receipts endpoint
  receiptsEndpoint: new URL('http://localhost:3000'),
};

/**
 * Check if local.storage service is running and get its configuration
 * @returns {Promise<{running: boolean, config?: object}>}
 */
export async function isLocalStorageRunning() {
  try {
    const response = await fetch('http://localhost:3000/version', {
      method: 'GET',
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      const config = await response.json();
      console.log('local.storage service info:', config);
      return { running: true, config };
    }
    return { running: false };
  } catch (error) {
    return { running: false };
  }
}

/**
 * Get local.storage service configuration dynamically
 * @returns {Promise<object|null>}
 */
export async function getLocalStorageConfig() {
  const { running, config } = await isLocalStorageRunning();
  if (!running || !config) {
    return null;
  }
  
  return {
    ...LOCAL_STORAGE_CONFIG,
    serviceDID: config.did,
    publicKey: config.publicKey,
    version: config.version,
  };
}
