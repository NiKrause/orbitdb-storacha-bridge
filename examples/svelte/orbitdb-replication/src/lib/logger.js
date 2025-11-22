/**
 * Browser-compatible logger using @libp2p/logger
 * 
 * To enable logging in browser console:
 * localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')
 * Then refresh the page
 */

import { logger as libp2pLogger } from "@libp2p/logger";

// Create default logger for the orbitdb-replication app
export const logger = libp2pLogger("libp2p:orbitdb-storacha:orbitdb-replication");

/**
 * Create a child logger with a specific namespace
 * @param {string} namespace - Namespace for the child logger
 * @returns {Function} Logger function
 */
export function createChildLogger(namespace) {
  return libp2pLogger(`libp2p:orbitdb-storacha:orbitdb-replication:${namespace}`);
}

/**
 * Compatibility wrappers for common log levels
 */
logger.info = logger;
logger.debug = logger;
logger.error = logger.error || logger;
logger.warn = logger;
logger.trace = logger;

export default logger;
