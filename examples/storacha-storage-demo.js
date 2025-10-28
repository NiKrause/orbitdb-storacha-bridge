import dotenv from 'dotenv'
import StorachaStorage from '../lib/storacha-storage.js'
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from '../lib/utils.js'
import { backupDatabaseToStoracha } from '../lib/orbitdb-storacha-bridge.js'

dotenv.config()

const { ComposedStorage, MemoryStorage } = await import('@orbitdb/core/src/storage/index.js')

async function demo1_BasicUsage() {
  console.log('\n' + '='.repeat(60))
  console.log('📦 DEMO 1: Basic Storacha Storage Usage')
  console.log('='.repeat(60))

  const storage = await StorachaStorage({
    storachaKey: process.env.STORACHA_KEY,
    storachaProof: process.env.STORACHA_PROOF,
    autoLoad: true,
    readOnly: false,
    storageType: 'demo-basic'
  })

  console.log('\n📝 Storing data...')
  await storage.put('key1', new TextEncoder().encode('Hello from Storacha!'))
  await storage.put('key2', new TextEncoder().encode('Hybrid web/web3 mode'))

  console.log('\n🔍 Retrieving data...')
  const value1 = await storage.get('key1')
  const value2 = await storage.get('key2')
  
  console.log('   key1:', new TextDecoder().decode(value1))
  console.log('   key2:', new TextDecoder().decode(value2))

  console.log('\n📋 All entries:')
  for await (const [key, value] of storage.iterator()) {
    console.log(`   ${key}: ${new TextDecoder().decode(value)}`)
  }

  await storage.close()
  
  console.log('\n✅ Demo 1 completed!')
}

async function demo2_OrbitDBIntegration() {
  console.log('\n' + '='.repeat(60))
  console.log('🗄️ DEMO 2: OrbitDB with Storacha Storage Backend')
  console.log('='.repeat(60))

  let orbitdb, helia

  try {
    console.log('\n📦 Creating Storacha storage instances...')
    
    const entryStorage = await StorachaStorage({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      autoLoad: true,
      readOnly: false,
      storageType: 'entries'
    })

    const headsStorage = await StorachaStorage({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      autoLoad: true,
      readOnly: false,
      storageType: 'heads'
    })

    const indexStorage = await StorachaStorage({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      autoLoad: true,
      readOnly: false,
      storageType: 'index'
    })

    console.log('\n🔗 Composing with memory storage...')
    const composedEntryStorage = await ComposedStorage(await MemoryStorage(), entryStorage)
    const composedHeadsStorage = await ComposedStorage(await MemoryStorage(), headsStorage)
    const composedIndexStorage = await ComposedStorage(await MemoryStorage(), indexStorage)

    console.log('\n🚀 Creating OrbitDB instance...')
    const result = await createHeliaOrbitDB('-storacha-demo')
    helia = result.helia
    orbitdb = result.orbitdb

    console.log('\n📂 Creating database with Storacha storage...')
    const db = await orbitdb.open('todos', {
      type: 'keyvalue',
      entryStorage: composedEntryStorage,
      headsStorage: composedHeadsStorage,
      indexStorage: composedIndexStorage
    })

    console.log(`   Database address: ${db.address}`)

    console.log('\n📝 Adding todos...')
    await db.put('todo1', { text: 'Learn OrbitDB', completed: false })
    await db.put('todo2', { text: 'Integrate Storacha', completed: true })
    await db.put('todo3', { text: 'Build hybrid app', completed: false })
    console.log('\n📋 Todos in database:')
    const todo1 = await db.get('todo1')
    const todo2 = await db.get('todo2')
    const todo3 = await db.get('todo3')
    
    console.log(`   todo1: ${todo1.text} (${todo1.completed ? '✓' : '○'})`)
    console.log(`   todo2: ${todo2.text} (${todo2.completed ? '✓' : '○'})`)
    console.log(`   todo3: ${todo3.text} (${todo3.completed ? '✓' : '○'})`)

    console.log('\n💡 Data is now stored in both OrbitDB and Storacha!')
    console.log('   If you restart the app, data will be loaded from Storacha')

    await db.close()
    await orbitdb.stop()
    await helia.stop()
    
    console.log('\n✅ Demo 2 completed!')
  } catch (error) {
    console.error('\n❌ Error:', error.message)
    
    if (orbitdb) await orbitdb.stop().catch(() => {})
    if (helia) await helia.stop().catch(() => {})
    
    throw error
  }
}

