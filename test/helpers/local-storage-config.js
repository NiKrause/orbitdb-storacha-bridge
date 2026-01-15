/**
 * Configuration for local.storage service
 * 
 * This configures tests to use a locally running w3up storage service
 * instead of production Storacha or in-memory test service.
 */

export const LOCAL_STORAGE_CONFIG = {
  // Service URL
  serviceURL: 'http://localhost:3000',
  
  // Service DID (from local.storage startup)
  serviceDID: 'did:key:z6MktHg5dK59DyRbq2bdVr5x1u9NGbMyexbdtaGFF3Q9QJEP',
  
  // Service configuration for @storacha/client
  serviceConf: {
    access: new URL('http://localhost:3000'),
    upload: new URL('http://localhost:3000'),
  },
  
  // Receipts endpoint
  receiptsEndpoint: new URL('http://localhost:3000'),
};

/**
 * Check if local.storage service is running
 * @returns {Promise<boolean>}
 */
export async function isLocalStorageRunning() {
  try {
    const response = await fetch('http://localhost:3000', {
      method: 'HEAD',
      signal: AbortSignal.timeout(1000),
    });
    return response.ok || response.status === 404; // Service might return 404 for root
  } catch (error) {
    return false;
  }
}
