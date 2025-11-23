/**
 * OrbitDB Storacha Bridge - Logger
 *
 * Uses @libp2p/logger for consistent logging across the libp2p ecosystem.
 *
 * To enable logging:
 * - Node.js: DEBUG=libp2p:orbitdb-storacha:* node script.js
 * - Browser: localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')
 *
 * Available formatters:
 * - %s - string
 * - %o - object
 * - %d - number
 * - %p - peer ID
 * - %b - base58btc encoded data
 * - %t - base32 encoded data
 */

import { logger as libp2pLogger } from "@libp2p/logger";

// Create default logger for the orbitdb-storacha-bridge namespace
export const logger = libp2pLogger("libp2p:orbitdb-storacha:bridge");

/**
 * Create a child logger with a specific namespace
 * @param {string} namespace - Namespace for the child logger (will be appended to libp2p:orbitdb-storacha:)
 * @returns {Function} Logger function
 */
export function createChildLogger(namespace) {
  return libp2pLogger(`libp2p:orbitdb-storacha:${namespace}`);
}

/**
 * Create a logger for a specific component
 * @param {string} component - Component name
 * @returns {Function} Logger function
 */
export function createLogger(component) {
  return libp2pLogger(`libp2p:orbitdb-storacha:${component}`);
}

export const LOG_LEVELS = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
};

export const logUtils = {
  /**
   * Log function entry with parameters
   * @param {string} functionName - Name of the function
   * @param {Object} params - Function parameters
   * @param {Function} childLogger - Optional child logger
   */
  functionEntry: (functionName, params = {}, childLogger = logger) => {
    childLogger(`Entering ${functionName} with params: %o`, params);
  },

  /**
   * Log function exit with result
   * @param {string} functionName - Name of the function
   * @param {*} result - Function result
   * @param {Function} childLogger - Optional child logger
   */
  functionExit: (functionName, result, childLogger = logger) => {
    childLogger(`Exiting ${functionName} with result: %o`, result);
  },

  /**
   * Log operation progress
   * @param {string} operation - Operation name
   * @param {number} current - Current progress
   * @param {number} total - Total items
   * @param {Function} childLogger - Optional child logger
   */
  progress: (operation, current, total, childLogger = logger) => {
    const percentage = Math.round((current / total) * 100);
    childLogger(`${operation}: ${current}/${total} (${percentage}%)`);
  },

  /**
   * Log timing information
   * @param {string} operation - Operation name
   * @param {number} startTime - Start time (from Date.now())
   * @param {Function} childLogger - Optional child logger
   */
  timing: (operation, startTime, childLogger = logger) => {
    const duration = Date.now() - startTime;
    childLogger(`${operation} completed in ${duration}ms`);
  },
};

/**
 * Compatibility wrappers for common log levels
 * libp2p logger is a function, so we add these for convenience
 */
logger.info = logger;
logger.debug = logger;
logger.error = logger.error || logger;
logger.warn = logger;
logger.trace = logger;

/**
 * No-op functions for compatibility
 * libp2p logger is controlled via DEBUG environment variable
 */
export function setLogLevel(level) {
  // No-op: libp2p logger uses DEBUG env var
  logger(
    `setLogLevel called with ${level} - use DEBUG environment variable instead`,
  );
}

export function disableLogging() {
  // No-op: libp2p logger uses DEBUG env var
}

export function enableLogging(level = "info") {
  // No-op: libp2p logger uses DEBUG env var
  logger(
    `enableLogging called with ${level} - use DEBUG environment variable instead`,
  );
}

export default logger;
