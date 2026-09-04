/**
 * @fileoverview Courier Sync Tests
 *
 * Two OrbitDB instances converge over an in-memory byte courier — no libp2p
 * connection, no pubsub, no network. This is phase 0 of the LoRa data plane
 * (https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic/issues/1, tracked
 * here as issue #50): the protocol logic, tested against a courier that is
 * deliberately lossy, duplicating and reordering, the way a mesh is.
 *
 * The hard assertion running through the suite: replication happens while
 * both libp2p nodes hold ZERO connections.
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import {
  createCourierSync,
  createDelta,
  applyDelta,
  databaseTag,
} from "../lib/courier-sync.js";
import { createMemoryCourierPair } from "../lib/memory-courier.js";
import * as dagCbor from "@ipld/dag-cbor";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const GZIP_THRESHOLD_FOR_TEST = 256; // mirrors courier-sync GZIP_THRESHOLD

/**
 * Drive both couriers and both protocol queues until nothing moves anymore.
 * Each round waits for in-flight deliveries, then for the handlers those
 * deliveries triggered; handlers may send again, hence the bounded loop.
 */
async function converge(pair, syncs, rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await pair.idle();
    for (const sync of syncs) await sync.idle();
  }
}

/** keyvalue all() returns [{ key, value, hash }]; the sorted keys tell the story. */
const keysOf = async (db) => (await db.all()).map((entry) => entry.key).sort();

