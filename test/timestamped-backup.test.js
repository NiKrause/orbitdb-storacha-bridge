/**
 * Test for timestamped backup feature
 */
import 'dotenv/config'
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from '../lib/utils.js'
import { 
  backupDatabase,
  restoreDatabaseFromSpace,
  listStorachaSpaceFiles
} from '../lib/orbitdb-storacha-bridge.js'

describe('Timestamped backups', () => {
  let sourceNode, targetNode

  beforeEach(async () => {
    // Create test nodes
    sourceNode = await createHeliaOrbitDB('-source')
    targetNode = await createHeliaOrbitDB('-target')
  })

  afterEach(async () => {
    // Cleanup
    if (sourceNode) {
      await sourceNode.orbitdb.stop()
      await sourceNode.helia.stop()
      await sourceNode.blockstore.close()
      await sourceNode.datastore.close()
    }
    if (targetNode) {
      await targetNode.orbitdb.stop()
      await targetNode.helia.stop()
      await targetNode.blockstore.close()
      await targetNode.datastore.close()
    }
    await cleanupOrbitDBDirectories()
  })

  test('should create timestamped backup files', async () => {
    // Create and populate test database
    const sourceDB = await sourceNode.orbitdb.open('test-backup', { type: 'events' })
    await sourceDB.add('Test entry 1')
    await sourceDB.add('Test entry 2')

    // Create first backup
    await backupDatabase(sourceNode.orbitdb, sourceDB.address, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      spaceName: 'test-space'
    })

    // Wait a bit to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Add more data and create second backup
    await sourceDB.add('Test entry 3')
    await backupDatabase(sourceNode.orbitdb, sourceDB.address, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      spaceName: 'test-space'
    })

    // List files in space
    const spaceFiles = await listStorachaSpaceFiles({
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      spaceName: 'test-space'
    })

    // Get backup files
    const backupFiles = spaceFiles
      .map(f => f.root.toString())
      .filter(f => f.match(/backup-.*-(metadata|blocks)\./))
      .sort()

    // Should have 4 files (2 backups × 2 files each)
    expect(backupFiles.length).toBe(4)

    // Files should have timestamps in the name
    for (const file of backupFiles) {
      expect(file).toMatch(/backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)
    }

    // Test restore from latest backup
    const restored = await restoreDatabaseFromSpace(targetNode.orbitdb, {
      storachaKey: process.env.STORACHA_KEY,
      storachaProof: process.env.STORACHA_PROOF,
      spaceName: 'test-space'
    })

    // Should restore from latest backup (with 3 entries)
    expect(restored.entries.length).toBe(3)
    expect(restored.entries[2].value).toBe('Test entry 3')
  }, 60000) // Long timeout for IPFS operations
})