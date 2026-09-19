/**
 * Courier Sync — transport-neutral OrbitDB replication over any byte courier.
 *
 * The load-bearing fact this module builds on is the one this bridge proves
 * with Storacha: OrbitDB replication is "obtain the blocks, join the heads".
 * The courier is interchangeable — Storacha, a LoRa mesh, a QR relay, a file.
 * Design thread: https://github.com/NiKrause/funkpost/issues/1
 * Seam requirements: https://github.com/NiKrause/orbitdb-storage-bridge/issues/50
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
 *   { v, tag, p, t: "announce", heads: [hash] }
 *   { v, tag, p, t: "want", cids: [hash], have: [hash] }
 *   { v, tag, p, t: "blocks", heads: [hash], blocks: [{ hash, bytes }] }
 *   { v, tag, p, t: "hello" }   is anybody keeping this database out there?
 *   { v, tag, p, t: "here" }    the answer
 * `tag` is a short hash of the database address, so couriers can be shared
 * between databases without cross-talk while the address itself stays off
 * the air (the mesh reads everything).
 *
 * `p` is a four-byte sender id, and it is what makes *presence* possible: a
 * carrier can tell you a radio is in range, which is not the question. The
 * question is whether another program is keeping the same database, and only
 * that program can answer it. Every message carries the id, so ordinary
 * traffic already answers it for free; `hello` exists for the silence in
 * between, when nothing has been written for a while and somebody wants to
 * know before spending airtime on a whole delta.
 *
 * The id is per instance and says nothing about who you are — the tag already
 * names the conversation, and a mesh reads everything. A peer on an older
 * version sends no id and answers no `hello`: its traffic still counts as
 * "somebody is out there" (`lastHeardAgoMs`), it just cannot be counted as a
 * peer. Answers go out immediately and without jitter on purpose; the radio
 * underneath already has a MAC, and backing off twice is worse than once.
 */

/* global CompressionStream, DecompressionStream */
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";

export const COURIER_SYNC_VERSION = 1;

const TAG_LENGTH = 8;

// Four bytes of sender id: enough that two peers in one conversation collide
// with probability ~1 in 4 billion, small enough to ride on every message.
const PEER_ID_LENGTH = 4;
// How long a peer stays "present" after its last word. A mesh is slow and a
// budget is rationed, so silence for two minutes is ordinary, not absence.
const PEER_TIMEOUT_MS = 120_000;

// Wire framing: one prefix byte in front of the dag-cbor message — 0 = raw,
// 1 = gzip. The first-contact bootstrap (manifest + access controller +
// identity + entries) is a couple of kilobytes of dag-cbor full of CIDs and
// signatures, which deflates by roughly half; on a slow, lossy carrier like a
// LoRa mesh that is the difference between a bootstrap that clears the ARQ's
// rounds and one that does not. Small messages (announce, want) skip it.
const GZIP_PREFIX = 1;
const RAW_PREFIX = 0;
const GZIP_THRESHOLD = 256;

const prefixBytes = (flag, body) => {
  const out = new Uint8Array(body.length + 1);
  out[0] = flag;
  out.set(body, 1);
  return out;
};

async function gzipBytes(input) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzipBytes(input) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(input);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** dag-cbor bytes → framed wire bytes (compressed when it helps). */
async function frameMessage(raw) {
  if (typeof CompressionStream === "undefined" || raw.length < GZIP_THRESHOLD) {
    return prefixBytes(RAW_PREFIX, raw);
  }
  try {
    const z = await gzipBytes(raw);
    // Only ship the compressed form if it is actually smaller.
    if (z.length + 1 < raw.length) return prefixBytes(GZIP_PREFIX, z);
  } catch {
    /* fall through to raw */
  }
  return prefixBytes(RAW_PREFIX, raw);
}

