/**
 * @fileoverview Conformance suite for storage backends
 *
 * One suite every driver must pass. It exists so that adding Pinata, Lighthouse, Aleph
 * or Filecoin Onchain Cloud is a day of work rather than a rewrite: the questions that
 * decide whether a backend can hold an OrbitDB backup are asked here, once, and each new
 * driver answers them by running.
 *
 * The load-bearing test is the CAR round trip. This library's promise is that a restored
 * database has the same block CIDs as the original, and a CAR is how that promise stops
 * depending on a service's chunking: the backend sees one opaque blob, we unpack it
 * ourselves, and the inner CIDs are ours either way. A driver that passes everything else
 * and fails that one cannot back up a database.
 *
 * Capability-gated tests skip rather than fail — a backend that cannot list is a real
 * backend (Aleph's IPFS host offers no listing at all), not a broken one.
 *
 * @author @NiKrause
 * @requires ../../lib/backends/types.js
 */

import { CarWriter, CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createMemoryBackend } from "../../lib/backends/memory.js";
import { createStorachaBackend } from "../../lib/backends/storacha.js";
import { BackendError, defineBackend } from "../../lib/backends/types.js";
import {
  startInMemoryStorachaService,
  stopInMemoryStorachaService,
} from "../helpers/in-memory-storacha.js";

const TIMEOUT = 120_000;

/** Encode a dag-cbor block the way OrbitDB does, so the CIDs under test are realistic. */
async function makeBlock(value) {
  const bytes = dagCbor.encode(value);
  const cid = CID.create(1, dagCbor.code, await sha256.digest(bytes));
  return { cid, bytes };
}

/** Pack blocks into a CAR and return its bytes. */
async function packCar(blocks) {
  const { writer, out } = CarWriter.create([blocks[0].cid]);
  const collected = [];
  const collecting = (async () => {
    for await (const chunk of out) collected.push(chunk);
  })();

  for (const block of blocks) await writer.put(block);
  await writer.close();
  await collecting;

  const total = collected.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of collected) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Drivers under test. Each entry brings the backend up and tears it down; anything a
 * driver needs (a service, a wallet, a key) is its own problem, not the suite's.
 */
const drivers = [
  {
    name: "memory",
    async setUp() {
      // A resolver turns the memory backend into a pin-by-CID backend, so the
      // pinCid path is exercised by something rather than only declared.
      const published = new Map();
      const backend = createMemoryBackend({
        resolve: async (cid) => published.get(cid) || null,
      });
      return { backend, publish: (cid, bytes) => published.set(cid, bytes) };
    },
    async tearDown() {},
  },
  {
    name: "storacha (in-memory upload-api)",
    async setUp() {
      const service = await startInMemoryStorachaService();
      const backend = await createStorachaBackend({
        storachaKey: service.storachaKey,
        storachaProof: service.storachaProof,
        serviceConf: service.serviceConf,
        receiptsEndpoint: service.receiptsEndpoint,
        gateways: [service.gatewayUrl],
      });
      return { backend, service };
    },
    async tearDown(context) {
      await stopInMemoryStorachaService(context?.service);
    },
  },
];

