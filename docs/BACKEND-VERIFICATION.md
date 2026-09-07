# Verifying a storage backend

Every driver in `lib/backends/` passes the conformance suite in `test/backends/`. For two
of them that means something; for three of them it means less than it looks, and this page
exists so nobody has to guess which is which.

## What is actually verified today

| Driver | Offline tests | Run against the real service | Written from |
| --- | --- | --- | --- |
| `memory` | ✅ full conformance | n/a — there is no service | itself |
| `storacha` | ✅ full conformance against the in-memory upload-api | ❌ impossible: the service was decommissioned in 2026 | the code it always ran against |
| `pinata` | ✅ construction and capability tests | ❌ **never** | the v3 API documentation |
| `lighthouse` | ✅ construction and capability tests | ❌ **never** | the SDK source and their API |
| `aleph` | ✅ construction and capability tests | ⚠️ endpoints probed on 2026-09-05, no upload performed | direct probes plus `relay-button` |

So: **three drivers have never moved a byte.** Their endpoints, payloads and response
shapes come from documentation and source, which is a good starting point and not the same
thing as working. The conformance suite is written and waiting; what is missing is an
account to point it at.

This is the kind of gap that is easy to leave open forever, because the offline tests are
green and the CI is green and nothing complains. That is why it is written down here rather
than assumed.

## Running the suite

Offline — no credentials, no network, nothing to pay for:

```bash
npm run test:backends
```

That runs `memory` and `storacha` (against the in-memory upload-api in `test/helpers/`)
through the full contract, plus the construction and strategy tests for every driver.

### Pinata

```bash
PINATA_JWT=... PINATA_GATEWAY=https://your-gateway.mypinata.cloud npm run test:backends
```

What it does: uploads a few small blobs and one CAR, lists, deletes, and pins one CID.
Everything it stores is tracked and deleted on teardown.

What to expect:

- **CAR uploads need a paid plan.** On a free account the CAR test fails with a plan error,
  which is a true answer, not a broken test. Report it as such.
- **CAR validation is asynchronous.** Pinata accepts the upload, then checks the blocks and
  reports by webhook. The suite reads back immediately, so a 404 on the CAR round trip may
  mean "not indexed yet" rather than "lost". If you see one, retry the read before
  concluding anything.
- The CAR must have a single root CID. Ours does — the manifest.

### Lighthouse

```bash
LIGHTHOUSE_API_KEY=... LIGHTHOUSE_LIVE_TEST=1 npm run test:backends
```

Two gates on purpose. Lighthouse is pay once, stored in perpetuity, so **every run buys
permanent storage and deleting does not refund it**. A key sitting in the environment is
not consent to spend on each run.

Mint a key with your own wallet rather than sharing one: `getApiKey(publicKey,
signedMessage)` against `POST /api/auth/create_api_key`. If you do, construct the backend
with `keyOwnership: "user"` — that is what makes it declare `browserSafeAuth`.

### Aleph

Not runnable yet, and this is the most interesting gap.

Ingest works without any credential — `POST https://ipfs.aleph.cloud/api/v0/add` answered
without authentication and with `access-control-allow-origin: *` when probed on 2026-09-05.
But ingest is not persistence: what keeps the bytes is a wallet-signed STORE message with
the `ipfs` storage engine, and the driver refuses to be constructed without a
`publishStore` function precisely so that nobody mistakes one for the other.

Wiring a signer is the missing piece. `@le-space/browser` in
[`relay-button`](https://github.com/NiKrause/relay-button) already publishes and reads
Aleph messages, so the work is connecting two things that exist rather than writing
something new.

Two facts to carry into that work, both learned from `relay-button` rather than the docs:

- A STORE can be **rejected or removed** when its publisher runs out of Aleph credits
  (`balance_insufficient`). A pin here is credit-backed, not permanent.
- Message status matters: `pending`, `processed` and `rejected` are all things a query
  returns. `list()` filters to `processed` by default, because a rejected store is not a
  backup.

## What a useful report contains

Not just pass or fail. The suite is a set of questions, and the interesting answers are the
ones that surprise us:

1. Which tests passed, which failed, and the actual error text.
2. **Did the CAR round trip preserve every inner CID?** This is the load-bearing one. A
   backend that passes everything else and fails this cannot back up a database.
3. Whether a read straight after a write worked, or needed a retry — and how long.
4. Plan, tier and region, since several of these limits are plan-dependent.
5. Anything the driver's declared capabilities got wrong. A capability set is what
   `chooseBackupStrategy` reads and what callers trust, so an overstated flag is worse
   than a missing feature.

Open an issue with that, or comment on the tracking issue for backend independence.
