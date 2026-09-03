/**
 * Courier Sync — transport-neutral OrbitDB replication over any byte courier.
 *
 * The load-bearing fact this module builds on is the one this bridge proves
 * with Storacha: OrbitDB replication is "obtain the blocks, join the heads".
 * The courier is interchangeable — Storacha, a LoRa mesh, a QR relay, a file.
 * Design thread: https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic/issues/1
 * Seam requirements: https://github.com/NiKrause/orbitdb-storacha-bridge/issues/50
 *
 * The courier contract (the seam):
 *   courier.send(bytes: Uint8Array): Promise<void>
 *     May be slow on purpose — it resolves when the courier has delivered or
 *     scheduled the message within whatever budget it has (a duty-cycled radio
 *     legally may not hurry). The sync layer treats that as backpressure.
 *   courier.onPayload(cb: (bytes: Uint8Array) => void): () => void
 *     Delivery may be lossy, reordered and duplicated; the protocol tolerates
 *     all three. Returns an unsubscribe function.
 *
 * Wire messages (dag-cbor encoded, one per courier payload):
 *   { v, tag, t: "announce", heads: [hash] }
 *   { v, tag, t: "want", cids: [hash], have: [hash] }
 *   { v, tag, t: "blocks", heads: [hash], blocks: [{ hash, bytes }] }
 * `tag` is a short hash of the database address, so couriers can be shared
 * between databases without cross-talk while the address itself stays off
 * the air (the mesh reads everything).
 */

import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";

export const COURIER_SYNC_VERSION = 1;

const TAG_LENGTH = 8;

/**
 * Short identifier for a database address: first bytes of its sha256.
 * @param {string} address OrbitDB address (/orbitdb/zdpu...)
 * @returns {Promise<Uint8Array>}
 */
export async function databaseTag(address) {
  const digest = await sha256.digest(new TextEncoder().encode(address));
  return digest.digest.slice(0, TAG_LENGTH);
}

function sameTag(a, b) {
  if (!(a instanceof Uint8Array) || a.length !== TAG_LENGTH) return false;
  return a.every((byte, i) => byte === b[i]);
}

function manifestCidOf(address) {
  return address.split("/").pop();
}

function isOplogEntry(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.sig &&
    value.payload !== undefined &&
    Array.isArray(value.next),
  );
}

/**
 * Compute the delta a peer with `theirHeads` is missing: entry blocks from our
 * heads down to their heads, the identity blocks those entries reference, and
 * — on first contact (empty `theirHeads`) — the manifest and access controller
 * blocks a fresh peer needs before it can even open the database.
 *
 * Blocks are returned parents-before-children so a receiver can verify the
 * chain without ever reaching for a network that is not there.
 *
 * When the logs have diverged below `theirHeads`, the delta may include blocks
 * the peer already has; applying is idempotent, so that costs bytes, not
 * correctness. (A frontier/bloom exchange can shrink this later.)
 *
 * @param {Object} params
 * @param {Object} params.db An open OrbitDB database
 * @param {Array<string>} [params.theirHeads] Head hashes the peer announced
 * @returns {Promise<{heads: Array<string>, blocks: Array<{hash: string, bytes: Uint8Array}>}>}
 */
