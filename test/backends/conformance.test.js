/**
 * @fileoverview One suite every storage driver must pass.
 *
 * This is the artefact that makes the later phases of #54 cheap. Adding a
 * backend should be *one entry in `DRIVERS`* and then reading the failures —
 * not writing a new set of tests and hoping they cover the same ground as the
 * last one.
 *
 * The suite is table-driven against the driver's own declared
 * `capabilities`, which is what lets one file serve backends that genuinely
 * differ: an archive that cannot delete is not failing, it is a different kind
 * of backend, and the suite holds it to what it *said* rather than to what
 * Storacha happened to do.
 *
 * The last test is the one that matters. Everything above it checks that bytes
 * survive; that one checks that a **database** survives — written on one node,
 * stored through the driver, and read back on a second node that has never seen
 * it, with every block verified against its own CID on the way in. That is the
 * library's actual job, and a driver that passes the byte tests and fails this
 * one is not usable.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { createMemoryBackend } from "../../lib/backends/memory.js";
import { checkBackend, UnsupportedOperationError } from "../../lib/backends/types.js";
import { restoreFromCID } from "../../lib/restore-cid.js";
// Library code, not vendor code — but the import path still runs through the
// Storacha module, which is one more argument for the extraction this phase is
// about. When the driver moves, this import gets shorter.
import { createCARFromBlocks } from "../../lib/backup-car.js";
import { extractDatabaseBlocks } from "../../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../../lib/utils.js";

jest.setTimeout(180000);

const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const TODOS = ["buy milk", "fix the antenna", "answer the salon"];

/**
 * Every driver to hold to the contract.
 *
 * The second entry is not a duplicate: a backend that declares no listing and
 * no deletion is a real shape — a permanent archive — and the suite has to
 * treat its refusals as correct behaviour rather than as failures.
 */
const DRIVERS = [
  {
    name: "memory",
    create: async () => createMemoryBackend(),
  },
  {
    name: "memory, as a permanent archive",
    create: async () => createMemoryBackend({ listing: false, deletion: false }),
  },
];

let alice;
let bob;

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-conformance-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-conformance-bob", OFFLINE);
});

