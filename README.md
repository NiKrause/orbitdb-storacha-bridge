# OrbitDB Storacha Bridge

> **Production-ready OrbitDB database backup, restoration, replication, UCANs and more via Storacha/Filecoin**

🎉 **Production Ready**: This codebase has been cleaned up and optimized for production use, with debug code removed, proper logging implemented, and comprehensive testing utilities.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![CI/CD Pipeline](https://github.com/NiKrause/orbitdb-storacha-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKrause/orbitdb-storacha-bridge/actions/workflows/ci.yml)
[![ESLint](https://img.shields.io/badge/ESLint-passing-brightgreen.svg)](https://github.com/NiKause/orbitdb-storacha-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/orbitdb-storacha-bridge.svg)](https://www.npmjs.com/package/orbitdb-storacha-bridge)


## Table of Contents

- [What we want to accomplish](#what-we-want-to-accomplish)
- [What This Does](#what-this-does)
- [RoadMap](#roadmap)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Demo](#demo)
- [How It Works](#how-it-works)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)


## What we want to accomplish

Alice and Bob are working with the same OrbitDB in a local-first, peer-to-peer web or mobile application.
In a perfect world, Alice and Bob wouldn't need any additional decentralized storage, since their data is already distributed among a number of peers, depending on the use case and general peer-to-peer network architecture. If Alice loses her data, Bob would still have a copy, and Alice could resync from Bob or others at any time. This reflects the current state of technology in OrbitDB.

Additionally, relay nodes or networks optionally can run Helia and OrbitDB instances for pinning the db data of Alice and Bob in a decentralized way. Here it still needs a decentralized pinning network for OrbitDBs and possible referenced media pointing to IPFS CIDs.

OrbitDB-Storacha-Bridge is intended for archiving large OrbitDBs on additional decentralized Storacha/Filecoin Storage, which would otherwise take a long time to replicate. Since data modelling in OrbitDB is different from traditional relational databases, it must be thought the other way around. Not all users of a local-first peer-to-peer app would ever share the same identical database. We'd all agree that this isn't feasible. However e.g. an OrbitDB with blog posts would tend to blow up over time and at some point the whole blog history must be archived and sharded into separate dbs in order to keep the time for replication quick to not make blog loading an unaffordable experience.

In the first instance each user hosts his own data on his own device and decides with whom he needs or wants to replicate the data. This depends strongly on the use case. Each app user definitely doesn't want or should replicate with everybody.

OrbitDB-Storacha-Bridge is also useful for emergency cases, for example, when both Alice and Bob lose their data or devices. In that case, a new Alice, Bob, or even Peter can restore the work from Storacha with the same identity or without. We support UCAN authentication and working on UCAN delegation between OrbitDB's, so Alice can delegate access to the same Storacha backup space to whoever she wants for some time.

It has happened in the past that countries, mobile networks, internet providers, corporate networks, or hotels block IP addresses, ports, and protocols — for example, WebRTC or WebSocket/WebTransport gateways. Sometimes some traditional mobile apps just don't work everywhere. Although libp2p supports many different transport options and such cases are becoming rarer because of this, it would still be desirable to have an additional option - just to be safe. This would allow users to restore an OrbitDB directly from IPFS and to push or upload database states back to it via Storacha/Filecoin after every db change.
This backup option becomes particularly valuable when peer-to-peer connectivity cannot be established due to network restrictions or when internet standards are broken.

Please note: Storacha backup and restore works via Storacha's still centralized gateway to Filecoin's decentralized backup storage at the time of writing.

## What This Does

Backup and restore between **OrbitDB databases** and **Storacha/Filecoin** with or without full hash and identity preservation (both valid approaches). Works in both Node.js and browser environments (in browsers at this time only without the full hash identity preservation by restoring db entries only [Issue #4](../../issues/4))

**WebAuthn DID Provider**: Hardware-secured biometric authentication (Face ID, Touch ID, Windows Hello) for OrbitDB identities. Eliminates seed phrase management while providing cryptographically secure identity management with private keys that never leave secure hardware.

The project includes **Svelte components** for browser-based demos and integration (see [Storacha Svelte Components](#storacha-svelte-components) section for details).

**Features:**

  - UCAN authentication (alternative to Storacha key and proof credentials)
  - Backup/restore functionality with hash and identity preservation

## RoadMap

- [x] backup/restore between OrbitDB and Storacha in NodeJS via Storacha key and proof credential (hash and identity preserving)
- [x] backup/restore between OrbitDB and Storacha in browser (StorachaIntegration.svelte) (hash and identity preserving) - [Issue #4](../../issues/4)
- [x] backup/restore between OrbitDB and Storacha in browser ([`StorachaTest.svelte`](src/components/StorachaTest.svelte)) (entries only - without manifest and identity preservation into new OrbitDB)
  - [x] using Storacha Credentials by [`StorachaAuth.svelte`](src/components/StorachaAuth.svelte)
  - [x] using UCAN + privatekey
- [x] **WebAuthn DID Identity Provider** ([`WebAuthnDIDProvider.js`](src/components/WebAuthnDIDProvider.js) + [`StorachaTestWithWebAuthn.svelte`](src/components/StorachaTestWithWebAuthn.svelte))
  - [x] Hardware-secured biometric authentication (Face ID, Touch ID, Windows Hello)
  - [x] DID-compliant identity creation (`did:webauthn:...` format) 
  - [x] CBOR public key parsing from WebAuthn attestation objects
  - [x] OrbitDB identity provider integration with proper verification
  - [x] Production-ready implementation with comprehensive error handling
- [x] OrbitDB CAR file storage (OrbitDB CustomStorage)
- [?] backup/restore between OrbitDB and Storacha in NodeJS via UCAN and privatekey (hash and identity preserving)
- [ ] CustomStorage - implement OrbitDB StorachaStorage (OrbitDB CustomStorage) in NodeJS - storage ok - but OrbitDB CustomStore doesn't support accessing the Manifest. Initial-sync therefore difficult but manageable by a standard restore of the orbitdb-storacha-bridge function!
- [ ] OrbitDB Storacha storage (OrbitDB CustomStorage) in NodeJS (entries only - initial sync)
- [ ] Alice when authenticated via a UCAN or Storacha Credentials should be able to delegate her access rights to Bob (with custom/default capabilities) via Storacha API.

> **Note:** Currently, each Storacha space contains one full backup. For multiple backups, use separate spaces.

Read more: [Bridging OrbitDB with Storacha: Decentralized Database Backups](https://medium.com/@akashjana663/bridging-orbitdb-with-storacha-decentralized-database-backups-44c7bee5c395)

## Installation

Install the package via npm.

## Environment Setup

Get Storacha credentials from [storacha.network quickstart](https://docs.storacha.network/quickstart/), install w3 for the console, get storacha key and proof then set up your environment variables (.env) for STORACHA_KEY and STORACHA_PROOF.

## Demo

### NodeJS Demo Scripts (full backup with Manifest, Identity and AccessController and entries blocks)

- `node` [`examples/demo.js`](examples/demo.js) - Complete backup/restore cycle
- `node` [`examples/backup-demo.js`](examples/backup-demo.js) - Backup demonstration only  
- `node` [`examples/restore-demo.js`](examples/restore-demo.js) - Restore demonstration only

### Storacha Svelte Components

Svelte components for OrbitDB-Storacha integration in browser environments:

#### [`StorachaAuth.svelte`](src/components/StorachaAuth.svelte)
Authentication component supporting multiple Storacha authentication methods:
- Storacha credentials (Storacha-Key and Storacha Proof)
- UCAN delegation (delegated UCAN + corresponding private key) 
- Email registration (create new Storacha account via email confirmation)

#### [`StorachaTest.svelte`](src/components/StorachaTest.svelte)
Basic backup/restore demo with Alice & Bob using independent OrbitDB instances:
- Creates separate OrbitDB databases with different addresses
- No P2P replication - data exchange via Storacha backup/restore only
- Demonstrates entry-only backup approach (recreates database from entries + config)
- Uses mnemonic seed generation and DID-based identity management

#### [`StorachaTestWithReplication.svelte`](src/components/StorachaTestWithReplication.svelte)
Advanced replication demo with Alice & Bob using shared database and P2P connectivity:
- Creates shared OrbitDB database with same address for both peers
- Full P2P replication via libp2p with circuit relay support  
- Backup/restore preserves replication capabilities
- Uses Carbon Design System components for enhanced UI

#### [`StorachaTestWithWebAuthn.svelte`](src/components/StorachaTestWithWebAuthn.svelte)
WebAuthn biometric authentication demo with hardware-secured DID identities:
- WebAuthn biometric authentication (Face ID, Touch ID, Windows Hello, PIN)
- Hardware-secured DID creation using WebAuthn credentials
- CBOR public key parsing from WebAuthn attestation objects
- Backup/restore with biometric-secured identities

#### [`WebAuthnDIDProvider.js`](src/components/WebAuthnDIDProvider.js)
WebAuthn DID Provider for OrbitDB - Complete identity provider implementation:
- WebAuthn integration with OrbitDB's identity system
- Public key extraction from WebAuthn credentials via CBOR parsing
- DID specification compliance (`did:webauthn:...` format)
- Hardware-secured private keys that never leave the secure element
- Biometric authentication for every signing operation

#### [`StorachaIntegration.svelte`](src/components/StorachaIntegration.svelte)
Full integration component for existing OrbitDB Svelte applications:
- Hash and identity preserving backup/restore (full database reconstruction)
- Progress tracking with real-time upload/download indicators
- LocalStorage credential management with auto-login
- Space management (create, list, select Storacha spaces)
- Note: Currently has browser limitations for full hash preservation ([Issue #4](../../issues/4))

### Svelte App Demonstrations

- `node` [`scripts/svelte-backup-restore.js`](scripts/svelte-backup-restore.js) - Creates SvelteKit demo app with StorachaAuth and StorachaTest components
- `node` [`scripts/svelte-backup-restore-02.js`](scripts/svelte-backup-restore-02.js) - Enhanced demo with StorachaTestWithReplication component
- WebAuthn Demo: Use [`orbitdb-storacha-svelte-backup-restore-demo`](orbitdb-storacha-svelte-backup-restore-demo/) with StorachaTestWithWebAuthn for biometric authentication testing

## How It Works

1. **Extract Blocks** - Separates OrbitDB database into individual components (log entries, manifest, identities, access controls)
2. **Upload to Storacha** - Each block is uploaded separately to IPFS/Filecoin via Storacha
3. **Block Discovery** - Lists all files in Storacha space using Storacha SDK APIs
4. **CID Bridging** - Converts between Storacha CIDs (`bafkre*`) and OrbitDB CIDs (`zdpu*`)
5. **Reconstruct Database** - Reassembles blocks and opens database with original identity

## Logging

The library uses **Pino** for structured, high-performance logging. Control logging with environment variables:

```bash
# Set log level (trace, debug, info, warn, error, fatal, silent)
export LOG_LEVEL=debug

# Enable pretty printing for development
export LOG_PRETTY=true
```

**Quick example:**

```javascript
import { logger } from 'orbitdb-storacha-bridge/lib/logger.js';

// Structured logging with context
logger.info({ blockCount: 150, dbName: 'todos' }, 'Backup completed');

// Control logging programmatically
import { setLogLevel, disableLogging } from 'orbitdb-storacha-bridge/lib/logger.js';
setLogLevel('debug');
disableLogging(); // Silence all logs
```

📖 **See [docs/LOGGING_QUICKSTART.md](docs/LOGGING_QUICKSTART.md)** for quick reference or **[docs/LOGGING.md](docs/LOGGING.md)** for complete documentation.

## Testing

Ensure you have Storacha credentials in your `.env` file.
Use npm test commands to run various test suites including integration tests and verbose output.

### CAR Storage Tests

The `car-storage.test.js` suite provides comprehensive validation of the CAR (Content Addressable Archive) storage layer that enables persistent file-based storage for OrbitDB databases. The **Full OrbitDB Integration with Persistence** test demonstrates complete database lifecycle management: creating an OrbitDB instance with CAR storage, adding todo entries, persisting to CAR files, closing the database, reopening with a new OrbitDB instance, and verifying all data is perfectly recovered. This test validates that CAR storage can serve as a reliable persistence layer for OrbitDB's entry, heads, and index storage, ensuring data survives across application restarts.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License


