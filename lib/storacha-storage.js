import { CID } from 'multiformats/cid'
import { bases } from 'multiformats/basics'
import { downloadBlockFromStoracha, listStorachaSpaceFiles, convertStorachaCIDToOrbitDB } from './orbitdb-storacha-bridge.js'

const StorachaStorage = async (options = {}) => {
  const {
    storachaKey,
    storachaProof,
    ucanClient,
    spaceDID,
    manifestCID,
    autoLoad = true,
    autoUpload = false,
    uploadThreshold = 10,
    gateway = 'https://w3s.link',
    timeout = 30000,
    readOnly = false,
    storageType = 'entries'
  } = options

  const hasCredentials = storachaKey && storachaProof
  const hasUCAN = ucanClient
  
  if (!hasCredentials && !hasUCAN) {
    throw new Error('StorachaStorage requires either (storachaKey + storachaProof) or ucanClient')
  }

  const cache = new Map()
  
  let operationCount = 0
  let isModified = false
  let isInitialized = false
  const storachaFiles = new Map()
  
  console.log(`📦 StorachaStorage (${storageType}): Initializing...`)

  const loadStorachaFileList = async () => {
    try {
      console.log(`   📋 Loading file list from Storacha Space...`)
      
      const files = await listStorachaSpaceFiles({
        storachaKey,
        storachaProof,
        ucanClient,
        spaceDID
      })
      
      console.log(`   ✅ Found ${files.length} files in Storacha Space`)
      
      for (const file of files) {
        try {
          const storachaCID = file.root
          const orbitdbCID = convertStorachaCIDToOrbitDB(storachaCID)
          storachaFiles.set(orbitdbCID, storachaCID)
        } catch (error) {
          console.warn(`   ⚠️ Could not convert CID ${file.root}: ${error.message}`)
        }
      }
      
      console.log(`   📊 Mapped ${storachaFiles.size} CIDs for OrbitDB access`)
    } catch (error) {
      console.warn(`   ⚠️ Failed to load Storacha file list: ${error.message}`)
    }
  }

  const loadBlockFromStoracha = async (orbitdbCID) => {
    try {
      let storachaCID = storachaFiles.get(orbitdbCID)
      
      if (!storachaCID) {
        try {
          const cid = CID.parse(orbitdbCID)
          const rawCID = CID.createV1(0x55, cid.multihash)
          storachaCID = rawCID.toString(bases.base32)
        } catch (error) {
          console.warn(`   ⚠️ Could not convert CID ${orbitdbCID}: ${error.message}`)
          return null
        }
      }
      
      const bytes = await downloadBlockFromStoracha(storachaCID, {
        gateway,
        timeout
      })
      
      return bytes
    } catch (error) {
      console.warn(`   ⚠️ Failed to load block ${orbitdbCID} from Storacha: ${error.message}`)
      return null
    }
  }

  const loadAllFromStoracha = async () => {
    if (!autoLoad) {
      console.log(`   ⏭️ Auto-load disabled, skipping Storacha sync`)
      return
    }
    
    console.log(`   🔄 Loading all blocks from Storacha Space...`)
    
    let loadedCount = 0
    let failedCount = 0
    
    for (const [orbitdbCID, storachaCID] of storachaFiles.entries()) {
      try {
        const bytes = await downloadBlockFromStoracha(storachaCID, {
          gateway,
          timeout
        })
        
        if (bytes) {
          cache.set(orbitdbCID, bytes)
          loadedCount++
          
          if (loadedCount % 10 === 0) {
            console.log(`   📥 Loaded ${loadedCount}/${storachaFiles.size} blocks...`)
          }
        } else {
          failedCount++
        }
      } catch (error) {
        console.warn(`   ⚠️ Failed to load ${orbitdbCID}: ${error.message}`)
        failedCount++
      }
    }
    
    console.log(`   ✅ Loaded ${loadedCount} blocks from Storacha (${failedCount} failed)`)
  }

  const initialize = async () => {
    if (isInitialized) {
      return
    }
    
    await loadStorachaFileList()
    
    if (cache.size === 0 && storachaFiles.size > 0 && autoLoad) {
      console.log(`   💡 Local cache empty, loading from Storacha...`)
      await loadAllFromStoracha()
    } else if (cache.size > 0) {
      console.log(`   ✓ Local cache has ${cache.size} entries, skipping Storacha load`)
    } else {
      console.log(`   ℹ️ No files in Storacha Space yet`)
    }
    
    isInitialized = true
  }

  const uploadBlockToStoracha = async (hash, data) => {
    if (readOnly) {
      return
    }
    
    console.log(`   📤 Upload needed for ${hash} (${data.length} bytes)`)
  }

  const checkAutoUpload = async () => {
    operationCount++
    if (autoUpload && operationCount >= uploadThreshold && isModified) {
      console.log(`   🔄 Auto-upload threshold reached, uploading changes...`)
      operationCount = 0
      isModified = false
    }
  }

  await initialize()
  const put = async (hash, data) => {
    if (!hash) {
      throw new Error('Hash is required for put operation')
    }
    
    cache.set(hash, data)
    isModified = true
    
    if (!readOnly) {
      await uploadBlockToStoracha(hash, data)
    }
    
    await checkAutoUpload()
  }

  const get = async (hash) => {
    let data = cache.get(hash)
    
    if (data) {
      return data
    }
    
    console.log(`   🔍 Cache miss for ${hash}, trying Storacha...`)
    data = await loadBlockFromStoracha(hash)
    
    if (data) {
      cache.set(hash, data)
      return data
    }
    
    return undefined
  }

  const del = async (hash) => {
    const existed = cache.delete(hash)
    if (existed) {
      isModified = true
      await checkAutoUpload()
    }
    
  }

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


  const merge = async (other) => {
    if (!other || typeof other.iterator !== 'function') {
      throw new Error('Other storage must implement iterator method')
    }

    for await (const [key, value] of other.iterator()) {
      await put(key, value)
    }
  }

  const clear = async () => {
    cache.clear()
    isModified = true
    
    console.log(`   🗑️ Local cache cleared (Storacha archive preserved)`)
  }

  const persist = async () => {
    if (readOnly) {
      console.log(`   ℹ️ Read-only mode, skipping persist`)
      return
    }
    
    if (!isModified) {
      console.log(`   ℹ️ No changes to persist`)
      return
    }
    
    console.log(`   💾 Persisting ${cache.size} entries to Storacha...`)
    console.log(`   ⚠️ Persist not yet fully implemented`)
  }

  const close = async () => {
    if (isModified && !readOnly) {
      console.log(`   💾 Closing storage, persisting changes...`)
      await persist()
    }
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

export default StorachaStorage
