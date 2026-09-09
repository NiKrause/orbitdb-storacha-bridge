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
];
