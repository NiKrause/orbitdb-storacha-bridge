/**
 * @fileoverview A CAR by default, and the refusals that make it worth it.
 *
 * #54's 0.5.2. Before this, `backupDatabase` sent one OrbitDB block at a time
 * and the CAR path was reachable only by calling `backupDatabaseCAR` directly.
 * That default does not survive the backends we now expect: Filecoin Onchain
 * Cloud rejects anything under 127 bytes, and an OrbitDB block is routinely
 * smaller — so a per-block backup dies partway through with some blocks stored
 * and some not, which is the worst possible outcome because it looks like a
 * backup.
 *
 * A CAR is one opaque blob. Hash preservation is then structural rather than a
 * property we hope a vendor keeps, and there is one piece, not hundreds.
 *
 * The block path stays, because a backend that genuinely preserves what it is
 * given can still take it — and the tests below are mostly about the cases
 * where it cannot, since those are the ones that used to fail late.
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { IPFSAccessController } from "@orbitdb/core";
import { createMemoryBackend } from "../../lib/backends/memory.js";
import { backupDatabase } from "../../lib/orbitdb-storacha-bridge.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../../lib/utils.js";

jest.setTimeout(180_000);

const TIMEOUT = 120_000;
const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };

let node;

beforeAll(async () => {
  node = await createHeliaOrbitDB("-car-first", OFFLINE);
}, TIMEOUT);

afterAll(async () => {
  await node?.orbitdb?.stop?.();
  await node?.helia?.stop?.();
  await cleanupOrbitDBDirectories();
}, TIMEOUT);

let counter = 0;
async function aDatabase() {
  const db = await node.orbitdb.open(`car-first-${counter++}`, {
    type: "events",
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  await db.add("something worth keeping");
  return db;
}

/** A backend that counts what it was asked to store. */
function counting(capabilities = {}) {
  const inner = createMemoryBackend();
  let puts = 0;
  return {
    ...inner,
    capabilities: { ...inner.capabilities, ...capabilities },
    async putBlob(bytes, meta) {
      puts++;
      return inner.putBlob(bytes, meta);
    },
    get puts() {
      return puts;
    },
  };
}

describe("a backup is a CAR unless you ask otherwise", () => {
  test(
    "the default strategy",
    async () => {
      const db = await aDatabase();
      const backend = counting();

      const result = await backupDatabase(node.orbitdb, db.address, { backend });

      expect(result.success).toBe(true);
      expect(result.method).toBe("car-timestamped");
      // The CAR and the metadata that names it. Not one call per block.
      expect(backend.puts).toBe(2);
      expect(result.backupFiles?.metadataCID).toBeTruthy();

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "the block path is still reachable, and says which it was",
    async () => {
      const db = await aDatabase();
      const backend = counting();

      const result = await backupDatabase(node.orbitdb, db.address, {
        backend,
        strategy: "blocks",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("blocks");
      expect(result.cidMappings).toBeTruthy();
      // One per block, which is exactly the cost the default now avoids.
      expect(backend.puts).toBe(result.blocksTotal);

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "an unknown strategy is refused rather than guessed at",
    async () => {
      const db = await aDatabase();
      await expect(
        backupDatabase(node.orbitdb, db.address, { backend: counting(), strategy: "carr" }),
      ).rejects.toThrow(/Unknown backup strategy/);
      await db.close();
    },
    TIMEOUT,
  );
});

describe("a backend that cannot take blocks says so before any are sent", () => {
  // This is the whole point of the phase. Both of these used to be discovered
  // partway through an upload, with some blocks already stored.

  test(
    "a minimum piece size",
    async () => {
      const db = await aDatabase();
      const backend = counting({ minBlobSize: 127 }); // Filecoin Onchain Cloud

      const result = await backupDatabase(node.orbitdb, db.address, {
        backend,
        strategy: "blocks",
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe("TOO_SMALL");
      expect(result.error).toMatch(/127-byte minimum/);
      expect(backend.puts).toBe(0); // nothing half-stored

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "a backend that re-chunks what it is given",
    async () => {
      const db = await aDatabase();
      const backend = counting({ preservesInnerCids: false });

      const result = await backupDatabase(node.orbitdb, db.address, {
        backend,
        strategy: "blocks",
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe("UNSUPPORTED");
      expect(backend.puts).toBe(0);

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "and the same backend backs up fine as a CAR",
    async () => {
      // The refusal is about the strategy, not about the backend — otherwise
      // it would be telling people their storage is unusable when it is not.
      const db = await aDatabase();
      const backend = counting({ minBlobSize: 127 });

      const result = await backupDatabase(node.orbitdb, db.address, { backend });

      expect(result.success).toBe(true);
      expect(result.method).toBe("car-timestamped");

      await db.close();
    },
    TIMEOUT,
  );
});

describe("salvage mode is not a strategy", () => {
  test(
    "logEntriesOnly stays on the block path",
    async () => {
      // A CAR without its manifest is one `restoreFromCID` refuses — correctly,
      // since it could be anybody's log. So this mode cannot become a CAR, and
      // it does not silently get one.
      const db = await aDatabase();
      const backend = counting();

      const result = await backupDatabase(node.orbitdb, db.address, {
        backend,
        logEntriesOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("blocks");

      await db.close();
    },
    TIMEOUT,
  );
});
