# OrbitDB Storacha Bridge

> **OrbitDB database backup, restoration, replication, UCANs and more via Storacha/Filecoin**


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![CI/CD Pipeline](https://github.com/NiKrause/orbitdb-storacha-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKrause/orbitdb-storacha-bridge/actions/workflows/ci.yml)
[![ESLint](https://img.shields.io/badge/ESLint-passing-brightgreen.svg)](https://github.com/NiKause/orbitdb-storacha-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/orbitdb-storacha-bridge.svg)](https://www.npmjs.com/package/orbitdb-storacha-bridge)


## Table of Contents

- [OrbitDB Storacha Bridge](#orbitdb-storacha-bridge)
  - [Table of Contents](#table-of-contents)
  - [What we want to accomplish](#what-we-want-to-accomplish)
    - [The Challenge of Distributed Data Persistence](#the-challenge-of-distributed-data-persistence)
    - [Architectural Considerations for Local-First Applications](#architectural-considerations-for-local-first-applications)
    - [Use Cases for OrbitDB-Storacha-Bridge](#use-cases-for-orbitdb-storacha-bridge)
    - [Architecture Notes](#architecture-notes)
  - [What This Does](#what-this-does)
  - [RoadMap](#roadmap)
  - [Installation](#installation)
  - [Environment Setup](#environment-setup)
  - [Demo](#demo)
    - [NodeJS Demo Scripts (full backup with Manifest, Identity and AccessController and entries blocks)](#nodejs-demo-scripts-full-backup-with-manifest-identity-and-accesscontroller-and-entries-blocks)
    - [Svelte Components](#svelte-components)
  - [How It Works](#how-it-works)
  - [Logging](#logging)
  - [Testing](#testing)
    - [CAR Storage Tests](#car-storage-tests)
  - [Contributing](#contributing)
  - [License](#license)


## What we want to accomplish

### The Challenge of Distributed Data Persistence

In local-first, peer-to-peer applications built on OrbitDB, data naturally replicates across participating peers through libp2p network connections. Under ideal conditions, this distributed architecture provides inherent redundancy—if one peer loses data, they can resynchronize from other active peers in the network. This peer-to-peer replication model represents the current state of OrbitDB technology.

While relay nodes and pinning services (running Helia and OrbitDB instances) can provide additional decentralized persistence for database entries and IPFS-referenced content, the ecosystem still lacks comprehensive infrastructure for long-term archival of large-scale OrbitDB deployments.

### Architectural Considerations for Local-First Applications

OrbitDB's data model differs fundamentally from traditional centralized databases. In local-first architectures, users typically host their own data locally and selectively replicate with specific peers based on collaboration requirements—not with the entire network. This selective replication is essential for scalability and user experience.

However, as OrbitDB instances grow (consider a blog database accumulating years of posts), replication times increase proportionally. At scale, databases require archival strategies and potential sharding to maintain performant synchronization and optimal user experience.

### Use Cases for OrbitDB-Storacha-Bridge

This bridge addresses several critical scenarios:

**1. Long-term Archival**
Archive large OrbitDB instances to Storacha/Filecoin storage, enabling efficient cold storage for historical data while maintaining fast replication of active datasets.

**2. Disaster Recovery**
Provides recovery options when all active peers lose data simultaneously. Users can restore databases from Storacha using either their original identity or a new identity, ensuring business continuity beyond the peer-to-peer network's availability.

**3. Network Resilience**
Historically, various network environments (corporate networks, ISPs, regional restrictions) have blocked critical protocols including WebRTC and WebSocket/WebTransport. While libp2p's multi-transport architecture provides numerous fallback options, having an additional restoration pathway through IPFS/Storacha offers defense-in-depth for network-hostile environments. Users can restore databases directly from IPFS and maintain incremental backups after each database mutation.

**4. Access Control & Delegation**
The bridge supports UCAN (User Controlled Authorization Networks) authentication with planned delegation capabilities between OrbitDB instances. This enables fine-grained, time-bound access control for Storacha backup spaces, allowing users to securely share access with collaborators or recovery agents.

### Architecture Notes

Currently, Storacha backup and restore operations utilize Storacha's gateway infrastructure to interface with Filecoin's decentralized storage network. This hybrid approach balances accessibility with decentralization during the current phase of the Filecoin ecosystem's evolution.

## What This Does

Backup and restore between **OrbitDB databases** and **Storacha/Filecoin** with full hash and identity preservation. Works in both Node.js and browser environments. [See Storacha Integration Widget in Simple Todo Example](https://simple-todo.le-space.de/)

The project includes **Svelte components** for browser-based demos and integration (see [SVELTE-COMPONENTS.md](SVELTE-COMPONENTS.md) for detailed documentation).

**Features:**

- backup/restore between OrbitDB and Storacha in browsers and NodeJS via Storacha key and proof credential
  - full backup per space
  - timestamped backups (multiple backups per space - restore last backup by default)
- Storacha Svelte components for integration into Svelte projects
- UCAN authentication 
- Backup/restore functionality with hash and identity preservation
- OrbitDB CAR file storage [OrbitDB CustomStorage](https://github.com/orbitdb/orbitdb/blob/main/docs/STORAGE.md)

## RoadMap

- [ ] CustomStorage - implement OrbitDB StorachaStorage [OrbitDB CustomStorage issue 23](https://github.com/NiKrause/orbitdb-storacha-bridge/issues/23)
- [ ] Alice when authenticated via a UCAN or Storacha Credentials should be able to delegate/revoke her access rights to Bob (with custom/default capabilities) [via WebAuthN (P-256)](https://github.com/NiKrause/orbitdb-storacha-bridge/issues/16) see: [WebAuthN Upload Wall](https://github.com/NiKrause/ucan-upload-wall/tree/browser-only/web) and [live demo](https://bafybeibdcnp7pr26okzr6kbygcounsz3klyg3vydxwwovmz2ljyzfmprre.ipfs.w3s.link/)


Read more on Medium: [Bridging OrbitDB with Storacha: Decentralized Database Backups](https://medium.com/@akashjana663/bridging-orbitdb-with-storacha-decentralized-database-backups-44c7bee5c395)

## Installation

Install the package via npm. ```npm install orbitdb-storacha-bridge```

## Environment Setup

Get Storacha credentials from [storacha.network quickstart](https://docs.storacha.network/quickstart/), install w3 for the console, get storacha key and proof then set up your environment variables (.env) for STORACHA_KEY and STORACHA_PROOF.

## Demo

### NodeJS Demo Scripts (full backup with Manifest, Identity and AccessController and entries blocks)

- `node` [`examples/demo.js`](examples/demo.js) - Complete backup/restore cycle
- `node` [`examples/backup-demo.js`](examples/backup-demo.js) - Backup demonstration only  
- `node` [`examples/restore-demo.js`](examples/restore-demo.js) - Restore demonstration only
- `node` [`examples/car-backup-demo.js`](examples/car-backup-demo.js) - CAR-based timestamped backups (efficient multi-version backups)
- `node` [`examples/demo-different-identity.js`](examples/demo-different-identity.js) - Different identities with access control enforcement
- `node` [`examples/demo-shared-identities.js`](examples/demo-shared-identities.js) - Shared identity backup/restore scenarios
- `node` [`examples/simple-todo-restore-demo.js`](examples/simple-todo-restore-demo.js) - Simple todo database restore demonstration
- `node` [`examples/ucan-demo.js`](examples/ucan-demo.js) - Complete UCAN-based authentication backup/restore
- `node` [`examples/simple-ucan-auth.js`](examples/simple-ucan-auth.js) - UCAN authentication with existing delegation token
- `node` [`examples/test-ucan-bridge.js`](examples/test-ucan-bridge.js) - Test UCAN bridge integration
- `node` [`examples/test-ucan-list.js`](examples/test-ucan-list.js) - Test UCAN file listing after upload
- `node` [`examples/clear-space.js`](examples/clear-space.js) - Clear all files from Storacha space (utility script)
- `node` [`examples/timestamped-backup-example.js`](examples/timestamped-backup-example.js) - Timestamped backup implementation helper

### Svelte Components

For browser-based integration, this project includes Svelte components for authentication, backup/restore, P2P replication, and WebAuthn biometric authentication. See [**SVELTE-COMPONENTS.md**](SVELTE-COMPONENTS.md) for complete documentation of all available components and demonstrations.

## How It Works

1. **Extract Blocks** - Separates OrbitDB database into individual components (log entries, manifest, identities, access controls)
2. **Upload to Storacha** - Each block is uploaded separately to IPFS/Filecoin via Storacha
3. **Block Discovery** - Lists all files in Storacha space using Storacha SDK APIs
4. **CID Bridging** - Converts between Storacha CIDs (`bafkre*`) and OrbitDB CIDs (`zdpu*`)
5. **Reconstruct Database** - Reassembles blocks and opens database with original identity

## Logging

The library uses **@libp2p/logger** for consistent logging across the libp2p ecosystem. Control logging with the `DEBUG` environment variable:

**Node.js:**
```bash
# Enable all OrbitDB Storacha Bridge logs
DEBUG=libp2p:orbitdb-storacha:* node your-script.js

# Enable specific components
DEBUG=libp2p:orbitdb-storacha:bridge node your-script.js

# Enable all libp2p logs (includes this library + libp2p internals)
DEBUG=libp2p:* node your-script.js
```

**Browser:**
```javascript
// In browser console or before loading the application
localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')
// Then refresh the page
```

The logger supports printf-style formatting:
- `%s` - string
- `%d` - number
- `%o` - object
- `%p` - peer ID
- `%b` - base58btc encoded data
- `%t` - base32 encoded data

## Testing

Ensure you have Storacha credentials in your `.env` file.
Use npm test commands to run various test suites including integration tests and verbose output.

### CAR Storage Tests

The `car-storage.test.js` suite provides validation of the CAR (Content Addressable Archive) storage layer that enables persistent file-based storage for OrbitDB databases. The **Full OrbitDB Integration with Persistence** test demonstrates database lifecycle management: creating an OrbitDB instance with CAR storage, adding todo entries, persisting to CAR files, closing the database, reopening with a new OrbitDB instance, and verifying all data is perfectly recovered. This test validates that CAR storage can serve as a reliable persistence layer for OrbitDB's entry, heads, and index storage, ensuring data survives across application restarts.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License


