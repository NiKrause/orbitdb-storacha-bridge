/**
 * @module CARStorage
 * @description
 * A custom storage implementation that uses CAR (Content Addressable Archive) files
 * for persistent storage in OrbitDB. This storage can be used with ComposedStorage
 * for hybrid memory/CAR file storage solutions.
 */

import { CarWriter, CarReader } from '@ipld/car'
import { CID } from 'multiformats/cid'
import { createWriteStream, createReadStream } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'

/**
 * Creates an instance of CARStorage.
 * @function
 * @param {Object} options Configuration options for CAR storage
 * @param {string} options.path The directory path where CAR files will be stored
 * @param {string} [options.name='orbitdb-data'] The base name for CAR files
 * @param {boolean} [options.autoFlush=true] Whether to automatically flush to CAR files
 * @param {number} [options.flushThreshold=100] Number of operations before auto-flush
 * @return {module:Storage} An instance of CARStorage
 */

import { logger } from './logger.js'
const CARStorage = async ({ path, name = 'orbitdb-data', autoFlush = true, flushThreshold = 100 } = {}) => {
  if (!path) {
    throw new Error('CARStorage requires a path parameter')
  }

  // Ensure the directory exists
  await fs.mkdir(path, { recursive: true })

  // In-memory cache for fast access
  const cache = new Map()
  
  // Track modifications for auto-flush
  let operationCount = 0
  let isModified = false
  
  // CAR file paths
  const getCarPath = (suffix = '') => join(path, `${name}${suffix}.car`)
  const primaryCarPath = getCarPath()
  
  /**
   * Loads existing data from CAR file into memory cache
   */
  const loadFromCAR = async () => {
    try {
      const stats = await fs.stat(primaryCarPath)
      if (stats.isFile()) {
        logger.info(`Loading existing CAR file: ${primaryCarPath}`)
        
        const inStream = createReadStream(primaryCarPath)
        const reader = await CarReader.fromIterable(inStream)
        
        const { decode } = await import('@ipld/dag-cbor')
        
        for await (const { cid, bytes } of reader.blocks()) {
          try {
            // Decode the wrapped data
            const decoded = decode(bytes)
            if (decoded && decoded.originalKey && decoded.value) {
              // Restore the original key-value mapping
              cache.set(decoded.originalKey, decoded.value)
            } else {
              // Fallback: use CID as key and raw value
              cache.set(cid.toString(), bytes)
            }
          } catch (error) {
            // Fallback: use CID as key and raw value
            cache.set(cid.toString(), bytes)
          }
        }
        
        logger.info(`Loaded ${cache.size} entries from CAR file`)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Error loading CAR file: ${error.message}`)
      }
    }
  }

  /**
   * Flushes in-memory cache to CAR file
   */
  const flushToCAR = async () => {
    if (!isModified || cache.size === 0) {
      return
    }

    logger.info(`Flushing ${cache.size} entries to CAR file`)
    
    try {
      // Create a temporary CAR file
      const tempCarPath = getCarPath('.tmp')
      const outStream = createWriteStream(tempCarPath)
      
      // Collect all blocks for the CAR file
      const blocks = []
      const roots = []
      const keyToCidMap = new Map()
      
      // Import SHA-256 hasher
      const { sha256 } = await import('multiformats/hashes/sha2')
      const { encode } = await import('@ipld/dag-cbor')
      
      for (const [key, value] of cache.entries()) {
        try {
          let cid
          
          if (typeof key === 'string' && key.startsWith('zdpu')) {
            // Try to convert OrbitDB hash format to CID
            try {
              const hash = key.slice(4) // Remove 'zdpu' prefix
              cid = CID.parse(`bafyre${hash.slice(1)}`) // Convert to IPFS CID format
            } catch {
              // If conversion fails, generate a CID from the key
              const keyData = new TextEncoder().encode(key)
              const hash = await sha256.digest(keyData)
              cid = CID.create(1, 0x55, hash) // version 1, raw codec, sha256 hash
            }
          } else {
            try {
              cid = CID.parse(key)
            } catch {
              // Generate a CID from the key for arbitrary strings
              const keyData = new TextEncoder().encode(key)
              const hash = await sha256.digest(keyData)
              cid = CID.create(1, 0x55, hash) // version 1, raw codec, sha256 hash
            }
          }
          
          // Store the mapping for later retrieval
          keyToCidMap.set(key, cid.toString())
          
          // Create a wrapper object that includes both key and value
          const blockData = {
            originalKey: key,
            value: value
          }
          
          const encodedBlock = encode(blockData)
          blocks.push({ cid, bytes: encodedBlock })
          
          // Add first block as root for CAR structure
          if (roots.length === 0) {
            roots.push(cid)
          }
        } catch (error) {
          logger.warn(`Error processing entry ${key}:`, error.message)
        }
      }
      
      if (blocks.length > 0) {
        const { writer, out } = CarWriter.create(roots)
        
        // Pipe to file
        Readable.from(out).pipe(outStream)
        
        // Add all blocks
        for (const { cid, bytes } of blocks) {
          await writer.put({ cid, bytes })
        }
        
        await writer.close()
        
        // Wait for file write to complete
        await new Promise((resolve, reject) => {
          outStream.on('finish', resolve)
          outStream.on('error', reject)
        })
        
        // Replace old CAR file with new one
        try {
          await fs.unlink(primaryCarPath)
        } catch (error) {
          // Ignore if file doesn't exist
        }
        
        await fs.rename(tempCarPath, primaryCarPath)
        
        isModified = false
        operationCount = 0
        
        logger.info(`Successfully flushed to CAR file: ${primaryCarPath}`)
      }
    } catch (error) {
      logger.error(`Error flushing to CAR file: ${error.message}`)
      throw error
    }
  }

  /**
   * Auto-flush if threshold is reached
   */
  const checkAutoFlush = async () => {
    operationCount++
    if (autoFlush && operationCount >= flushThreshold) {
      await flushToCAR()
    }
  }

  // Load existing data on initialization
  await loadFromCAR()

  /**
   * Puts data to the CAR storage.
   * @function
   * @param {string} hash The hash of the data to put.
   * @param {Uint8Array} data The data to store.
   */
  const put = async (hash, data) => {
    if (!hash) {
      throw new Error('Hash is required for put operation')
    }
    
    // Store data exactly as provided - no conversion
    cache.set(hash, data)
    isModified = true
    
    await checkAutoFlush()
  }

  /**
   * Gets data from the CAR storage.
   * @function
   * @param {string} hash The hash of the data to get.
   * @return {Uint8Array|undefined} The stored data or undefined if not found.
   */
  const get = async (hash) => {
    // Return data exactly as stored - no conversion
    return cache.get(hash)
  }

  /**
   * Deletes data from the CAR storage.
   * @function
   * @param {string} hash The hash of the data to delete.
   */
  const del = async (hash) => {
    const existed = cache.delete(hash)
    if (existed) {
      isModified = true
      await checkAutoFlush()
    }
  }

  /**
   * Iterates over records in the CAR storage.
   * @function
   * @param {Object} options Iterator options
   * @param {number} [options.amount=-1] Number of items to return (-1 for all)
   * @param {boolean} [options.reverse=false] Whether to reverse the iteration order
   * @yields {Array} [key, value] pairs
   */
  const iterator = async function* ({ amount = -1, reverse = false } = {}) {
    const entries = Array.from(cache.entries())
    
    if (reverse) {
      entries.reverse()
    }
    
    let count = 0
    for (const [key, value] of entries) {
      if (amount > 0 && count >= amount) {
        break
      }
      yield [key, value]
      count++
    }
  }

  /**
   * Merges data from another storage into the CAR storage.
   * @function
   * @param {module:Storage} other Another storage instance.
   */
  const merge = async (other) => {
    if (!other || typeof other.iterator !== 'function') {
      throw new Error('Other storage must implement iterator method')
    }

    for await (const [key, value] of other.iterator()) {
      await put(key, value)
    }
  }

  /**
   * Clears all data from the CAR storage.
   * @function
   */
  const clear = async () => {
    cache.clear()
    isModified = true
    
    // Remove CAR file
    try {
      await fs.unlink(primaryCarPath)
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Forces a flush to the CAR file (persist operation).
   * @function
   * @param {string} [hash] Optional specific hash to persist (currently ignored)
   */
  const persist = async (_hash) => {
    await flushToCAR()
  }

  /**
   * Closes the CAR storage and ensures all data is persisted.
   * @function
   */
  const close = async () => {
    await flushToCAR()
  }

  return {
    put,
    get,
    del,
    iterator,
    merge,
    clear,
    persist,
    close
  }
}

export default CARStorage