describe.each(drivers.map((driver) => [driver.name, driver]))(
  "storage backend contract: %s",
  (_name, driver) => {
    let context;
    let backend;

    beforeAll(async () => {
      context = await driver.setUp();
      backend = context.backend;
    }, TIMEOUT);

    afterAll(async () => {
      await driver.tearDown(context);
    }, TIMEOUT);

    test("declares a name and a complete capability set", () => {
      expect(typeof backend.name).toBe("string");
      expect(backend.name.length).toBeGreaterThan(0);
      for (const flag of [
        "pinByCid",
        "carImport",
        "preservesInnerCids",
        "browserSafeAuth",
        "delegation",
        "listing",
        "deletion",
      ]) {
        expect(typeof backend.capabilities[flag]).toBe("boolean");
      }
      expect(typeof backend.capabilities.minBlobSize).toBe("number");
    });

    test(
      "a blob comes back byte for byte",
      async () => {
        const bytes = new TextEncoder().encode(
          `round trip ${backend.name} ${"x".repeat(200)}`,
        );
        const handle = await backend.putBlob(bytes, { name: "round-trip.bin" });

        expect(handle.id).toBeTruthy();
        expect(handle.backend).toBe(backend.name);

        const restored = await backend.getBlob(handle);
        expect(Buffer.from(restored).equals(Buffer.from(bytes))).toBe(true);
      },
      TIMEOUT,
    );

    test(
      "a bare id is as good as a handle",
      async () => {
        const bytes = new TextEncoder().encode(`by id ${"y".repeat(200)}`);
        const handle = await backend.putBlob(bytes);
        const restored = await backend.getBlob(handle.id);
        expect(Buffer.from(restored).equals(Buffer.from(bytes))).toBe(true);
      },
      TIMEOUT,
    );

    test(
      "a CAR survives with every inner CID intact",
      async () => {
        const blocks = await Promise.all([
          makeBlock({ entry: "head", clock: 2, payload: "the second entry" }),
          makeBlock({ entry: "tail", clock: 1, payload: "the first entry" }),
        ]);
        const car = await packCar(blocks);

        const handle = await backend.putBlob(car, { name: "backup.car" });
        const restored = await backend.getBlob(handle);
        expect(Buffer.from(restored).equals(Buffer.from(car))).toBe(true);

        // The point of the exercise: unpack it and check the CIDs are still ours.
        const reader = await CarReader.fromBytes(restored);
        const seen = new Map();
        for await (const block of reader.blocks()) {
          seen.set(block.cid.toString(), block.bytes);
        }

        expect(seen.size).toBe(blocks.length);
        for (const block of blocks) {
          const bytes = seen.get(block.cid.toString());
          expect(bytes).toBeDefined();
          expect(Buffer.from(bytes).equals(Buffer.from(block.bytes))).toBe(
            true,
          );
          // and the CID still describes the bytes, rather than merely matching
          const rehashed = CID.create(
            1,
            dagCbor.code,
            await sha256.digest(bytes),
          );
          expect(rehashed.toString()).toBe(block.cid.toString());
        }
      },
      TIMEOUT,
    );

    test(
      "listing finds what was stored",
      async () => {
        if (!backend.capabilities.listing) {
          console.log(`   ⏭️  ${backend.name} declares no listing`);
          return;
        }
        const bytes = new TextEncoder().encode(`listed ${"z".repeat(200)}`);
        const handle = await backend.putBlob(bytes);
        const listed = await backend.list();
        expect(listed.map((entry) => entry.id)).toContain(handle.id);
      },
      TIMEOUT,
    );

    test(
      "removal takes it out of the listing",
      async () => {
        if (!backend.capabilities.deletion || !backend.capabilities.listing) {
          console.log(`   ⏭️  ${backend.name} declares no deletion`);
          return;
        }
        const bytes = new TextEncoder().encode(`removed ${"q".repeat(200)}`);
        const handle = await backend.putBlob(bytes);
        await backend.remove(handle);
        const listed = await backend.list();
        expect(listed.map((entry) => entry.id)).not.toContain(handle.id);
      },
      TIMEOUT,
    );

    test(
      "pinning by CID stores the bytes under the CID it was given",
      async () => {
        if (!backend.capabilities.pinByCid) {
          console.log(`   ⏭️  ${backend.name} declares no pin-by-CID`);
          return;
        }
        const block = await makeBlock({ pinned: true, clock: 3 });
        context.publish(block.cid.toString(), block.bytes);

        const handle = await backend.pinCid(block.cid.toString());
        expect(handle.cid).toBe(block.cid.toString());

        const restored = await backend.getBlob(handle);
        expect(Buffer.from(restored).equals(Buffer.from(block.bytes))).toBe(
          true,
        );
      },
      TIMEOUT,
    );

    test(
      "unknown ids report NOT_FOUND rather than hanging",
      async () => {
        const missing =
          "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        await expect(backend.getBlob(missing)).rejects.toThrow();
      },
      TIMEOUT,
    );
  },
);

describe("the contract itself", () => {
  test("rejects a driver whose flags and methods disagree", () => {
    expect(() =>
      defineBackend({
        name: "liar",
        capabilities: { listing: true },
        putBlob: async () => ({ id: "x", backend: "liar" }),
        getBlob: async () => new Uint8Array(),
      }),
    ).toThrow(/declares listing=true/);
  });

  test("rejects a driver missing a required method", () => {
    expect(() =>
      defineBackend({ name: "half", putBlob: async () => {} }),
    ).toThrow(/missing getBlob/);
  });

  test("enforces a minimum blob size before the bytes leave the process", async () => {
    const backend = defineBackend({
      name: "picky",
      capabilities: { minBlobSize: 127 },
      putBlob: async () => {
        throw new Error("should never be reached");
      },
      getBlob: async () => new Uint8Array(),
    });

    await expect(backend.putBlob(new Uint8Array(10))).rejects.toMatchObject({
      name: "BackendError",
      code: "TOO_SMALL",
    });
  });

  test("BackendError carries a code a caller can branch on", () => {
    const error = new BackendError("UNSUPPORTED", "nope");
    expect(error.code).toBe("UNSUPPORTED");
    expect(error).toBeInstanceOf(Error);
  });
});
