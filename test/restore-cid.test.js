/**
 * @fileoverview Restoring from a CID, with no Storacha client anywhere.
 *
 * The capability existed inside `restoreFromSpaceCAR`; what did not exist was
 * a way to reach it without importing `@storacha/client`, which cost a browser
 * consumer 617 kB gzipped for a path that needs about 11 (issue #58).
 *
 * These tests import only `../lib/restore-cid.js` for the thing under test, and
 * serve the bytes from a Map — so what they prove is precisely the claim:
 * **a CID, some bytes, and no account restores a database.** No space, no
 * proof, no key, no network.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { restoreFromCID, readBlocksFromCAR } from "../lib/restore-cid.js";
import { createCARFromBlocks } from "../lib/backup-car.js";
import { extractDatabaseBlocks } from "../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";
import { CID } from "multiformats/cid";
import { CarWriter } from "@ipld/car";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { Readable } from "stream";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const TODOS = ["buy milk", "fix the antenna", "answer the salon"];

let alice;
let bob;

/**
 * Everything a backup publishes, without publishing it: the CAR bytes and the
 * metadata JSON that names them. Mirrors what `backupDatabaseCAR` writes, which
 * is the contract `restoreFromCID` reads.
 */
async function backupLocally(database) {
  const { blocks, manifestCID } = await extractDatabaseBlocks(database);
  const carBytes = await createCARFromBlocks(blocks, manifestCID);
  const entries = await database.log.values();

  const carCID = "bafyTESTcar";
  const metadata = {
    version: "1.0",
    timestamp: Date.now(),
    databaseCount: 1,
    totalBlocks: blocks.size,
    totalEntries: entries.length,
    manifestCID,
    carCID,
    databases: [
      {
        address: database.address,
        name: database.name,
        type: database.type,
        manifestCID,
        entryCount: entries.length,
      },
    ],
  };

  const metadataCID = "bafyTESTmeta";
  const store = new Map([
    [metadataCID, new TextEncoder().encode(JSON.stringify(metadata))],
    [carCID, carBytes],
  ]);

  return {
    metadataCID,
    metadata,
    store,
    /** Stands in for a gateway; the shape `restoreFromCID` injects. */
    fetchBytes: async (cid) => {
      if (!store.has(cid)) throw new Error(`Could not fetch ${cid} from any gateway`);
      return store.get(cid);
    },
  };
}

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-restore-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-restore-bob", OFFLINE);
});