export async function createDelta({ db, theirHeads = [] }) {
  const stop = new Set(theirHeads);
  const heads = await db.log.heads();
  const headHashes = heads.map((entry) => entry.hash);

  const seen = new Set();
  const identityHashes = new Set();
  const entryBlocks = [];
  const queue = headHashes.filter((hash) => !stop.has(hash));

  while (queue.length > 0) {
    const hash = queue.shift();
    if (seen.has(hash) || stop.has(hash)) continue;
    seen.add(hash);

    const bytes = await db.log.storage.get(hash);
    if (!bytes) continue;
    entryBlocks.push({ hash, bytes });

    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) continue;
    if (value.identity) identityHashes.add(value.identity);
    for (const parent of [...value.next, ...(value.refs || [])]) {
      if (!seen.has(parent) && !stop.has(parent)) queue.push(parent);
    }
  }

  const staticBlocks = [];

  // Identity blocks travel with the entries that reference them — a writer the
  // peer has never seen costs one extra block, a known writer costs a
  // duplicate put, which is free.
  for (const identityHash of identityHashes) {
    const bytes = await db.log.storage.get(identityHash);
    if (bytes) staticBlocks.push({ hash: identityHash, bytes });
  }

  // First contact additionally needs the manifest and the access controller,
  // or the peer cannot open the address at all.
  if (theirHeads.length === 0) {
    const manifestCid = manifestCidOf(db.address);
    const manifestBytes = await db.log.storage.get(manifestCid);
    if (manifestBytes) {
      staticBlocks.push({ hash: manifestCid, bytes: manifestBytes });
      const manifest = dagCbor.decode(manifestBytes);
      if (manifest && manifest.accessController) {
        const accessCid = manifest.accessController.replace("/ipfs/", "");
        const accessBytes = await db.log.storage.get(accessCid);
        if (accessBytes)
          staticBlocks.push({ hash: accessCid, bytes: accessBytes });
      }
    }
  }

  // Parents before children: entryBlocks were collected heads-first, so the
  // reversed order is oldest-first; static blocks go before everything.
  return {
    heads: headHashes,
    blocks: [...staticBlocks, ...entryBlocks.reverse()],
  };
}

/**
 * Apply a delta to a local blockstore and join its heads into the log.
 *
 * All blocks are put first; then, before any join, the entry chain is checked
 * for closure — every `next`/`refs` reference must be present in the delta or
 * already in the log. `joinEntry` would otherwise reach into block storage for
 * the missing parent and time out against a network that is not there.
 *
 * @param {Object} params
 * @param {Object} params.db An open OrbitDB database
 * @param {{heads: Array<string>, blocks: Array<{hash: string, bytes: Uint8Array}>}} params.delta
 * @returns {Promise<{complete: boolean, joined: number, missing: Array<string>, entries: Array<Object>}>}
 */
export async function applyDelta({ db, delta }) {
  return applyDeltaToStores({
    blockstore: dbBlockstore(db),
    log: db.log,
    events: db.events,
    delta,
  });
}

function dbBlockstore(db) {
  // Database instances do not expose their Helia handle; the log's entry
  // storage is Composed(LRU, IPFSBlockStorage) and writing through it lands in
  // the same blockstore `joinEntry` reads from.
  return {
    put: async (hash, bytes) => {
      await db.log.storage.put(hash, bytes);
    },
  };
}

async function applyDeltaToStores({ blockstore, log, events, delta }) {
  const inDelta = new Map();
  for (const block of delta.blocks || []) {
    inDelta.set(block.hash, block.bytes);
    await blockstore.put(block.hash, block.bytes);
  }

  // Closure check before joining anything. Only the delta itself and the
  // log's own index are consulted — never raw block storage, whose `get`
  // waits out a 30-second network timeout on a miss, against a network that
  // is not there. Anything received in an earlier partial delivery is still
  // in the delta, because the caller keeps blocks parked until completeness.
  const missing = [];
  for (const [, bytes] of inDelta) {
    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) continue;
    for (const parent of [...value.next, ...(value.refs || [])]) {
      if (inDelta.has(parent)) continue;
      if (await log.has(parent)) continue;
      missing.push(parent);
    }
  }
  if (missing.length > 0) {
    return { complete: false, joined: 0, missing, entries: [] };
  }

  let joined = 0;
  const entries = [];
  for (const hash of delta.heads || []) {
    if (await log.has(hash)) continue;
    const bytes = inDelta.get(hash);
    if (!bytes) continue;
    const value = dagCbor.decode(bytes);
    if (!isOplogEntry(value)) continue;
    const entry = { ...value, hash };
    const updated = await log.joinEntry(entry);
    if (updated) {
      joined++;
      entries.push(entry);
    }
  }

  // Database.applyOperation emits 'update' when the pubsub Sync delivers an
  // entry; a courier delivery is the same event from the application's side.
  if (events && joined > 0) {
    for (const entry of entries) events.emit("update", entry);
  }

  return { complete: true, joined, missing: [], entries };
}

