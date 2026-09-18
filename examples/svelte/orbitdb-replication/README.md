# Replication, and a backup beside it

Alice and Bob are two OrbitDB nodes in one page. They meet through a libp2p
relay, share one database address, and replicate: what Alice writes appears in
Bob's list, and what Bob writes appears in Alice's. The same database is also
backed up, as one CAR file, to Aleph, Pinata or Lighthouse — and Bob can restore
it while the replication keeps running.

## Running it

The example uses the library in this checkout (`file:../../../`), so install the
repository root first:

```sh
npm install                              # in the repository root
cd examples/svelte/orbitdb-replication
npm install
npm run dev
```

Out of the box the two nodes meet on a public relay. `VITE_RELAY_ADDRS` names
another one instead (comma-separated multiaddrs, each with its `/p2p/` id):

```sh
VITE_RELAY_ADDRS=/ip4/127.0.0.1/tcp/9092/ws/p2p/12D3Koo... npm run dev
```

Blocks come from the peer, not from public gateways: Helia is started without a
delegated router or recursive gateways, so a missing block is asked of whoever
is on the other end of the connection this demo is about.

## Where backups go

- **Aleph** needs no account and nothing to paste. The upload is not kept,
  though: keeping it takes a wallet-signed STORE message, which this demo does
  not send.
- **Pinata** needs a JWT, and optionally a dedicated gateway from the same
  account.
- **Lighthouse** needs an API key. The driver has not yet been verified against
  a live account.

A key stays in the tab's memory and is sent from the browser, so use one you can
revoke.

## Tests

```sh
npx playwright test                  # starts a relay, builds the site, runs the tests
ALEPH_LIVE=1 npx playwright test     # the same, against the real Aleph
```

The test starts its own relay on this machine, plays Aleph itself, and refuses
every other request that would leave the machine.

Debug logs: `localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')`.