async function demo3_HybridMode() {
  console.log('\n' + '='.repeat(60))
  console.log('🔄 DEMO 3: Hybrid Mode - SSR to P2P Switch')
  console.log('='.repeat(60))
  console.log('\nScenario: PWA starts offline, loads data from Storacha,')
  console.log('          then switches to P2P mode when network is available')

  let orbitdb1, helia1, orbitdb2, helia2

  try {
    console.log('\n📝 PHASE 1: Creating database and backing up to Storacha...')
    
    const result1 = await createHeliaOrbitDB('-hybrid-alice')
    helia1 = result1.helia
    orbitdb1 = result1.orbitdb

    const db1 = await orbitdb1.open('hybrid-todos', { type: 'keyvalue' })
    
    await db1.put('todo1', { text: 'Build PWA', completed: true })
    await db1.put('todo2', { text: 'Add offline support', completed: true })
    await db1.put('todo3', { text: 'Deploy to production', completed: false })

    console.log(`   Database address: ${db1.address}`)
    console.log('   Backing up to Storacha...')

    await backupDatabaseToStoracha(db1, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF
    })

    const manifestCID = db1.address.split('/').pop()
    console.log(`   ✅ Backup complete! Manifest CID: ${manifestCID}`)

    await db1.close()
    await orbitdb1.stop()
    await helia1.stop()

    console.log('\n🔄 PHASE 2: Simulating PWA restart (empty cache)...')
    console.log('   Loading data from Storacha Space...')

    const storachaEntryStorage = await StorachaStorage({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      manifestCID: manifestCID, // Known from /orbitdb/address
      autoLoad: true,           // Load from Storacha on startup
      readOnly: false,
      storageType: 'entries'
    })

    const composedStorage = await ComposedStorage(await MemoryStorage(), storachaEntryStorage)

    const result2 = await createHeliaOrbitDB('-hybrid-bob')
    helia2 = result2.helia
    orbitdb2 = result2.orbitdb

    const db2 = await orbitdb2.open('hybrid-todos', {
      type: 'keyvalue',
      entryStorage: composedStorage
    })

    console.log('\n📋 Todos loaded from Storacha:')
    const todo1 = await db2.get('todo1')
    const todo2 = await db2.get('todo2')
    const todo3 = await db2.get('todo3')
    
    if (todo1) console.log(`   todo1: ${todo1.text} (${todo1.completed ? '✓' : '○'})`)
    if (todo2) console.log(`   todo2: ${todo2.text} (${todo2.completed ? '✓' : '○'})`)
    if (todo3) console.log(`   todo3: ${todo3.text} (${todo3.completed ? '✓' : '○'})`)

    console.log('\n✅ Hybrid mode successful!')
    console.log('   PWA loaded data from Storacha and can now switch to P2P mode')

    await db2.close()
    await orbitdb2.stop()
    await helia2.stop()
    
    console.log('\n✅ Demo 3 completed!')
  } catch (error) {
    console.error('\n❌ Error:', error.message)
    
    if (orbitdb1) await orbitdb1.stop().catch(() => {})
    if (helia1) await helia1.stop().catch(() => {})
    if (orbitdb2) await orbitdb2.stop().catch(() => {})
    if (helia2) await helia2.stop().catch(() => {})
    
    throw error
  }
}

async function main() {
  console.log('🚀 Storacha Storage Demo')
  console.log('=' .repeat(60))

  if (!process.env.STORACHA_KEY || !process.env.STORACHA_PROOF) {
    console.error('❌ Error: STORACHA_KEY and STORACHA_PROOF environment variables required')
    console.error('   Please set them in your .env file')
    process.exit(1)
  }

  try {
    await cleanupOrbitDBDirectories()

    await demo1_BasicUsage()
    await demo2_OrbitDBIntegration()
    await demo3_HybridMode()

    console.log('\n' + '='.repeat(60))
    console.log('🎉 All demos completed successfully!')
    console.log('='.repeat(60))

    await cleanupOrbitDBDirectories()
  } catch (error) {
    console.error('\n❌ Demo failed:', error)
    process.exit(1)
  }
}

main()
