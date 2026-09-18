/**
 * Where a backup finds the identity that signed the entries.
 *
 * `Identities()` without `ipfs` keeps identities in memory, apart from the
 * blockstore the log reads — the browser example makes them that way. Asked for
 * such an identity, the log's storage finds nothing locally, and a Helia
 * blockstore searches the network until OrbitDB's 30-second timeout: the backup
 * waited half a minute and went up without the identity.
 */
import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { extractDatabaseBlocks } from "../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(120000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };

let node;

beforeAll(async () => {
  node = await createHeliaOrbitDB("-extract-identity", OFFLINE);
});

afterAll(async () => {
  await node?.orbitdb?.stop?.();
  await node?.helia?.stop?.();
  await cleanupOrbitDBDirectories();
});

async function encode(value) {
  const block = await Block.encode({ value, codec: dagCbor, hasher: sha256 });
  return { hash: block.cid.toString(base58btc), bytes: block.bytes };
}

describe("extractDatabaseBlocks and identities", () => {
  test("takes the writer's identity from the database, without asking the log's storage", async () => {
    const db = await node.orbitdb.open("extract-identity-own", {
      type: "events",
      AccessController: IPFSAccessController({ write: ["*"] }),
    });
    const storage = db.log.storage;
    try {
      await db.add("buy milk");
      await db.add("fix the antenna");
      const { identity } = db;

      // The log's storage as it is when the identity lives elsewhere.
      const asked = [];
      db.log.storage = {
        ...storage,
        get: async (hash) => {
          asked.push(hash);
          return hash === identity.hash ? undefined : storage.get(hash);
        },
      };

      const { blocks, blockSources } = await extractDatabaseBlocks(db);

      const block = blocks.get(identity.hash);
      expect(block).toBeDefined();
      const decoded = await Block.decode({ bytes: block.bytes, codec: dagCbor, hasher: sha256 });
      expect(decoded.cid.toString(base58btc)).toBe(identity.hash);
      expect(blockSources.get(identity.hash)).toBe("identity_own");
      expect(asked).not.toContain(identity.hash);
    } finally {
      db.log.storage = storage;
      await db.close();
    }
  });

  test("finds another writer's identity in the log's storage", async () => {
    const writer = await encode({
      id: "did:key:z6MkAnotherWriter",
      publicKey: "public-key",
      signatures: { id: "signature", publicKey: "signature" },
      type: "publickey",
    });
    const accessController = await encode({ type: "ipfs", write: ["*"] });
    const manifest = await encode({
      name: "shared",
      type: "events",
      accessController: `/ipfs/${accessController.hash}`,
    });
    const entry = await encode({ payload: { op: "ADD", value: "hello" }, identity: writer.hash });
    const stored = new Map(
      [entry, manifest, accessController, writer].map(({ hash, bytes }) => [hash, bytes]),
    );

    // Shaped like an OrbitDB 4 database this node opened but did not write.
    const db = {
      name: "shared",
      address: `/orbitdb/${manifest.hash}`,
      identity: node.orbitdb.identity,
      log: {
        identity: node.orbitdb.identity,
        values: async () => [{ hash: entry.hash, identity: writer.hash }],
        storage: {
          get: async (hash) => stored.get(hash),
          iterator: async function* () {},
        },
      },
    };

    const { blocks, blockSources } = await extractDatabaseBlocks(db);

    expect(blocks.get(writer.hash)?.bytes).toEqual(writer.bytes);
    expect(blockSources.get(writer.hash)).toBe("identity_direct");
  });
});
