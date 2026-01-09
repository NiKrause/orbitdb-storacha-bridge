# In-Memory Storacha Testing Guide

## Overview

This guide explains how to test OrbitDB backups/restores **without** using the live Storacha network, based on the approach used in the `ucan-upload-wall` project.

## Analysis: ucan-upload-wall Approach

### Do They Change the Upload URL?

**YES!** They configure the Storacha client to point to a local test service:

```javascript
const client = await Client.create({
  serviceConf: {
    access: context.serverURL,    // Local test server
    upload: context.serverURL,    // Local test server
  },
  receiptsEndpoint: context.serverURL,
})
```

### How It Works

1. **In-Memory Service Creation**:
   ```javascript
   import { createContext } from '@storacha/upload-api/test/context'
   
   const context = await createContext({
     requirePaymentPlan: false
   })
   ```
   - No Docker, no external services
   - All storage is in-memory (Maps, Arrays)
   - Provides full upload-api functionality

2. **Direct UCANTO Invocations**:
   ```javascript
   import { createServer, connect } from '@storacha/upload-api'
   
   const connection = connect({
     id: context.id,
     channel: createServer(context),
   })
   ```
   - Tests use direct UCANTO protocol calls
   - No HTTP server needed for backend tests

3. **Optional HTTP Wrapper** (for browser tests):
   ```javascript
   const server = http.createServer((req, res) => {
     // Forward to UCANTO service
   }).listen()
   
   const serverURL = new URL(`http://127.0.0.1:${server.address().port}`)
   ```

## Implementation for orbitdb-storacha-bridge

### Current Limitations

The current `backupDatabase` function uses `@storacha/client` which **requires** an HTTP endpoint:

```javascript
// Current signature
await backupDatabase(orbitdb, address, { 
  storachaKey, 
  storachaProof 
})
```

This creates a client that connects to production Storacha over HTTP.

### Recommended Solutions

#### Option A: Direct UCANTO Integration (Recommended)

Create a new backup function variant that uses UCANTO connections directly:

```javascript
// New test-friendly signature
export async function backupDatabaseWithConnection(
  orbitdb, 
  address, 
  { connection, spaceDid, proofs }
) {
  // Use direct UCANTO invocations:
  // - StoreCapabilities.add.invoke()
  // - UploadCapabilities.add.invoke()
  // This works with in-memory service WITHOUT HTTP
}
```

**Benefits**:
- ✅ No HTTP overhead
- ✅ Faster tests
- ✅ Network-independent
- ✅ Easy error injection for testing

**Drawbacks**:
- Requires code changes to backup/restore functions
- Need to maintain two code paths (HTTP client vs UCANTO)

#### Option B: HTTP Server Wrapper

Wrap the in-memory service with an HTTP server:

```javascript
import http from 'http'
import { createServer } from '@storacha/upload-api'

const httpServer = http.createServer(async (req, res) => {
  // Parse UCANTO request
  // Forward to in-memory service
  // Return UCANTO response
}).listen()

const serverURL = new URL(`http://127.0.0.1:${httpServer.address().port}`)