describe("Courier Sync — OrbitDB replication over a byte courier, no libp2p", () => {
  let alice;
  let bob;
  const openedDbs = [];
  const track = (db) => {
    if (db) openedDbs.push(db);
    return db;
  };

  beforeAll(async () => {
    alice = await createHeliaOrbitDB("-courier-alice", OFFLINE);
    bob = await createHeliaOrbitDB("-courier-bob", OFFLINE);
  });

  afterAll(async () => {
    for (const db of openedDbs) {
      try {
        await db.close();
      } catch {
        // already closed is fine
      }
    }
    for (const node of [alice, bob]) {
      if (!node) continue;
      try {
        await node.orbitdb.stop();
        await node.helia.stop();
        await node.blockstore.close();
        await node.datastore.close();
      } catch {
        // best-effort teardown
      }
    }
    await cleanupOrbitDBDirectories();
  });

  test("first contact: a fresh peer bootstraps a database it has never seen", async () => {
    const db = track(
      await alice.orbitdb.open("courier-first-contact", { type: "keyvalue" }),
    );
    await db.put("one", { text: "Buy groceries" });
    await db.put("two", { text: "Walk the dog" });
    await db.put("three", { text: "Finish the data plane" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(syncB.db.address).toBe(db.address);
    expect(await syncB.db.get("one")).toEqual({ text: "Buy groceries" });
    expect(await keysOf(syncB.db)).toEqual(["one", "three", "two"]);

    // The claim behind the whole design, asserted:
    expect(alice.libp2p.getConnections().length).toBe(0);
    expect(bob.libp2p.getConnections().length).toBe(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("live update: a new entry crosses the courier and fires 'update'", async () => {
    const db = track(
      await alice.orbitdb.open("courier-live", { type: "keyvalue" }),
    );
    await db.put("seed", { text: "hello" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    const updates = [];
    track(syncB.db).events.on("update", (entry) => updates.push(entry));

    await db.put("later", { text: "added after bootstrap" });
    await converge(pair, [syncA, syncB]);

    expect(await syncB.db.get("later")).toEqual({
      text: "added after bootstrap",
    });
    expect(updates.length).toBeGreaterThan(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("divergence: both sides write while unplugged, then merge to equal heads", async () => {
    const db = track(
      await alice.orbitdb.open("courier-diverge", {
        type: "keyvalue",
        AccessController: IPFSAccessController({
          write: [alice.orbitdb.identity.id, bob.orbitdb.identity.id],
        }),
      }),
    );
    await db.put("base", { by: "alice" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);
    const bobDb = track(syncB.db);
    expect(bobDb).toBeTruthy();

    // Unplug — write on both sides while no courier runs.
    await syncA.stop();
    await syncB.stop();
    await db.put("a1", { by: "alice" });
    await db.put("a2", { by: "alice" });
    await bobDb.put("b1", { by: "bob" });
    await bobDb.put("b2", { by: "bob" });

    // Replug.
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(db)).toEqual(["a1", "a2", "b1", "b2", "base"]);
    expect(await keysOf(bobDb)).toEqual(["a1", "a2", "b1", "b2", "base"]);

    const aliceHeads = (await db.log.heads()).map((e) => e.hash).sort();
    const bobHeads = (await bobDb.log.heads()).map((e) => e.hash).sort();
    expect(aliceHeads).toEqual(bobHeads);

    await syncA.stop();
    await syncB.stop();
  });

  test("duplicate delivery: every message arrives twice, convergence is exact", async () => {
    const db = track(
      await alice.orbitdb.open("courier-duplicates", { type: "keyvalue" }),
    );
    await db.put("only", { text: "once, please" });

    const pair = createMemoryCourierPair({ duplicateFn: () => true });
    const errors = [];
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    syncA.on("error", (e) => errors.push(e));
    syncB.on("error", (e) => errors.push(e));

    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(track(syncB.db))).toEqual(["only"]);
    expect((await syncB.db.log.values()).length).toBe(1);
    expect(errors).toEqual([]);
    expect(pair.stats.duplicated).toBeGreaterThan(0);

    await syncA.stop();
    await syncB.stop();
  });

  test("reordering: LIFO delivery of every batch still converges", async () => {
    const db = track(
      await alice.orbitdb.open("courier-reorder", { type: "keyvalue" }),
    );
    await db.put("r1", { n: 1 });
    await db.put("r2", { n: 2 });
    await db.put("r3", { n: 3 });

    const pair = createMemoryCourierPair({ order: "lifo" });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    await db.put("r4", { n: 4 });
    await converge(pair, [syncA, syncB]);

    expect(await keysOf(track(syncB.db))).toEqual(["r1", "r2", "r3", "r4"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("loss and recovery: a dropped delta is healed by a poke", async () => {
    const db = track(
      await alice.orbitdb.open("courier-loss", { type: "keyvalue" }),
    );
    await db.put("l1", { text: "will get lost in transit, once" });

    // Blockade every delta-sized message; small control messages pass. This
    // models a mesh that keeps losing the long fragmented transmissions.
    let blockade = true;
    let dropped = 0;
    const pair = createMemoryCourierPair({
      dropFn: ({ bytes }) => {
        if (blockade && bytes.length > 500) {
          dropped++;
          return true;
        }
        return false;
      },
    });

    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect(dropped).toBeGreaterThan(0);
    expect(syncB.db).toBeNull(); // the bootstrap really was lost

    // The channel clears; recovery is one poke — the re-announce a real
    // courier would schedule.
    blockade = false;
    await syncB.announce();
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(await keysOf(syncB.db)).toEqual(["l1"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("a stranger can carry and read, but not write", async () => {
    // Access controller admits only alice.
    const db = track(
      await alice.orbitdb.open("courier-acl", { type: "keyvalue" }),
    );
    await db.put("owned", { by: "alice" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    // Read replication works…
    expect(await syncB.db.get("owned")).toEqual({ by: "alice" });
    track(syncB.db);
    // …the write stays gated by the access controller.
    await expect(syncB.db.put("mine", { by: "bob" })).rejects.toThrow(
      /not allowed/i,
    );

    await converge(pair, [syncA, syncB]);
    expect(await keysOf(db)).toEqual(["owned"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("messages for another database are ignored (address tag)", async () => {
    const tagA = await databaseTag("/orbitdb/zdpuSomewhere");
    const tagB = await databaseTag("/orbitdb/zdpuElsewhere");
    expect(Buffer.from(tagA).equals(Buffer.from(tagB))).toBe(false);

    const db = track(
      await alice.orbitdb.open("courier-tag", { type: "keyvalue" }),
    );
    await db.put("t1", { text: "tagged" });

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    await syncA.start();

    // A foreign sync on the same courier, bound to a different address, must
    // neither crash nor bootstrap from alice's messages.
    const foreign = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: "/orbitdb/zdpuAvFRosgkKTKzZKiennHqxpZC9ycEcqCsBEwmXNP3hbGvA",
      courier: pair.b,
    });
    const errors = [];
    foreign.on("error", (e) => errors.push(e));
    await foreign.start();
    await converge(pair, [syncA, foreign]);

    expect(foreign.db).toBeNull();
    expect(errors).toEqual([]);

    await syncA.stop();
    await foreign.stop();
  });

  test("a large first-contact bootstrap compresses on the wire and still converges", async () => {
    const db = track(
      await alice.orbitdb.open("courier-compress", { type: "keyvalue" }),
    );
    for (let i = 0; i < 25; i++) {
      await db.put(`k${i}`, {
        text: `entry number ${i} — some repetitive filler that deflates well`,
      });
    }

    // What the bootstrap would weigh uncompressed.
    const delta = await createDelta({ db, theirHeads: [] });
    const tagBytes = await databaseTag(db.address);
    const rawLen = dagCbor.encode({
      v: 1,
      tag: tagBytes,
      t: "blocks",
      heads: delta.heads,
      blocks: delta.blocks,
    }).length;

    const pair = createMemoryCourierPair();
    const syncA = await createCourierSync({ db, courier: pair.a });
    let blocksWire = 0;
    syncA.on("message", (m) => {
      if (m.direction === "out" && m.type === "blocks")
        blocksWire = Math.max(blocksWire, m.bytes);
    });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
    });
    await syncA.start();
    await syncB.start();
    await converge(pair, [syncA, syncB]);

    expect((await keysOf(track(syncB.db))).length).toBe(25);
    expect(rawLen).toBeGreaterThan(GZIP_THRESHOLD_FOR_TEST);
    expect(blocksWire).toBeGreaterThan(0);
    expect(blocksWire).toBeLessThan(rawLen); // compression shrank it on the wire

    await syncA.stop();
    await syncB.stop();
  });

  test("a joiner re-wants on its own until the bootstrap arrives (no manual poke)", async () => {
    const db = track(
      await alice.orbitdb.open("courier-rejoin", { type: "keyvalue" }),
    );
    await db.put("r1", { text: "will be dropped on the first pass" });

    // Drop the first blocks payload wholesale; let everything after through.
    let blockade = true;
    const pair = createMemoryCourierPair({
      dropFn: ({ bytes }) => {
        if (blockade && bytes.length > 200) {
          blockade = false; // only the first big one
          return true;
        }
        return false;
      },
    });
    const syncA = await createCourierSync({ db, courier: pair.a });
    const syncB = await createCourierSync({
      orbitdb: bob.orbitdb,
      address: db.address,
      courier: pair.b,
      rejoinIntervalMs: 40, // re-ask quickly for the test
    });
    await syncA.start();
    await syncB.start();

    // The first bootstrap was lost. Without touching syncB, the periodic
    // re-want must recover it. Give the interval room to fire, then converge.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await converge(pair, [syncA, syncB]);

    expect(track(syncB.db)).toBeTruthy();
    expect(await keysOf(syncB.db)).toEqual(["r1"]);

    await syncA.stop();
    await syncB.stop();
  });

  test("createDelta/applyDelta round-trip carries exactly the missing suffix", async () => {
    const db = track(
      await alice.orbitdb.open("courier-delta-math", { type: "keyvalue" }),
    );
    await db.put("d1", { n: 1 });
    const midHeads = (await db.log.heads()).map((e) => e.hash);
    await db.put("d2", { n: 2 });
    await db.put("d3", { n: 3 });

    const full = await createDelta({ db, theirHeads: [] });
    const suffix = await createDelta({ db, theirHeads: midHeads });

    // The suffix knows nothing of manifest or d1's block.
    expect(suffix.blocks.length).toBeLessThan(full.blocks.length);
    const suffixHashes = suffix.blocks.map((b) => b.hash);
    expect(suffixHashes).not.toContain(midHeads[0]);

    // An incomplete delta is refused before any join, with the gap named.
    // Bob gets only the static blocks (manifest, access controller, identity)
    // so the address opens; the entry chain then arrives with a hole in it.
    const { CID } = await import("multiformats/cid");
    const { base58btc } = await import("multiformats/bases/base58");
    const dagCbor = await import("@ipld/dag-cbor");
    const isEntry = (bytes) => {
      const value = dagCbor.decode(bytes);
      return Boolean(value && value.sig && value.payload !== undefined);
    };
    for (const block of full.blocks) {
      if (!isEntry(block.bytes)) {
        await bob.orbitdb.ipfs.blockstore.put(
          CID.parse(block.hash, base58btc),
          block.bytes,
        );
      }
    }
    const freshTarget = track(
      await bob.orbitdb.open(db.address, { sync: false }),
    );
    const headOnly = {
      heads: suffix.heads,
      blocks: suffix.blocks.filter((b) => isEntry(b.bytes)).slice(-1),
    };
    const refused = await applyDelta({ db: freshTarget, delta: headOnly });
    expect(refused.complete).toBe(false);
    expect(refused.joined).toBe(0);
    expect(refused.missing.length).toBeGreaterThan(0);
  });
});
