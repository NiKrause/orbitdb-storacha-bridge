# Changes

## Unreleased

### Changed
- **Backing up no longer carries the Storacha client.** `backup-car.js` imported the main entry,
  which imports `@storacha/client` at the top, so a page that backs up to Aleph paid for a client
  it never calls — **88 kB gzipped**, measured in a real bundle (`mesh-todo`: 420.4 → 508.6 kB).
  The two pieces a backup needs moved out (`lib/extract-blocks.js`, `lib/backends/resolve.js`),
  the Storacha backend is built through a dynamic import, and the Storacha-space paths inside
  `backup-car.js` fetch the main entry only when a space is actually consulted. Importing
  `orbitdb-storage-bridge/backup-car` now costs **4.2 kB gzipped**. No import path changed:
  everything the main entry exported, it still exports. A test walks the static import graph, so
  the client cannot creep back in.

## 0.8.0 (2026-09-18)

### Added
- **Lighthouse storage driver**, `orbitdb-storage-bridge/backends/lighthouse`: upload, listing
  and deletion over the endpoints `@lighthouse-web3/sdk` 0.4.7 uses, without the SDK. A backup's
  CAR goes up as a plain file and comes back byte for byte; `carImport: true` sends CARs to
  `dag/import` instead. File names go up without their path, and errors carry Lighthouse's reason;
  an expired plan is `UNSUPPORTED`. **Uploads are not yet verified against a live account**: the
  key and the listing are, but the test account's trial had expired (2026-09-17, issue #60).

### Fixed
- **Backups work in browsers.** `backupDatabase` built its CAR through Node's `Readable.from`,
  which the stream polyfill a bundler gives the browser does not have, so every browser backup
  failed before anything was uploaded. The CAR is now read with a plain async loop.
- **A backup holds the identity of the database's writer, without searching the network for
  it.** `extractDatabaseBlocks` asked the log's storage for the identity, which does not hold
  identities made by `Identities()` without `ipfs`: Helia then searched the network until
  OrbitDB's 30-second timeout, and the backup went up without the identity. The block now comes
  from the database's own identity.
- **A courier delta carries the writer's identity, for the same reason.** `createDelta` asked
  the log's storage too, so an app with its own identity provider — a passkey, a DID — would
  have sent its entries over a mesh without the block a receiver needs to verify them, after
  waiting out a network search that a courier has no network for. Databases whose identities
  OrbitDB makes itself were never affected.
- The library logged "Uploading to Storacha" whatever the backend was; it names the backend now.

## 0.7.0 (2026-09-17)

### Added
- **Pinata storage driver**, `orbitdb-storage-bridge/backends/pinata` (#80, #84). Verified against a
  live free-plan account on 2026-09-17: upload, listing, deletion, CAR backups and a database
  restored on a second node. Pin by CID and CAR import are paid-plan features, so both are opt-in
  (`pinByCid`, `carImport`). Use the dedicated gateway of the key's own account; it may be given as
  the bare domain Pinata's dashboard shows. Errors carry Pinata's reason.

### Changed
- `key-did-provider-ed25519`, `@orbitdb/identity-provider-did` and `key-did-resolver` are
  devDependencies now: nothing the package ships imports them. Installing the package brings no
  known vulnerability (`npm audit --omit=dev`) (#85).
- Errors the library rethrows from a `catch` carry the original error as `cause` (#86).
- **Renamed to `orbitdb-storage-bridge`** — published as `orbitdb-storacha-bridge` up to 0.6.0.
  Storacha is no longer the only backend, so the name stopped describing the package. The
  rename changes no API: replace the dependency and the import specifiers
  (`orbitdb-storacha-bridge/courier-sync` → `orbitdb-storage-bridge/courier-sync`, and so on).
  Names that refer to Storacha itself stay — `OrbitDBStorachaBridge`, `StorachaIntegration.svelte`,
  `backends/storacha`, the `storacha_*` localStorage keys — and so does the debug namespace
  `libp2p:orbitdb-storacha:*`.

### Removed
- `StorachaTest.svelte`, `StorachaTestWithReplication.svelte` and `StorachaTestWithWebAuthn.svelte`
  are no longer in the package (#83). Each imported a file no release ever contained, so none of
  them could be imported.

Releases 0.5.0 to 0.6.0 are described in their
[GitHub release notes](https://github.com/NiKrause/orbitdb-storage-bridge/releases).

## 0.4.3 (2026-01-23)

### Added
- IPFS network restore with gateway fallback and new network download tests.
- In-memory Storacha test mode with local gateway support and improved integration test harness.
- Timestamped backup example and dedicated test suite.
- CAR backup documentation plus expanded test and example docs.
- New E2E coverage for Svelte examples.

### Changed
- Logging migrated to `@libp2p/logger` for structured output.
- Svelte example apps updated (UI polish, configs, and test setup).
- CI now runs Svelte E2E jobs sequentially and pins Playwright to IPv4 loopback.

### Fixed
- Integration test stability (sequencing, retries, and cleanup improvements).
- Linting and dependency fixes across the repo.

### Removed
- `examples/svelte/ucan-delegation` moved out of mainline (now on a separate branch).