// Now can use existing @storacha/client with this URL
```

**Benefits**:
- ✅ No code changes needed
- ✅ Tests real HTTP path
- ✅ Works with existing backup functions

**Drawbacks**:
- More complex setup
- Slower than direct UCANTO
- Requires HTTP server lifecycle management

### Getting Started

1. **Install Dependencies**:
   ```bash
   npm install --save-dev @storacha/upload-api @ucanto/server @storacha/capabilities
   ```

2. **Use Test Helpers**:
   ```javascript
   import { 
     setupTestUploadService, 
     createTestSpace,
     createTestDelegation 
   } from './test/helpers/test-upload-service.js'
   
   // Create in-memory service
   const testService = await setupTestUploadService()
   
   // Create test space (replaces STORACHA_KEY/STORACHA_PROOF)
   const space = await createTestSpace(testService)
   
   // Use direct UCANTO invocations
   const result = await StoreCapabilities.add
     .invoke({
       issuer: space.spaceAgent,
       audience: testService.context.id,
       with: space.spaceDid,
       nb: { link, size },
       proofs: [space.spaceProof],
     })
     .execute(testService.connection)
   ```

3. **Update Tests**:
   
   Instead of:
   ```javascript
   const backupResult = await backupDatabase(orbitdb, address, {
     storachaKey: process.env.STORACHA_KEY,
     storachaProof: process.env.STORACHA_PROOF,
   })
   ```
   
   Use:
   ```javascript
   const testService = await setupTestUploadService()
   const space = await createTestSpace(testService)
   
   const backupResult = await backupDatabaseWithConnection(orbitdb, address, {
     connection: testService.connection,
     spaceDid: space.spaceDid,
     proofs: [space.spaceProof],
   })
   ```

## Test Patterns

### Pattern 1: Isolated Unit Tests

```javascript
test('should upload blocks to in-memory service', async () => {
  await withTestService(async (testService) => {
    const space = await createTestSpace(testService)
    
    // Test upload logic in isolation
    // No network, no credentials needed
  })
})
```

### Pattern 2: Delegation Testing

```javascript
test('should create and revoke delegations', async () => {
  await withTestService(async (testService) => {
    const space = await createTestSpace(testService)
    const bobAgent = await ed25519.generate()
    
    // Create delegation
    const delegation = await createTestDelegation({
      space,
      issuer: space.spaceAgent,
      audience: bobAgent,
    })
    
    // Test revocation
    await UCAN.revoke.invoke({
      issuer: space.spaceAgent,
      audience: testService.context.id,
      with: space.spaceAgent.did(),
      nb: { ucan: delegation.cid },
    }).execute(testService.connection)
  })
})
```

### Pattern 3: Error Condition Testing

```javascript
test('should handle insufficient capabilities', async () => {
  await withTestService(async (testService) => {
    const space = await createTestSpace(testService)
    const attacker = await ed25519.generate()
    
    // Try to upload without delegation
    const result = await StoreCapabilities.add
      .invoke({
        issuer: attacker,  // No delegation!
        audience: testService.context.id,
        with: space.spaceDid,
        nb: { link, size },
        proofs: [],  // No proofs
      })
      .execute(testService.connection)
    
    // Should fail with authorization error
    expect(result.out.error).toBeDefined()
    expect(result.out.error.message).toMatch(/authorization/i)
  })
})
```

## Migration Strategy

### Phase 1: Add Test Helpers ✅

- [x] Create `test/helpers/test-upload-service.js`
- [x] Create example test file
- [x] Document approach

### Phase 2: Implement UCANTO Integration

1. Create `lib/orbitdb-storacha-bridge-ucanto.js`
2. Implement `backupDatabaseWithConnection()`
3. Implement `restoreDatabaseWithConnection()`
4. Keep existing functions for backward compatibility

### Phase 3: Update Tests

1. Convert `integration.test.js` to use in-memory service
2. Convert `backup-car.test.js` to use in-memory service
3. Add new tests for edge cases (auth failures, revocation, etc.)

### Phase 4: CI/CD Benefits

- Remove dependency on `STORACHA_KEY` and `STORACHA_PROOF` secrets
- Tests run on PRs from forks
- Faster test execution
- More reliable (no network flakiness)

## Key Advantages

1. **No External Dependencies**: Tests don't need Storacha credentials
2. **Fast**: In-memory operations are instant
3. **Isolated**: Each test gets its own clean storage
4. **Deterministic**: No network flakiness or rate limiting
5. **Complete Testing**: Can test revocation, errors, edge cases
6. **CI-Friendly**: Works in any environment, including forks

## References

- `ucan-upload-wall` test implementation: `/Users/nandi/ucan-upload-wall/web/tests/delegation-upload-flow.spec.ts`
- Upload API test utilities: `@storacha/upload-api/test/context`
- UCANTO documentation: https://github.com/web3-storage/ucanto