/** framed wire bytes → dag-cbor bytes (throws on foreign/garbage input). */
async function unframeMessage(framed) {
  if (!(framed instanceof Uint8Array) || framed.length === 0) {
    throw new Error("empty frame");
  }
  const body = framed.subarray(1);
  if (framed[0] === GZIP_PREFIX) return gunzipBytes(body);
  if (framed[0] === RAW_PREFIX) return body;
  throw new Error("unknown frame prefix"); // not ours
}

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

/**
 * A sender id for one sync instance: four random bytes, not an identity.
 * @returns {Uint8Array}
 */
function randomPeerId() {
  return globalThis.crypto.getRandomValues(new Uint8Array(PEER_ID_LENGTH));
}

const hex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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
  //
  // Our own identity carries its block; the log's storage may never have held
  // it. `Identities()` without `ipfs` — what an app with its own identity
  // provider builds, a passkey or a DID — keeps identities in memory, and a
  // Helia blockstore asked for one searches a network that, on the far side of
  // a courier, is not there. The delta would then go out without the block the
  // receiver needs to verify these very entries.
  const ownIdentity = db.identity ?? db.log.identity;
  for (const identityHash of identityHashes) {
    const bytes =
      ownIdentity?.hash === identityHash && ownIdentity.bytes
        ? ownIdentity.bytes
        : await db.log.storage.get(identityHash);
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
 * the courier, no libp2p involved. `db` stays null until that delta is joined:
 * an application writes as soon as it has a database, and a write racing the
 * bootstrap join can drop out of the log's heads and never be sent.
 *
 * @param {Object} params
 * @param {Object} [params.db] An open database (own-writes side)
 * @param {Object} [params.orbitdb] OrbitDB instance, required when `db` is not given
 * @param {string} [params.address] Database address, required when `db` is not given
 * @param {Object} params.courier The byte courier (see module docs)
 * @param {Object} [params.dbOptions] Extra options for the lazy `orbitdb.open`
 * @param {boolean} [params.announceOnLocalUpdate=true] Announce as soon as a
 *   local write lands. Default keeps the eager behaviour. Set false where the
 *   courier is expensive — a duty-cycled radio, say — and the application would
 *   rather batch several writes and call `announce()` once, deliberately.
 * @param {Uint8Array} [params.peerId] Four-byte sender id. Random per instance
 *   by default, which is what presence wants: it identifies this program on
 *   this carrier for as long as it runs, and nothing beyond that.
 * @param {number} [params.peerTimeoutMs=120000] How long a peer counts as
 *   present after its last word.
 * @returns {Promise<Object>} sync handle: { start, stop, announce, hello,
 *   presence, forgetPeers, db(), events }
 */
export async function createCourierSync({
  db = null,
  orbitdb = null,
  address = null,
  courier,
  dbOptions = {},
  rejoinIntervalMs = 15000,
  announceOnLocalUpdate = true,
  peerId = randomPeerId(),
  peerTimeoutMs = PEER_TIMEOUT_MS,
}) {
  if (
    !courier ||
    typeof courier.send !== "function" ||
    typeof courier.onPayload !== "function"
  ) {
    throw new Error("A courier with send() and onPayload() is required");
  }
  if (!(peerId instanceof Uint8Array) || peerId.length !== PEER_ID_LENGTH) {
    throw new Error(`peerId must be ${PEER_ID_LENGTH} bytes`);
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
  const peers = new Map(); // sender id (hex) -> when we last heard it
  let lastHeardAt = null; // any traffic for this database, identified or not
  const listeners = { synced: [], message: [], error: [] };
  let database = db;
  // Opened on first contact but not handed out: the bootstrap is not in it yet.
  // The protocol works on it all the same, so repair stays incremental.
  let opening = null;
  let unsubscribe = null;
  let offUpdate = null;
  let queue = Promise.resolve();
  let started = false;
  let applying = false;
  let rejoinTimer = null;

  const stopRejoin = () => {
    if (rejoinTimer) {
      clearInterval(rejoinTimer);
      rejoinTimer = null;
    }
  };

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
    const raw = dagCbor.encode({
      v: COURIER_SYNC_VERSION,
      tag,
      p: peerId,
      ...message,
    });
    const framed = await frameMessage(raw);
    // Report the wire size — what actually crosses the air and pays airtime.
    emit("message", {
      direction: "out",
      type: message.t,
      bytes: framed.length,
    });
    await courier.send(framed);
  };

  /**
   * Somebody said something for this database.
   *
   * A message without an id is an older peer: it still proves the air is not
   * empty, which is why `lastHeardAt` moves either way, but it cannot be
   * counted. Our own id comes back when a mesh repeats us, and that proves
   * nothing at all.
   */
  const noteHeard = (id) => {
    const identified = id instanceof Uint8Array && id.length === PEER_ID_LENGTH;
    if (identified && hex(id) === hex(peerId)) return; // a mesh repeating us
    lastHeardAt = Date.now();
    if (identified) peers.set(hex(id), lastHeardAt);
  };

  /**
   * Answer a peer asking whether anyone keeps this database. Answering means
   * exactly that — listening on this tag — and nothing about having the log:
   * a peer still bootstrapping is as present as one in step, and the asker
   * finds out which by talking to it.
   */
  const handleHello = async () => {
    await send({ t: "here" });
  };

  /** The database the protocol works on — handed out or not. */
  const local = () => database || opening;

  const ourHeadHashes = async (target = local()) =>
    target ? (await target.log.heads()).map((entry) => entry.hash) : [];

  const announce = async () => {
    if (!local()) {
      // Nothing local yet — not even the manifest. An announce of empty heads
      // cannot get one from a peer whose log is also empty, so first contact
      // is an explicit bootstrap request: a want with an empty frontier makes
      // the peer send its static blocks even when it has no entries at all.
      await send({ t: "want", cids: [], have: [] });
      return;
    }
    await send({ t: "announce", heads: await ourHeadHashes() });
  };

  /** The database to join a first-contact delta into, opened once the manifest is here. */
  const openIfPossible = async () => {
    if (opening || !orbitdb) return opening;
    const manifestCid = manifestCidOf(databaseAddress);
    if (!pendingBlocks.has(manifestCid)) return null;
    // The blocks must be in the blockstore BEFORE the open: resolving the
    // manifest (and later the access controller) reads through IPFS block
    // storage, and a miss there waits out a 30-second timeout against a
    // network that is not there.
    for (const [hash, bytes] of pendingBlocks) {
      await orbitdb.ipfs.blockstore.put(CID.parse(hash, base58btc), bytes);
    }
    opening = await orbitdb.open(databaseAddress, {
      sync: false,
      ...dbOptions,
    });
    stopRejoin(); // the manifest is here — repair from now on is incremental
    return opening;
  };

  const watchLocalUpdates = () => {
    // Opted out: the application announces when it decides to, not when a write
    // happens. Incoming announces are still answered, so a peer asking for
    // blocks is served — going quiet must not mean going deaf.
    if (!announceOnLocalUpdate) return;
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
    const target = local();
    if (!target) {
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
      if (!(await target.log.has(hash))) weLack.push(hash);
    }
    if (theyLack.length > 0) {
      const delta = await createDelta({ db: target, theirHeads });
      await send({ t: "blocks", heads: delta.heads, blocks: delta.blocks });
    }
    if (weLack.length > 0) {
      await send({ t: "want", cids: weLack, have: ours });
    }
  };

  const handleWant = async (message) => {
    const target = local();
    if (!target) return;
    const delta = await createDelta({
      db: target,
      theirHeads: message.have || [],
    });
    // Repair mode: a peer may ask for specific blocks (missing parents) that
    // sit below both frontiers; include them explicitly if we hold them.
    const included = new Set(delta.blocks.map((block) => block.hash));
    for (const hash of message.cids || []) {
      if (included.has(hash)) continue;
      const bytes = await target.log.storage.get(hash).catch(() => null);
      if (bytes) delta.blocks.unshift({ hash, bytes });
    }
    await send({ t: "blocks", heads: delta.heads, blocks: delta.blocks });
  };

  const handleBlocks = async (message) => {
    for (const block of message.blocks || [])
      pendingBlocks.set(block.hash, block.bytes);
    const target = local() || (await openIfPossible());
    if (!target) return;

    const delta = {
      heads: message.heads || [],
      blocks: Array.from(pendingBlocks, ([hash, bytes]) => ({ hash, bytes })),
    };
    applying = true;
    let result;
    try {
      result = await applyDelta({ db: target, delta });
    } finally {
      applying = false;
    }
    if (!result.complete) {
      await send({
        t: "want",
        cids: result.missing,
        have: await ourHeadHashes(target),
      });
      return;
    }
    pendingBlocks.clear();
    if (!database) {
      // First contact is complete: only now is the database the application's.
      // Handed out in the same synchronous step that emits "synced", so no
      // turn of the event loop sees one without the other.
      database = target;
      opening = null;
      watchLocalUpdates();
    }
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
          message = dagCbor.decode(await unframeMessage(bytes));
        } catch {
          return; // not ours (foreign traffic, garbage, or a bad frame)
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
        noteHeard(message.p);
        if (message.t === "hello") return handleHello(message);
        if (message.t === "here") return; // the id in it was the whole message
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
      // A joiner that has not bootstrapped keeps re-asking on its own until
      // the database opens — so a bootstrap the lossy channel dropped heals
      // without the user pressing "join" again. Cleared the moment the
      // database opens (openIfPossible) or on stop().
      if (!database && orbitdb && rejoinIntervalMs > 0) {
        rejoinTimer = setInterval(() => {
          if (local() || !started) {
            stopRejoin();
            return;
          }
          queue = queue
            .then(() => announce())
            .catch((error) => emit("error", error));
        }, rejoinIntervalMs);
      }
    },
    /** Re-announce — recovery poke after suspected loss. */
    announce: () => announce(),
    /** This instance's sender id, as it appears on the wire. */
    peerId: hex(peerId),
    /**
     * Ask whether anybody out there keeps this database, and let them answer.
     *
     * Two small messages, and the only way to tell an app apart from a radio:
     * a carrier reports the radios in range, which says nothing about whether
     * a program on the other end is listening for *this* database. Call it
     * before spending airtime on a delta nobody is waiting for; read the
     * answer from `presence()` a moment later, since an answer has to travel.
     *
     * Requires `start()` — a sync that is not subscribed hears no answers.
     */
    hello: () => send({ t: "hello" }),
    /**
     * Who has been heard lately, and when the air last carried anything at
     * all for this database.
     *
     * Not a connection count: this carrier has no connections. It is the
     * honest form of the question — these peers said something recently.
     *
     * @returns {{peers: Array<{id: string, agoMs: number}>, lastHeardAgoMs: number|null}}
     */
    presence() {
      const at = Date.now();
      for (const [id, seen] of peers) {
        if (at - seen > peerTimeoutMs) peers.delete(id);
      }
      return {
        peers: [...peers.entries()].map(([id, seen]) => ({
          id,
          agoMs: at - seen,
        })),
        lastHeardAgoMs: lastHeardAt == null ? null : at - lastHeardAt,
      };
    },
    /**
     * Forget everyone heard so far.
     *
     * For when the carrier itself changes underneath — a radio switched to
     * another channel reaches other people, and peers heard on the old one
     * are not evidence about the new one.
     */
    forgetPeers() {
      peers.clear();
      lastHeardAt = null;
    },
    /** Wait until in-flight message handling settles (mainly for tests). */
    async idle() {
      await queue;
    },
    async stop() {
      started = false;
      stopRejoin();
      if (unsubscribe) unsubscribe();
      if (offUpdate) offUpdate();
      unsubscribe = null;
      offUpdate = null;
      await queue.catch(() => {});
    },
  };
}
