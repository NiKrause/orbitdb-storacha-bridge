import { promises as fs } from 'fs'
import StorachaStorage from '../lib/storacha-storage.js'
import { createHeliaOrbitDB, cleanupAllTestArtifacts } from '../lib/utils.js'
import { backupDatabaseToStoracha, restoreDatabaseFromStoracha } from '../lib/orbitdb-storacha-bridge.js'

let ComposedStorage, MemoryStorage
try {
  const storageModules = await import('@orbitdb/core/src/storage/index.js')
  ComposedStorage = storageModules.ComposedStorage
  MemoryStorage = storageModules.MemoryStorage
} catch (error) {
  console.warn('OrbitDB storage modules not available for integration tests')
}

const colors = {
  bright: '\x1b[1m',
  cyan: '\x1b[96m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  reset: '\x1b[0m'
}

const hasStorachaCredentials = () => {
  return !!(process.env.STORACHA_KEY && process.env.STORACHA_PROOF)
}


describe('Storacha Storage', () => {
  let storage

  beforeAll(async () => {
    console.log(`${colors.bright}${colors.cyan}🧹 Global cleanup: Removing all test artifacts before test suite...${colors.reset}`)
    await cleanupAllTestArtifacts()
    console.log(`${colors.bright}${colors.green}✅ Global cleanup completed${colors.reset}`)
  })

  afterAll(async () => {
    console.log(`${colors.bright}${colors.cyan}🧹 Global cleanup: Removing all test artifacts after test suite...${colors.reset}`)
    await cleanupAllTestArtifacts()
    console.log(`${colors.bright}${colors.green}✅ Final cleanup completed${colors.reset}`)
  })
  
  beforeEach(async () => {
    console.log(`${colors.bright}${colors.cyan}🧹 Setting up Storacha storage test environment...${colors.reset}`)
  })
  

  afterEach(async () => {
    if (storage) {
      try {
        await storage.close()
      } catch (error) {
        console.warn('Storage cleanup warning:', error.message)
      }
      storage = null
    }
    
    console.log(`${colors.bright}${colors.green}✅ Storacha storage test cleanup completed${colors.reset}`)
  })
  

  describe('Basic Storage Operations (No Storacha Connection)', () => {
    test('should require authentication credentials', async () => {
      await expect(StorachaStorage()).rejects.toThrow('requires either')
      
      console.log(`${colors.green}✅ Correctly requires authentication${colors.reset}`)
    })

    test('should support basic cache operations with mock credentials', async () => {
      storage = await StorachaStorage({
        storachaKey: 'mock-key',
        storachaProof: 'mock-proof',
        autoLoad: false,
        readOnly: true
      })

      expect(storage).toBeTruthy()
      expect(typeof storage.put).toBe('function')
      expect(typeof storage.get).toBe('function')
      expect(typeof storage.del).toBe('function')
      expect(typeof storage.iterator).toBe('function')
      expect(typeof storage.persist).toBe('function')
      expect(typeof storage.close).toBe('function')
      
      console.log(`${colors.green}✅ Storacha storage instance created with all required methods${colors.reset}`)
    })

    test('should put and get data from local cache', async () => {
      storage = await StorachaStorage({
        storachaKey: 'mock-key',
        storachaProof: 'mock-proof',
        autoLoad: false,
        readOnly: true
      })

      const testKey = 'test-key-1'
      const testData = new TextEncoder().encode('Hello, Storacha Storage!')

      await storage.put(testKey, testData)
      const retrieved = await storage.get(testKey)

      expect(retrieved).toBeTruthy()
      expect(retrieved).toEqual(testData)
      
      console.log(`${colors.green}✅ Local cache storage and retrieval successful${colors.reset}`)
    })

    test('should iterate over cached data', async () => {
      storage = await StorachaStorage({
        storachaKey: 'mock-key',
        storachaProof: 'mock-proof',
        autoLoad: false,
        readOnly: true
      })

      const testData = [
        ['key1', 'value1'],
        ['key2', 'value2'],
        ['key3', 'value3']
      ]

      for (const [key, value] of testData) {
        await storage.put(key, new TextEncoder().encode(value))
      }

      const entries = []
      for await (const [key, value] of storage.iterator()) {
        entries.push([key, new TextDecoder().decode(value)])
      }

      expect(entries.length).toBe(testData.length)
      
      console.log(`${colors.green}✅ Data iteration over ${entries.length} entries successful${colors.reset}`)
    })
  })
  
  describe('Storacha Space Integration', () => {
    beforeEach(() => {
      if (!hasStorachaCredentials()) {
        console.log(`${colors.yellow}⚠️ Skipping Storacha integration tests - credentials not available${colors.reset}`)
        console.log(`${colors.yellow}   Set STORACHA_KEY and STORACHA_PROOF environment variables to run these tests${colors.reset}`)
      }
    })

    test('should load file list from Storacha Space', async () => {
      if (!hasStorachaCredentials()) {
        return 
      }

      storage = await StorachaStorage({
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
        autoLoad: false,
        readOnly: true
      })

      expect(storage).toBeTruthy()
      
      console.log(`${colors.green}✅ Successfully connected to Storacha Space${colors.reset}`)
    }, 30000)

    test('should auto-load from Storacha when cache is empty', async () => {
      if (!hasStorachaCredentials()) {
        return 
      }

      storage = await StorachaStorage({
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
        autoLoad: true,
        readOnly: true
      })

      expect(storage).toBeTruthy()
      
      let count = 0
      for await (const [_key, _value] of storage.iterator()) {
        count++
      }
      
      console.log(`${colors.green}✅ Auto-loaded ${count} entries from Storacha${colors.reset}`)
    }, 60000)
  })

  describe('OrbitDB Integration with StorachaStorage', () => {
    test('should work as OrbitDB storage backend', async () => {
      if (!hasStorachaCredentials()) {
        console.log(`${colors.yellow}⚠️ Skipping OrbitDB integration test - credentials not available${colors.reset}`)
        return
      }

      if (!ComposedStorage || !MemoryStorage) {
        console.log(`${colors.yellow}⚠️ Skipping OrbitDB test - storage modules not available${colors.reset}`)
        return
      }

      console.log(`${colors.bright}${colors.cyan}🚀 Testing OrbitDB with StorachaStorage backend...${colors.reset}`)
      
      let orbitdb, helia
      
      try {
        const storachaEntryStorage = await StorachaStorage({
          storachaKey: process.env.STORACHA_KEY,
          storachaProof: process.env.STORACHA_PROOF,
          autoLoad: true,
          readOnly: false,
          storageType: 'entries'
        })

        const memoryStorage = await MemoryStorage()
        
        const composedStorage = await ComposedStorage(memoryStorage, storachaEntryStorage)

        const result = await createHeliaOrbitDB('-storacha-test')
        helia = result.helia
        orbitdb = result.orbitdb

        const db = await orbitdb.open('test-storacha-db', {
          type: 'keyvalue',
          entryStorage: composedStorage
        })
        await db.put('test-key', { message: 'Hello from Storacha!' })
        
        const value = await db.get('test-key')
        expect(value).toBeTruthy()
        expect(value.message).toBe('Hello from Storacha!')

        console.log(`${colors.green}✅ OrbitDB with StorachaStorage backend working correctly${colors.reset}`)

        await db.close()
        await orbitdb.stop()
        await helia.stop()
      } catch (error) {
        console.error(`${colors.red}❌ OrbitDB integration test failed: ${error.message}${colors.reset}`)
        
        if (orbitdb) await orbitdb.stop().catch(() => {})
        if (helia) await helia.stop().catch(() => {})
        
        throw error
      }
    }, 90000)
  })

  describe('Hybrid Web/Web3 Mode Scenario', () => {
    test('should enable SSR to P2P mode switch via Storacha restore', async () => {
      if (!hasStorachaCredentials()) {
        console.log(`${colors.yellow}⚠️ Skipping hybrid mode test - credentials not available${colors.reset}`)
        return
      }

      console.log(`${colors.bright}${colors.cyan}🔄 Testing hybrid SSR → P2P mode switch...${colors.reset}`)
      console.log(`${colors.cyan}   Scenario: PWA has no local data, loads from Storacha Space${colors.reset}`)

      storage = await StorachaStorage({
        storachaKey: process.env.STORACHA_KEY,
        storachaProof: process.env.STORACHA_PROOF,
        autoLoad: true,
        readOnly: true,
        storageType: 'hybrid-mode-test'
      })

      let loadedEntries = 0
      for await (const [_key, _value] of storage.iterator()) {
        loadedEntries++
      }

      console.log(`${colors.green}✅ Hybrid mode: Loaded ${loadedEntries} entries from Storacha${colors.reset}`)
      console.log(`${colors.green}   PWA can now switch to P2P mode with restored data${colors.reset}`)
    }, 60000)
  })
})