afterAll(async () => {
  for (const side of [alice, bob]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
});

/** A database with something in it, and the CAR that carries it. */
async function aBackedUpDatabase(orbitdb, name) {
  const db = await orbitdb.open(name, {
    type: "events",
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  for (const todo of TODOS) await db.add(todo);

  const { blocks, manifestCID } = await extractDatabaseBlocks(db);
  const carBytes = await createCARFromBlocks(blocks, manifestCID);
  const entries = await db.log.values();
  return { db, carBytes, manifestCID, blocks, entryCount: entries.length };
}

for (const driver of DRIVERS) {
  describe(`storage backend conformance: ${driver.name}`, () => {
    /** @type {import("../../lib/backends/types.js").StorageBackend} */
    let backend;

    beforeAll(async () => {
      backend = await driver.create();
    });

    test("is shaped like a backend, and says what it can do", () => {
      expect(checkBackend(backend)).toEqual([]);
    });

    test("bytes come back exactly as they went in", async () => {
      const bytes = new Uint8Array(1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;

      const handle = await backend.putBlob(bytes, { name: "pattern.bin" });
      expect(typeof handle.id).toBe("string");
      expect(handle.id.length).toBeGreaterThan(0);

      const back = await backend.getBlob(handle);
      expect(back).toEqual(bytes);

      // And by id alone, because that is all a metadata record will carry.
      expect(await backend.getBlob(handle.id)).toEqual(bytes);
    });

    test("an empty blob is a blob", async () => {
      // The degenerate case that backends with a minimum piece size fail, and
      // that nobody writes a test for until one of them does.
      const handle = await backend.putBlob(new Uint8Array(0));
      expect(await backend.getBlob(handle)).toEqual(new Uint8Array(0));
    });

    test("a handle that was never issued is an error, not empty bytes", async () => {
      await expect(backend.getBlob("nothing-was-ever-stored-here")).rejects.toThrow();
    });

    test("what it does not have, it refuses by name", async () => {
      const caps = backend.capabilities;

      if (!caps.listing) {
        await expect(backend.list()).rejects.toThrow(UnsupportedOperationError);
      } else {
        const handle = await backend.putBlob(new TextEncoder().encode("listed"));
        const all = await backend.list();
        expect(all.map((entry) => entry.id)).toContain(handle.id);
      }

      if (!caps.deletion) {
        await expect(backend.remove("anything")).rejects.toThrow(UnsupportedOperationError);
      } else {
        const handle = await backend.putBlob(new TextEncoder().encode("temporary"));
        expect(await backend.remove(handle)).toBe(true);
        // Removing what is gone is an answer, not a failure.
        expect(await backend.remove(handle)).toBe(false);
        await expect(backend.getBlob(handle)).rejects.toThrow();
      }

      // The capability and the surface have to agree, or calling code reaches
      // for a function that is not there.
      expect(typeof backend.pinCid === "function").toBe(caps.pinByCid);
    });

    test("a CAR survives, block for block", async () => {
      if (!backend.capabilities.preservesInnerCids) return; // honestly declared

      const { db, carBytes, blocks } = await aBackedUpDatabase(
        alice.orbitdb,
        `conformance-car-${backend.name}-${DRIVERS.indexOf(driver)}`,
      );

      const handle = await backend.putBlob(carBytes, { contentType: "application/vnd.ipld.car" });
      const back = await backend.getBlob(handle);

      // Not `toEqual` on the CAR alone: identical bytes are necessary and the
      // blocks inside are what the claim is actually about.
      expect(back).toEqual(carBytes);
      const { readBlocksFromCAR } = await import("../../lib/restore-cid.js");
      const readBack = await readBlocksFromCAR(back); // verifies each block's CID
      expect(readBack.size).toBe(blocks.size);

      await db.close();
    });

    test("a database written here opens on a node that has never seen it", async () => {
      if (!backend.capabilities.preservesInnerCids) return;

      const { db, carBytes, manifestCID, entryCount } = await aBackedUpDatabase(
        alice.orbitdb,
        `conformance-restore-${backend.name}-${DRIVERS.indexOf(driver)}`,
      );

      const carHandle = await backend.putBlob(carBytes);
      const metadata = {
        version: "1.0",
        timestamp: Date.now(),
        // The metadata names the *handle*. For a CID-preserving backend those
        // are the same string; for one that is not, this is the field that
        // stops the difference from mattering.
        carCID: carHandle.id,
        manifestCID,
        totalBlocks: entryCount,
        databases: [{ address: db.address, name: db.name, type: db.type, manifestCID, entryCount }],
      };
      const metaHandle = await backend.putBlob(
        new TextEncoder().encode(JSON.stringify(metadata)),
      );

      // Bob holds nothing, and dials nobody: the bytes reach him through the
      // driver and only through the driver.
      expect(bob.libp2p.getConnections()).toHaveLength(0);

      const result = await restoreFromCID(bob.orbitdb, {
        metadataCID: metaHandle.id,
        fetchBytes: (id) => backend.getBlob(id),
      });

      expect(result.address).toBe(db.address);
      expect(result.joined).toBeGreaterThan(0);
      const restored = await result.database.all();
      expect(restored.map((entry) => entry.value).sort()).toEqual([...TODOS].sort());
      expect(bob.libp2p.getConnections()).toHaveLength(0);

      await db.close();
      await result.database.close();
    });
  });
}

describe("the suite has teeth", () => {
  // A conformance suite is worth exactly what it refuses. These drivers are
  // built to fail, and each one names the failure a real backend could have.

  test("a backend that re-chunks the bytes cannot claim preservesInnerCids", async () => {
    // The class-3 hazard from the evaluation: the service hashes the content
    // its own way, so what comes back is not what went in. One byte is enough,
    // and one byte is what a re-chunking backend would differ by at worst.
    const honest = createMemoryBackend();
    const liar = {
      ...honest,
      name: "liar",
      async getBlob(handle) {
        const bytes = await honest.getBlob(handle);
        bytes[bytes.length - 1] ^= 0x01;
        return bytes;
      },
    };

    const { db, carBytes } = await aBackedUpDatabase(alice.orbitdb, "conformance-teeth-car");
    const handle = await liar.putBlob(carBytes);
    const back = await liar.getBlob(handle);

    expect(back).not.toEqual(carBytes);
    const { readBlocksFromCAR } = await import("../../lib/restore-cid.js");
    // Either the CAR no longer parses, or a block no longer hashes to its name.
    // Both are the suite catching it; neither is silence.
    await expect(readBlocksFromCAR(back)).rejects.toThrow();

    await db.close();
  });

  test("a backend that loses a blob fails the restore rather than half-doing it", async () => {
    const honest = createMemoryBackend();
    const { db, carBytes, manifestCID, entryCount } = await aBackedUpDatabase(
      alice.orbitdb,
      "conformance-teeth-missing",
    );
    const carHandle = await honest.putBlob(carBytes);
    const metadata = {
      version: "1.0",
      timestamp: Date.now(),
      carCID: carHandle.id,
      manifestCID,
      databases: [{ address: db.address, name: db.name, type: db.type, manifestCID, entryCount }],
    };
    const metaHandle = await honest.putBlob(new TextEncoder().encode(JSON.stringify(metadata)));

    // The metadata survives and the CAR does not — a partial loss, which is
    // the shape a storage failure actually takes.
    await honest.remove(carHandle);

    await expect(
      restoreFromCID(bob.orbitdb, {
        metadataCID: metaHandle.id,
        fetchBytes: (id) => honest.getBlob(id),
      }),
    ).rejects.toThrow();

    await db.close();
  });
});

describe("the contract checker earns its keep", () => {
  test("an undeclared capability is reported, not defaulted", () => {
    const backend = createMemoryBackend();
    delete backend.capabilities.delegation;
    expect(checkBackend(backend)).toContain("capabilities.delegation is not declared");
  });

  test("claiming pinByCid without pinCid() is caught", () => {
    const backend = createMemoryBackend();
    backend.capabilities.pinByCid = true;
    expect(checkBackend(backend)).toContain("claims pinByCid but has no pinCid()");
  });

  test("and so is the other way round", () => {
    const backend = createMemoryBackend();
    backend.pinCid = async () => ({ id: "x" });
    expect(checkBackend(backend)).toContain("has pinCid() but does not claim pinByCid");
  });

  test("something that is not a backend at all", () => {
    expect(checkBackend(null)).toEqual(["not an object"]);
    expect(checkBackend({})).toContain("no putBlob()");
  });
});
