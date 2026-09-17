# Changes

## 0.7.0 (unreleased)

### Changed
- **Renamed to `orbitdb-storage-bridge`** — published as `orbitdb-storacha-bridge` up to 0.6.0.
  Storacha is no longer the only backend, so the name stopped describing the package. The
  rename changes no API: replace the dependency and the import specifiers
  (`orbitdb-storacha-bridge/courier-sync` → `orbitdb-storage-bridge/courier-sync`, and so on).
  Names that refer to Storacha itself stay — `OrbitDBStorachaBridge`, `StorachaIntegration.svelte`,
  `backends/storacha`, the `storacha_*` localStorage keys — and so does the debug namespace
  `libp2p:orbitdb-storacha:*`.

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
