/**
 * @fileoverview Every storage driver the suites hold to the contract.
 *
 * A plain module rather than part of a test file, so that a second suite can
 * iterate the same list without importing — and therefore re-running — the
 * first one. Adding a backend stays one entry, and it is then asked both
 * questions: does it keep bytes (`conformance.test.js`), and does it bring a
 * database back (`restore.test.js`).
 */

import { createMemoryBackend } from "../../lib/backends/memory.js";
import { createStorachaBackend } from "../../lib/backends/storacha.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import { createPinataBackend } from "../../lib/backends/pinata.js";
import { createLighthouseBackend } from "../../lib/backends/lighthouse.js";
import {
  startInMemoryStorachaService,
  stopInMemoryStorachaService,
} from "../helpers/in-memory-storacha.js";
import { startAlephStub } from "../helpers/aleph-stub.js";

export const drivers = [
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
  {
    name: "aleph (stub host)",
    async setUp() {
      const stub = await startAlephStub();
      const backend = createAlephBackend({
        ingestUrl: stub.ingestUrl,
        gateways: [stub.gatewayUrl],
        // Stands in for the wallet-signed STORE message. A no-op is faithful
        // rather than lazy: pinning tells Aleph to keep content that is already
        // on IPFS, so what the caller does beforehand — `publish` here — is the
        // part that makes it resolvable. The wallet only says "keep it".
        pin: async () => {},
      });
      return { backend, stub, publish: stub.publish };
    },
    async tearDown(context) {
      await context?.stub?.stop();
    },
  },
  // A real Pinata account: real files and a real bill. It joins the table only
  // when a run opts in twice — a JWT in the environment is not consent to spend
  // on every test run — and everything it stores is deleted again afterwards,
  // because a suite that leaves litter in a paid account gets switched off.
  ...(process.env.PINATA_LIVE === "true" && process.env.PINATA_JWT
    ? [
        {
          name: "pinata (live account)",
          async setUp() {
            const real = createPinataBackend({
              jwt: process.env.PINATA_JWT,
              gateway: process.env.PINATA_GATEWAY || undefined,
            });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                created.push(handle);
                return handle;
              },
            };
            // No publish: Pinata pins only what the public IPFS network can
            // serve, and an in-process map is not that. The pin-by-CID path is
            // exercised by pinata-live.test.js with a block put on IPFS first.
            return { backend, real, created, publish: null };
          },
          async tearDown(context) {
            for (const handle of context?.created || []) {
              await context.real.remove(handle).catch(() => {});
            }
          },
        },
      ]
    : []),
  // A real Lighthouse account, on the same terms as Pinata above: opted into
  // twice, and everything it stores deleted again. Lighthouse is paid for once
  // and meant to keep files forever, which is exactly why a test must not.
  ...(process.env.LIGHTHOUSE_LIVE === "true" && process.env.LIGHTHOUSE_API_KEY
    ? [
        {
          name: "lighthouse (live account)",
          async setUp() {
            const real = createLighthouseBackend({
              apiKey: process.env.LIGHTHOUSE_API_KEY,
              gateway: process.env.LIGHTHOUSE_GATEWAY || undefined,
            });
            const created = [];
            const backend = {
              ...real,
              putBlob: async (bytes, meta) => {
                const handle = await real.putBlob(bytes, meta);
                created.push(handle);
                return handle;
              },
            };
            // Lighthouse has no pin-by-CID, so there is nothing to publish to.
            return { backend, real, created, publish: null };
          },
          async tearDown(context) {
            for (const handle of context?.created || []) {
              await context.real.remove(handle).catch((error) => {
                console.log(`   cleanup could not remove ${handle.id}: ${error.message}`);
              });
            }
          },
        },
      ]
    : []),
];