afterAll(async () => {
  for (const side of [alice, bob]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

describe("restoring from a CID without an account", () => {
  test("a peer that has never seen the database reads every entry", async () => {
    const db = await alice.orbitdb.open("restore-cid-todos", {
      type: "events",
      AccessController: IPFSAccessController({ write: ["*"] }),
    });
    for (const todo of TODOS) await db.add(todo);

    const backup = await backupLocally(db);

    // Bob holds nothing: a different OrbitDB, a different blockstore, and no
    // connection between them — the suite runs both nodes offline.
    expect(bob.libp2p.getConnections()).toHaveLength(0);

    const result = await restoreFromCID(bob.orbitdb, {
      metadataCID: backup.metadataCID,
      fetchBytes: backup.fetchBytes,
    });

    expect(result.address).toBe(db.address);
    expect(result.joined).toBeGreaterThan(0);

    const restored = await result.database.all();
    expect(restored.map((entry) => entry.value).sort()).toEqual([...TODOS].sort());

    // And still nothing was dialled — the bytes came from the injected fetch.
    expect(bob.libp2p.getConnections()).toHaveLength(0);

    await db.close();
    await result.database.close();
  });

  test("the CAR is the blocks, and reading it needs nothing else", async () => {
    const db = await alice.orbitdb.open("restore-cid-blocks", {
      type: "events",
      AccessController: IPFSAccessController({ write: ["*"] }),
    });
    await db.add("one");

    const { blocks, manifestCID } = await extractDatabaseBlocks(db);
    const carBytes = await createCARFromBlocks(blocks, manifestCID);

    const readBack = await readBlocksFromCAR(carBytes);
    expect(readBack.size).toBe(blocks.size);

    // The keys are not the same strings on both sides and that is not a bug:
    // OrbitDB addresses blocks in base58btc, a CAR in the CID's own base32. So
    // compare the CIDs, which is what `restoreFromCID` converts between.
    const asV1 = (s) => CID.parse(s).toV1().toString();
    expect([...readBack.keys()].map(asV1)).toContain(asV1(manifestCID));

    await db.close();
  });
});

describe("what it refuses, and how it says so", () => {
  test("a metadata CID that serves something else is not silently accepted", async () => {
    const fetchBytes = async () => new TextEncoder().encode("<!DOCTYPE html><h1>404</h1>");
    await expect(
      restoreFromCID(bob.orbitdb, { metadataCID: "bafyNOPE", fetchBytes }),
    ).rejects.toThrow(/not JSON/);
  });

  test("metadata that is JSON but not a backup is refused", async () => {
    const fetchBytes = async () => new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    await expect(
      restoreFromCID(bob.orbitdb, { metadataCID: "bafyNOPE", fetchBytes }),
    ).rejects.toThrow(/Invalid backup metadata/);
  });

  test("a pre-CAR backup says which kind it is, rather than failing later", async () => {
    const legacy = {
      version: "1.0",
      timestamp: Date.now(),
      databases: [{ root: "zdpu…", path: "some/path" }],
      carCID: "bafyTESTcar",
    };
    const fetchBytes = async () => new TextEncoder().encode(JSON.stringify(legacy));
    await expect(
      restoreFromCID(bob.orbitdb, { metadataCID: "bafyOLD", fetchBytes }),
    ).rejects.toThrow(/pre-CAR backup/);
  });

  test("the arguments it cannot work without are named", async () => {
    await expect(restoreFromCID(null, { metadataCID: "x" })).rejects.toThrow(/OrbitDB instance/);
    await expect(restoreFromCID(bob.orbitdb, {})).rejects.toThrow(/metadataCID is required/);
  });
});

/** A CAR carrying `bytes` under `cid`, whether or not they belong together. */
async function carWith(cid, bytes) {
  const { writer, out } = CarWriter.create([cid]);
  const chunks = [];
  const reader = Readable.from(out);
  reader.on("data", (chunk) => chunks.push(chunk));
  await writer.put({ cid, bytes });
  await writer.close();
  await new Promise((resolve) => reader.on("end", resolve));
  return new Uint8Array(Buffer.concat(chunks));
}

describe("a block is only as good as its own hash", () => {
  test("CarReader does not check this, which is why we do", async () => {
    const honest = await Block.encode({ value: { todo: "buy milk" }, codec: dagCbor, hasher: sha256 });
    const other = await Block.encode({ value: { todo: "DELETE EVERYTHING" }, codec: dagCbor, hasher: sha256 });

    // The forgery: one block's name over another block's bytes.
    const tampered = await carWith(honest.cid, other.bytes);

    await expect(readBlocksFromCAR(tampered)).rejects.toThrow(/does not hash to its own CID/);

    // And the reason the check has to be ours: without it, this is accepted.
    const waved = await readBlocksFromCAR(tampered, { verify: false });
    expect(waved.get(honest.cid.toString()).bytes).toEqual(other.bytes);
  });

  test("an honest CAR passes, so verification is not just a refusal", async () => {
    const block = await Block.encode({ value: { todo: "fix the antenna" }, codec: dagCbor, hasher: sha256 });
    const car = await carWith(block.cid, block.bytes);
    const blocks = await readBlocksFromCAR(car);
    expect(blocks.get(block.cid.toString()).bytes).toEqual(block.bytes);
  });

  test("blocks that verify individually are still not any backup you like", async () => {
    // Every block here is honest about itself. What makes this the wrong CAR is
    // that it does not hold the manifest the metadata names — which no amount
    // of per-block verification would catch.
    const block = await Block.encode({ value: { todo: "someone else's" }, codec: dagCbor, hasher: sha256 });
    const car = await carWith(block.cid, block.bytes);

    const metadata = {
      version: "1.0",
      timestamp: Date.now(),
      carCID: "bafyOTHERcar",
      manifestCID: "bafyMANIFESTthatIsNotInThere",
      databases: [
        {
          address: "/orbitdb/zdpuNotOurs",
          type: "events",
          manifestCID: "bafyMANIFESTthatIsNotInThere",
        },
      ],
    };
    const store = new Map([
      ["bafyMETA", new TextEncoder().encode(JSON.stringify(metadata))],
      ["bafyOTHERcar", car],
    ]);

    await expect(
      restoreFromCID(bob.orbitdb, {
        metadataCID: "bafyMETA",
        fetchBytes: async (cid) => store.get(cid),
      }),
    ).rejects.toThrow(/does not contain the manifest/);
  });
});
