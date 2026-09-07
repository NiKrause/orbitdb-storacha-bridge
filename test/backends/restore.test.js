/**
 * @fileoverview The other half of the contract: a database, not just its bytes.
 *
 * `conformance.test.js` proves a CAR survives a backend with its inner CIDs
 * intact — bytes and names, against synthetic blocks. That is the load-bearing
 * property and it is not the whole promise. What this library actually offers
 * is that a database written on one machine **opens on another that has never
 * seen it**, and a driver can pass every byte test while failing that.
 *
 * So this file runs a real OrbitDB through each driver in the same table, and
 * restores it on a second node holding zero libp2p connections before and
 * after — the bytes reach it through the backend and only through the backend.
 *
 * It also asserts that the suite refuses. `conformance.test.js` demonstrably
 * has teeth: it caught the memory driver's `pinCid` codec bug on its first run.
 * But nothing in it *asserts* that a bad driver fails, so a later refactor
 * could remove the teeth without turning anything red. The adversarial drivers
 * at the bottom are there to make that impossible.
 *
 * @requires ./conformance.test.js
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { drivers } from "./drivers.js";
import { createMemoryBackend } from "../../lib/backends/memory.js";
import { restoreFromCID, readBlocksFromCAR } from "../../lib/restore-cid.js";
import { createCARFromBlocks } from "../../lib/backup-car.js";
import { extractDatabaseBlocks } from "../../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../../lib/utils.js";

jest.setTimeout(180_000);

const TIMEOUT = 120_000;
const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const TODOS = ["buy milk", "fix the antenna", "answer the salon"];

let alice;
let bob;

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-backend-restore-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-backend-restore-bob", OFFLINE);
}, TIMEOUT);

afterAll(async () => {
  for (const side of [alice, bob]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
}, TIMEOUT);

/** A real database, and the CAR and metadata that describe it. */
async function backUp(orbitdb, name) {
  const db = await orbitdb.open(name, {
    type: "events",
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  for (const todo of TODOS) await db.add(todo);

  const { blocks, manifestCID } = await extractDatabaseBlocks(db);
  const carBytes = await createCARFromBlocks(blocks, manifestCID);
  const entryCount = (await db.log.values()).length;

  /** What the pointer record says, once the CAR has a handle. */
  const metadataFor = (carHandleId) => ({
    version: "1.0",
    timestamp: Date.now(),
    // The *handle*, not "the CID". They are the same string only for a backend
    // that preserves ours; this field is what keeps the difference from
    // mattering, and writing it as `carCID` is a name the format is stuck with.
    carCID: carHandleId,
    manifestCID,
    totalBlocks: blocks.size,
    databases: [{ address: db.address, name: db.name, type: db.type, manifestCID, entryCount }],
  });

  return { db, carBytes, manifestCID, blocks, metadataFor };
}

describe.each(drivers.map((driver) => [driver.name, driver]))(
  "a backend has to bring a database back: %s",
  (name, driver) => {
    let context;
    let backend;

    beforeAll(async () => {
      context = await driver.setUp();
      backend = context.backend;
    }, TIMEOUT);

    afterAll(async () => {
      await driver.tearDown(context);
    }, TIMEOUT);

    test(
      "a database written here opens on a node that has never seen it",
      async () => {
        const { db, carBytes, metadataFor } = await backUp(
          alice.orbitdb,
          `backend-restore-${name.replace(/\W+/g, "-")}`,
        );

        const carHandle = await backend.putBlob(carBytes, {
          contentType: "application/vnd.ipld.car",
        });
        const metaHandle = await backend.putBlob(
          new TextEncoder().encode(JSON.stringify(metadataFor(carHandle.id))),
        );

        expect(bob.libp2p.getConnections()).toHaveLength(0);

        const result = await restoreFromCID(bob.orbitdb, {
          metadataCID: metaHandle.id,
          // The backend *is* the transport. Nothing else can supply these bytes.
          fetchBytes: (id) => backend.getBlob(id),
        });

        expect(result.address).toBe(db.address);
        expect(result.joined).toBeGreaterThan(0);

        const restored = await result.database.all();
        expect(restored.map((entry) => entry.value).sort()).toEqual([...TODOS].sort());

        // Still nothing dialled: this was not quietly a p2p sync.
        expect(bob.libp2p.getConnections()).toHaveLength(0);

        await db.close();
        await result.database.close();
      },
      TIMEOUT,
    );
  },
);

describe("the suite refuses what it should", () => {
  // Each of these is a failure a real backend could have. If any of them ever
  // passes, the checks above have stopped checking.

  test(
    "a backend that alters the bytes cannot hide behind preservesInnerCids",
    async () => {
      // The class-3 hazard from the storage evaluation: the service hashes the
      // content its own way, so what comes back is not what went in. One byte
      // is the smallest possible version of that, and therefore the hardest.
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

      const { db, carBytes } = await backUp(alice.orbitdb, "backend-teeth-altered");
      const handle = await liar.putBlob(carBytes);
      const back = await liar.getBlob(handle);

      expect(back).not.toEqual(carBytes);
      // Either the CAR no longer parses or a block no longer hashes to its own
      // name. Both are the check working; silence would not be.
      await expect(readBlocksFromCAR(back)).rejects.toThrow();

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "a backend that loses the CAR fails the restore rather than half-doing it",
    async () => {
      const backend = createMemoryBackend();
      const { db, carBytes, metadataFor } = await backUp(alice.orbitdb, "backend-teeth-lost");

      const carHandle = await backend.putBlob(carBytes);
      const metaHandle = await backend.putBlob(
        new TextEncoder().encode(JSON.stringify(metadataFor(carHandle.id))),
      );

      // The pointer survives and the payload does not — which is the shape a
      // storage failure actually takes, and the one that would otherwise
      // produce an empty database that looks restored.
      await backend.remove(carHandle);

      await expect(
        restoreFromCID(bob.orbitdb, {
          metadataCID: metaHandle.id,
          fetchBytes: (id) => backend.getBlob(id),
        }),
      ).rejects.toThrow();

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "a backend serving somebody else's database is not a restore",
    async () => {
      // Every block honest about itself, and all of them from the wrong book.
      // No amount of per-block verification catches this; the manifest does.
      const backend = createMemoryBackend();
      const ours = await backUp(alice.orbitdb, "backend-teeth-ours");
      const theirs = await backUp(alice.orbitdb, "backend-teeth-theirs");

      const wrongCar = await backend.putBlob(theirs.carBytes);
      const metaHandle = await backend.putBlob(
        new TextEncoder().encode(JSON.stringify(ours.metadataFor(wrongCar.id))),
      );

      await expect(
        restoreFromCID(bob.orbitdb, {
          metadataCID: metaHandle.id,
          fetchBytes: (id) => backend.getBlob(id),
        }),
      ).rejects.toThrow(/does not contain the manifest/);

      await ours.db.close();
      await theirs.db.close();
    },
    TIMEOUT,
  );
});
