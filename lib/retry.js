/**
 * Retry utility with exponential backoff for OrbitDB Storacha Bridge
 * 
 * Provides configurable retry logic for handling transient network errors
 * and API rate limiting with exponential backoff strategy.
 */

import logger from './logger.js';

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterMs: 100,
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'fetch failed',
    'network error',
    'rate limit',
    'too many requests',
    '429',
    '503',
    '504',
  ],
};

/**
 * Check if an error is retryable based on error message/code
 * 
 * @param {Error} error - Error to check
 * @param {Array<string>} retryableErrors - List of retryable error patterns
 * @returns {boolean} - True if error is retryable
 */
export function isRetryableError(error, retryableErrors = DEFAULT_RETRY_CONFIG.retryableErrors) {
  if (!error) return false;

  const errorString = error.toString().toLowerCase();
  const errorCode = error.code?.toLowerCase() || '';
  const errorMessage = error.message?.toLowerCase() || '';
  const statusCode = error.status?.toString() || error.statusCode?.toString() || '';

  return retryableErrors.some(pattern => {
    const lowerPattern = pattern.toLowerCase();
    return (
      errorString.includes(lowerPattern) ||
      errorCode.includes(lowerPattern) ||
      errorMessage.includes(lowerPattern) ||
      statusCode.includes(lowerPattern)
    );
  });
}

/**
 * Calculate delay with exponential backoff and jitter
 * 
 * @param {number} attemptNumber - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} - Delay in milliseconds
 */
export function calculateBackoffDelay(attemptNumber, config = DEFAULT_RETRY_CONFIG) {
  const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterMs } = config;

  // Calculate exponential delay: initialDelay * (multiplier ^ attempt)
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attemptNumber);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add random jitter to prevent thundering herd
  const jitter = Math.random() * jitterMs;

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff
 * 
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries] - Maximum number of retries
 * @param {number} [options.initialDelayMs] - Initial delay in milliseconds
 * @param {number} [options.maxDelayMs] - Maximum delay in milliseconds
 * @param {number} [options.backoffMultiplier] - Backoff multiplier
 * @param {number} [options.jitterMs] - Random jitter in milliseconds
 * @param {Array<string>} [options.retryableErrors] - List of retryable error patterns
 * @param {Function} [options.onRetry] - Callback called before each retry
 * @param {string} [options.operationName] - Name of operation for logging
 * @returns {Promise<any>} - Result of the operation
 * @throws {Error} - Throws the last error if all retries fail
 */
export async function retryWithBackoff(operation, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };
  const { maxRetries, onRetry, operationName = 'Operation' } = config;

  let lastError;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      // Attempt the operation
      const result = await operation();
      
      // Log success if this was a retry
      if (attempt > 0) {
        logger.info(`${operationName} succeeded after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
      }
      
      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry = attempt < maxRetries && isRetryableError(error, config.retryableErrors);

      if (!shouldRetry) {
        // Either max retries reached or non-retryable error
        if (attempt >= maxRetries) {
          logger.error(`${operationName} failed after ${maxRetries} retries: ${error.message}`);
        } else {
          logger.error(`${operationName} failed with non-retryable error: ${error.message}`);
        }
        throw error;
      }

      // Calculate delay and log retry attempt
      const delay = calculateBackoffDelay(attempt, config);
      logger.warn(
        `${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. ` +
        `Retrying in ${delay}ms...`
      );

      // Call onRetry callback if provided
      if (onRetry) {
        try {
          await onRetry(error, attempt, delay);
        } catch (callbackError) {
          logger.warn(`onRetry callback failed: ${callbackError.message}`);
        }
      }

      // Wait before retrying
      await sleep(delay);
      attempt++;
    }
  }

  // This should never be reached, but just in case
  throw lastError;
}

/**
 * Retry a batch of operations with individual retry logic
 * 
 * @param {Array<Function>} operations - Array of async functions to execute
 * @param {Object} options - Retry options (same as retryWithBackoff)
 * @returns {Promise<Array<{success: boolean, result?: any, error?: Error}>>}
 */
export async function retryBatch(operations, options = {}) {
  const results = await Promise.allSettled(
    operations.map((operation, index) =>
      retryWithBackoff(operation, {
        ...options,
        operationName: options.operationName 
          ? `${options.operationName} [${index + 1}/${operations.length}]`
          : `Batch operation ${index + 1}/${operations.length}`,
      })
    )
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return { success: true, result: result.value, index };
    } else {
      return { success: false, error: result.reason, index };
    }
  });
}

/**
 * Create a retry wrapper for a function
 * 
 * @param {Function} fn - Function to wrap with retry logic
 * @param {Object} options - Retry options
 * @returns {Function} - Wrapped function with retry logic
 */
export function withRetry(fn, options = {}) {
  return async (...args) => {
    return retryWithBackoff(() => fn(...args), options);
  };
}

export default {
  retryWithBackoff,
  retryBatch,
  withRetry,
  isRetryableError,
  calculateBackoffDelay,
  sleep,
  DEFAULT_RETRY_CONFIG,
};
