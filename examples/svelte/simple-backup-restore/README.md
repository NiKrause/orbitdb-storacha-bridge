# Backup and restore

Alice writes a few todos into an OrbitDB database and backs it up, as one CAR
file, to Aleph, Pinata or Lighthouse. Bob, a second OrbitDB node in the same
page, restores the database from the backup's CID. Nothing replicates between
them: the backup is the only way the todos reach Bob.

## Running it

The example uses the library in this checkout (`file:../../../`), so install
the repository root first:

```sh
npm install                               # in the repository root
cd examples/svelte/simple-backup-restore
npm install
npm run dev
```

`npm run build` writes a static site to `build/`; `npm run preview` serves it.

## Where backups go

- **Aleph** needs no account and nothing to paste. The upload is not kept,
  though: keeping it takes a wallet-signed STORE message, which this demo does
  not send.
- **Pinata** needs a JWT, and optionally a dedicated gateway from the same
  account.
- **Lighthouse** needs an API key. The driver has not yet been verified against
  a live account.

A key stays in the tab's memory and is sent from the browser, so use one you
can revoke.

## Identities

Alice and Bob share one identity, made either from a mnemonic or from a passkey
(`@le-space/orbitdb-identity-provider-webauthn-did`).

## Tests

```sh
npx playwright test                  # builds the site and runs the tests
ALEPH_LIVE=1 npx playwright test     # the backup test against the real Aleph
```

The backup test plays Aleph itself and refuses every other request that would
leave the machine.

Debug logs: `localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')`.
