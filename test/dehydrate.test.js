/**
 * @fileoverview Put a database where a second device can find it, and get it
 * back — with nothing between the two but a secret both can produce.
 *
 * P11 steps 3 and 4 (funkpost#93). The passkey is the application's half and
 * is not here: what arrives is a seed, and what the seed buys is a *name*. The
 * storage is a memory backend and the routing endpoint is a few lines of
 * `node:http` in this file, so the suite needs no network and no account.
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
import { createServer } from "node:http";

import { dehydrate, hydrate } from "../lib/dehydrate.js";
import {
  derivePointerKey,
  pointerName,
  resolvePointer,
} from "../lib/pointer-ipns.js";
import { createMemoryBackend } from "../lib/backends/memory.js";
import { createHeliaOrbitDB, cleanupOrbitDBDirectories } from "../lib/utils.js";

jest.setTimeout(180_000);

const TIMEOUT = 120_000;
const OFFLINE = { useBootstrap: false, useDHT: false, autoDial: false };
const TODOS = ["buy milk", "fix the antenna", "answer the salon"];
// What a passkey would hand over. Here it is a constant, because what is under
// test is what the seed buys, not where it comes from.
const SEED = new TextEncoder().encode("the same secret on both devices, 32 b");

let alice;
let bob;
let routing;
let backend;

/** A routing endpoint of our own. */
function startRouting() {
  const records = new Map();
  const server = createServer((request, response) => {
    const name = request.url.split("/").pop();
    if (request.method === "PUT") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        records.set(name, Buffer.concat(chunks));
        response.writeHead(200).end();
      });
      return;
    }
    const record = records.get(name);
    if (!record) {
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/vnd.ipfs.ipns-record" })
      .end(record);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        endpoints: [`http://127.0.0.1:${server.address().port}`],
        records,
        stop: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

beforeAll(async () => {
  alice = await createHeliaOrbitDB("-dehydrate-alice", OFFLINE);
  bob = await createHeliaOrbitDB("-dehydrate-bob", OFFLINE);
  routing = await startRouting();
  backend = createMemoryBackend();
}, TIMEOUT);

afterAll(async () => {
  await routing?.stop();
  for (const side of [alice, bob]) {
    await side?.orbitdb?.stop?.();
    await side?.helia?.stop?.();
  }
  await cleanupOrbitDBDirectories();
}, TIMEOUT);

/** A database with something in it, on the device that still has it. */
async function aDatabase(name) {
  const db = await alice.orbitdb.open(name, {
    type: "events",
    AccessController: IPFSAccessController({ write: ["*"] }),
  });
  for (const todo of TODOS) await db.add(todo);
  return db;
}

/** What the second device passes: the storage it can reach, and nothing else. */
const fromBackend = { restore: { fetchBytes: (id) => backend.getBlob(id) } };

describe("dehydrate and hydrate — a database found by a name nobody wrote down", () => {
  test(
    "the second device needs the seed, and nothing else at all",
    async () => {
      const db = await aDatabase("dehydrate-round-trip");

      const put = await dehydrate({
        orbitdb: alice.orbitdb,
        address: db.address,
        seed: SEED,
        label: "round-trip",
        backend,
        endpoints: routing.endpoints,
      });
      expect(put.metadataCID).toBeTruthy();
      expect(put.blocks).toBeGreaterThan(0);

      // Bob has never seen this database: no address, no CID, no file.
      const got = await hydrate({
        orbitdb: bob.orbitdb,
        seed: SEED,
        label: "round-trip",
        endpoints: routing.endpoints,
        open: { sync: false },
        ...fromBackend,
      });

      expect(got.address).toBe(db.address);
      expect(got.name).toBe(put.name);
      const entries = (await got.db.all()).map((entry) => entry.value);
      expect(entries).toEqual(expect.arrayContaining(TODOS));

      await got.db.close();
      await db.close();
    },
    TIMEOUT,
  );

  test(
    "a label keeps two databases of one seed apart",
    async () => {
      const shopping = await aDatabase("dehydrate-shopping");
      const antenna = await aDatabase("dehydrate-antenna");
      await antenna.add("one more for the antenna list");

      const first = await dehydrate({
        orbitdb: alice.orbitdb,
        address: shopping.address,
        seed: SEED,
        label: "shopping",
        backend,
        endpoints: routing.endpoints,
      });
      const second = await dehydrate({
        orbitdb: alice.orbitdb,
        address: antenna.address,
        seed: SEED,
        label: "antenna",
        backend,
        endpoints: routing.endpoints,
      });
      expect(first.name).not.toBe(second.name);

      const got = await hydrate({
        orbitdb: bob.orbitdb,
        seed: SEED,
        label: "antenna",
        endpoints: routing.endpoints,
        open: { sync: false },
        ...fromBackend,
      });

      expect(got.address).toBe(antenna.address);
      await got.db.close();
      await shopping.close();
      await antenna.close();
    },
    TIMEOUT,
  );

  test(
    "another seed finds nothing, rather than somebody else's list",
    async () => {
      const db = await aDatabase("dehydrate-private");
      await dehydrate({
        orbitdb: alice.orbitdb,
        address: db.address,
        seed: SEED,
        label: "private",
        backend,
        endpoints: routing.endpoints,
      });

      await expect(
        hydrate({
          orbitdb: bob.orbitdb,
          seed: new TextEncoder().encode("a stranger's key, not this one"),
          label: "private",
          endpoints: routing.endpoints,
          open: { sync: false },
          ...fromBackend,
        }),
      ).rejects.toThrow(/no endpoint had a valid pointer/);

      await db.close();
    },
    TIMEOUT,
  );

  test(
    "dehydrating again moves the pointer to the newer backup",
    async () => {
      const db = await aDatabase("dehydrate-again");
      const first = await dehydrate({
        orbitdb: alice.orbitdb,
        address: db.address,
        seed: SEED,
        label: "again",
        backend,
        endpoints: routing.endpoints,
        sequence: 1n,
      });

      await db.add("written after the first backup");
      const second = await dehydrate({
        orbitdb: alice.orbitdb,
        address: db.address,
        seed: SEED,
        label: "again",
        backend,
        endpoints: routing.endpoints,
        sequence: 2n,
      });
      expect(second.metadataCID).not.toBe(first.metadataCID);

      const key = await derivePointerKey(SEED, { label: "again" });
      const pointer = await resolvePointer({
        privateKey: key,
        endpoints: routing.endpoints,
      });
      expect(pointer.name).toBe(pointerName(key));
      expect(pointer.cid).toBe(second.metadataCID);

      await db.close();
    },
    TIMEOUT,
  );
});