/**
 * Attach a database to a courier and keep the two ends converged.
 *
 * Can start without an open database: given `orbitdb` and `address`, the first
 * complete delta (which carries the manifest on first contact) opens the
 * database locally with `sync: false` — replication then runs entirely over
 * the courier, no libp2p involved.
 *
 * @param {Object} params
 * @param {Object} [params.db] An open database (own-writes side)
 * @param {Object} [params.orbitdb] OrbitDB instance, required when `db` is not given
 * @param {string} [params.address] Database address, required when `db` is not given
 * @param {Object} params.courier The byte courier (see module docs)
 * @param {Object} [params.dbOptions] Extra options for the lazy `orbitdb.open`
 * @returns {Promise<Object>} sync handle: { start, stop, announce, db(), events }
 */
export async function createCourierSync({
  db = null,
  orbitdb = null,
  address = null,
  courier,
  dbOptions = {},
}) {
  if (
    !courier ||
    typeof courier.send !== "function" ||
    typeof courier.onPayload !== "function"
  ) {
    throw new Error("A courier with send() and onPayload() is required");
  }
  const databaseAddress = address || (db && db.address);
  if (!databaseAddress) {
    throw new Error("Either an open db or a database address is required");
  }
  if (!db && !orbitdb) {
    throw new Error(
      "An orbitdb instance is required to open the database on first contact",
    );
  }

  const tag = await databaseTag(databaseAddress);
  const pendingBlocks = new Map(); // hash -> bytes, parked until the database can open
  const listeners = { synced: [], message: [], error: [] };
  let database = db;
  let unsubscribe = null;
  let offUpdate = null;
  let queue = Promise.resolve();
  let started = false;
  let applying = false;

  const emit = (event, payload) => {
    for (const cb of listeners[event] || []) {
      try {
        cb(payload);
      } catch {
        // listeners must not break the protocol
      }
    }
  };

  const send = async (message) => {
    const bytes = dagCbor.encode({ v: COURIER_SYNC_VERSION, tag, ...message });
    emit("message", { direction: "out", type: message.t, bytes: bytes.length });
    await courier.send(bytes);
  };

  const ourHeadHashes = async () =>
    database ? (await database.log.heads()).map((entry) => entry.hash) : [];

  const announce = async () => {
    if (!database) {
      // Nothing local yet — not even the manifest. An announce of empty heads
      // cannot get one from a peer whose log is also empty, so first contact
      // is an explicit bootstrap request: a want with an empty frontier makes
      // the peer send its static blocks even when it has no entries at all.
      await send({ t: "want", cids: [], have: [] });
      return;
    }
    await send({ t: "announce", heads: await ourHeadHashes() });
  };

  const openIfPossible = async () => {
    if (database || !orbitdb) return;
    const manifestCid = manifestCidOf(databaseAddress);
    if (!pendingBlocks.has(manifestCid)) return;
    // The blocks must be in the blockstore BEFORE the open: resolving the
    // manifest (and later the access controller) reads through IPFS block
    // storage, and a miss there waits out a 30-second timeout against a
    // network that is not there.
    for (const [hash, bytes] of pendingBlocks) {
      await orbitdb.ipfs.blockstore.put(CID.parse(hash, base58btc), bytes);
    }
    database = await orbitdb.open(databaseAddress, {
      sync: false,
      ...dbOptions,
    });
    watchLocalUpdates();
  };

  const watchLocalUpdates = () => {
    if (!database || offUpdate) return;
    const onUpdate = () => {
      if (applying) return; // courier-applied entries already end in an announce
      queue = queue
        .then(() => announce())
        .catch((error) => emit("error", error));
    };
    database.events.on("update", onUpdate);
    offUpdate = () => database.events.off("update", onUpdate);
  };

  const handleAnnounce = async (message) => {
    const theirHeads = message.heads || [];
    if (!database) {
      // Nothing local yet: ask for everything below their heads.
      if (theirHeads.length > 0)
        await send({ t: "want", cids: theirHeads, have: [] });
      return;
    }
    const ours = await ourHeadHashes();
    const theirSet = new Set(theirHeads);
    const theyLack = ours.filter((hash) => !theirSet.has(hash));
    const weLack = [];
    for (const hash of theirHeads) {
      if (!(await database.log.has(hash))) weLack.push(hash);
    }
    if (theyLack.length > 0) {
      const delta = await createDelta({ db: database, theirHeads });
      await send({ t: "blocks", heads: delta.heads, blocks: delta.blocks });
    }
    if (weLack.length > 0) {
      await send({ t: "want", cids: weLack, have: ours });
    }
  };

  const handleWant = async (message) => {
    if (!database) return;
    const delta = await createDelta({
      db: database,
      theirHeads: message.have || [],
    });
    // Repair mode: a peer may ask for specific blocks (missing parents) that
    // sit below both frontiers; include them explicitly if we hold them.
    const included = new Set(delta.blocks.map((block) => block.hash));
    for (const hash of message.cids || []) {
      if (included.has(hash)) continue;
      const bytes = await database.log.storage.get(hash).catch(() => null);
      if (bytes) delta.blocks.unshift({ hash, bytes });
    }
    await send({ t: "blocks", heads: delta.heads, blocks: delta.blocks });
  };

  const handleBlocks = async (message) => {
    for (const block of message.blocks || [])
      pendingBlocks.set(block.hash, block.bytes);
    await openIfPossible();
    if (!database) return;

    const delta = {
      heads: message.heads || [],
      blocks: Array.from(pendingBlocks, ([hash, bytes]) => ({ hash, bytes })),
    };
    applying = true;
    let result;
    try {
      result = await applyDelta({ db: database, delta });
    } finally {
      applying = false;
    }
    if (!result.complete) {
      await send({
        t: "want",
        cids: result.missing,
        have: await ourHeadHashes(),
      });
      return;
    }
    pendingBlocks.clear();
    if (result.joined > 0) {
      emit("synced", { joined: result.joined, entries: result.entries });
    }
    // Tells the peer where we now stand — their diff turns empty and the
    // exchange goes quiet; doubles as an end-to-end acknowledgement.
    await announce();
  };

  const handlePayload = (bytes) => {
    queue = queue
      .then(async () => {
        let message;
        try {
          message = dagCbor.decode(bytes);
        } catch {
          return; // not ours
        }
        if (
          !message ||
          message.v !== COURIER_SYNC_VERSION ||
          !sameTag(message.tag, tag)
        )
          return;
        emit("message", {
          direction: "in",
          type: message.t,
          bytes: bytes.length,
        });
        if (message.t === "announce") return handleAnnounce(message);
        if (message.t === "want") return handleWant(message);
        if (message.t === "blocks") return handleBlocks(message);
      })
      .catch((error) => emit("error", error));
  };

  return {
    get db() {
      return database;
    },
    address: databaseAddress,
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return () => listeners[event].splice(listeners[event].indexOf(cb), 1);
    },
    async start() {
      if (started) return;
      started = true;
      unsubscribe = courier.onPayload(handlePayload);
      watchLocalUpdates();
      await announce();
    },
    /** Re-announce — recovery poke after suspected loss. */
    announce: () => announce(),
    /** Wait until in-flight message handling settles (mainly for tests). */
    async idle() {
      await queue;
    },
    async stop() {
      started = false;
      if (unsubscribe) unsubscribe();
      if (offUpdate) offUpdate();
      unsubscribe = null;
      offUpdate = null;
      await queue.catch(() => {});
    },
  };
}
