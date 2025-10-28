/**
 * Tests for retry utility with exponential backoff
 */

import { jest } from '@jest/globals';
import {
  retryWithBackoff,
  retryBatch,
  withRetry,
  isRetryableError,
  calculateBackoffDelay,
  sleep,
  DEFAULT_RETRY_CONFIG,
} from '../lib/retry.js';

describe('Retry Utility', () => {
  describe('isRetryableError', () => {
    it('should identify network errors as retryable', () => {
      const errors = [
        new Error('ECONNRESET'),
        new Error('ETIMEDOUT'),
        new Error('fetch failed'),
        new Error('network error occurred'),
        { code: 'ENOTFOUND', message: 'DNS lookup failed' },
        { status: 429, message: 'Too Many Requests' },
        { statusCode: 503, message: 'Service Unavailable' },
      ];

      errors.forEach(error => {
        expect(isRetryableError(error)).toBe(true);
      });
    });

    it('should identify non-retryable errors', () => {
      const errors = [
        new Error('Invalid input'),
        new Error('Authentication failed'),
        { status: 400, message: 'Bad Request' },
        { status: 401, message: 'Unauthorized' },
        { status: 404, message: 'Not Found' },
      ];

      errors.forEach(error => {
        expect(isRetryableError(error)).toBe(false);
      });
    });

    it('should handle null/undefined errors', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should calculate exponential backoff correctly', () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitterMs: 0,
      };

      expect(calculateBackoffDelay(0, config)).toBe(1000); // 1000 * 2^0
      expect(calculateBackoffDelay(1, config)).toBe(2000); // 1000 * 2^1
      expect(calculateBackoffDelay(2, config)).toBe(4000); // 1000 * 2^2
      expect(calculateBackoffDelay(3, config)).toBe(8000); // 1000 * 2^3
    });

    it('should cap delay at maxDelayMs', () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
        jitterMs: 0,
      };

      expect(calculateBackoffDelay(10, config)).toBe(5000);
    });

    it('should add jitter to delay', () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitterMs: 100,
      };

      const delay = calculateBackoffDelay(0, config);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100);
    });
  });

  describe('sleep', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
      expect(elapsed).toBeLessThan(150);
    });
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      
      const result = await retryWithBackoff(operation, {
        maxRetries: 3,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable errors', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const result = await retryWithBackoff(operation, {
        maxRetries: 3,
        initialDelayMs: 10,
        jitterMs: 0,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable errors', async () => {
      const operation = jest.fn()
        .mockRejectedValue(new Error('Invalid input'));

      await expect(
        retryWithBackoff(operation, {
          maxRetries: 3,
          initialDelayMs: 10,
        })
      ).rejects.toThrow('Invalid input');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retries', async () => {
      const operation = jest.fn()
        .mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(
        retryWithBackoff(operation, {
          maxRetries: 2,
          initialDelayMs: 10,
          jitterMs: 0,
        })
      ).rejects.toThrow('ETIMEDOUT');

      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should call onRetry callback', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const onRetry = jest.fn();

      await retryWithBackoff(operation, {
        maxRetries: 2,
        initialDelayMs: 10,
        jitterMs: 0,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.any(Error),
        0, // attempt number
        expect.any(Number) // delay
      );
    });

    it('should handle onRetry callback errors gracefully', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const onRetry = jest.fn().mockRejectedValue(new Error('Callback error'));

      const result = await retryWithBackoff(operation, {
        maxRetries: 2,
        initialDelayMs: 10,
        onRetry,
      });

      expect(result).toBe('success');
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryBatch', () => {
    it('should retry all operations in batch', async () => {
      const operations = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn()
          .mockRejectedValueOnce(new Error('ETIMEDOUT'))
          .mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3'),
      ];

      const results = await retryBatch(operations, {
        maxRetries: 2,
        initialDelayMs: 10,
        jitterMs: 0,
      });

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ success: true, result: 'result1', index: 0 });
      expect(results[1]).toEqual({ success: true, result: 'result2', index: 1 });
      expect(results[2]).toEqual({ success: true, result: 'result3', index: 2 });

      expect(operations[0]).toHaveBeenCalledTimes(1);
      expect(operations[1]).toHaveBeenCalledTimes(2);
      expect(operations[2]).toHaveBeenCalledTimes(1);
    });

    it('should handle batch failures', async () => {
      const operations = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      ];

      const results = await retryBatch(operations, {
        maxRetries: 1,
        initialDelayMs: 10,
        jitterMs: 0,
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ success: true, result: 'result1', index: 0 });
      expect(results[1]).toEqual({ 
        success: false, 
        error: expect.any(Error), 
        index: 1 
      });
    });
  });

  describe('withRetry', () => {
    it('should create a wrapped function with retry logic', async () => {
      const originalFn = jest.fn((x, y) => Promise.resolve(x + y));
      const wrappedFn = withRetry(originalFn, {
        maxRetries: 2,
        initialDelayMs: 10,
      });

      const result = await wrappedFn(2, 3);

      expect(result).toBe(5);
      expect(originalFn).toHaveBeenCalledWith(2, 3);
    });

    it('should retry wrapped function on failure', async () => {
      const originalFn = jest.fn()
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue('success');

      const wrappedFn = withRetry(originalFn, {
        maxRetries: 2,
        initialDelayMs: 10,
        jitterMs: 0,
      });

      const result = await wrappedFn('arg1', 'arg2');

      expect(result).toBe('success');
      expect(originalFn).toHaveBeenCalledTimes(2);
      expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
      expect(DEFAULT_RETRY_CONFIG.jitterMs).toBe(100);
      expect(Array.isArray(DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(true);
      expect(DEFAULT_RETRY_CONFIG.retryableErrors.length).toBeGreaterThan(0);
    });
  });
});
