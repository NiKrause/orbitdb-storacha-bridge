/**
 * @fileoverview Pinata's pin-by-CID against the real service. Opt-in.
 *
 *     PINATA_LIVE=true PINATA_JWT=… npm test -- test/backends/pinata-live.test.js
 *
 * or the "Live backends" workflow, which takes the JWT from a repository
 * secret so it never sits on a laptop.
 *
 * Uploads, listing, deletion and a whole database round trip run in the shared
 * table (conformance.test.js, restore.test.js) when PINATA_LIVE is set. What
 * the table cannot do is pin by CID: Pinata fetches the content itself, from
 * the public IPFS network, and an in-process map is not that. So this puts a
 * block on IPFS first — through Aleph, which needs no key — and then asks
 * Pinata to pin that CID and serve it back.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createPinataBackend } from "../../lib/backends/pinata.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";

const PIN_TIMEOUT_MS = 10 * 60_000;
jest.setTimeout(PIN_TIMEOUT_MS + 120_000);

const live = process.env.PINATA_LIVE === "true" && Boolean(process.env.PINATA_JWT);
const maybe = live ? describe : describe.skip;

if (!live) {
  console.log("⏭️  Skipping the live Pinata check — set PINATA_LIVE=true and PINATA_JWT to run it");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

maybe("Pinata pin-by-CID, against the real service", () => {
  test("a CID that is on IPFS gets pinned, listed, served back byte for byte, and removed", async () => {
    const pinata = createPinataBackend({
      jwt: process.env.PINATA_JWT,
      gateway: process.env.PINATA_GATEWAY || undefined,
    });

    // Unique bytes, so the CID has never been pinned before.
    const bytes = new TextEncoder().encode(
      `orbitdb-storacha-bridge pinata live check ${new Date().toISOString()} ${Math.random()}`,
    );
    const onIpfs = await createAlephBackend().putBlob(bytes, { name: "pinata-live-check.txt" });
    const cid = onIpfs.id;

    const handle = await pinata.pinCid(cid, { name: "pinata-live-check" });
    let file;
    try {
      expect(handle.cid).toBe(cid);
      console.log(`   pin request ${handle.requestId} for ${cid}: ${handle.status ?? "(no status)"}`);

      // Pinata accepts the job at once and retrieves in the background; wait
      // until its own listing shows the file, then read it back.
      const started = Date.now();
      while (Date.now() - started < PIN_TIMEOUT_MS) {
        file = (await pinata.list({ cid })).find((entry) => entry.cid === cid);
        if (file) break;
        await sleep(15_000);
      }
      expect(file?.cid).toBe(cid);
      console.log(`   listed after ${Math.round((Date.now() - started) / 1000)} s as file ${file.fileId}`);

      const back = await pinata.getBlob(cid);
      expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      if (file) {
        await pinata.remove(file).catch((error) => {
          console.log(`   cleanup could not remove ${cid}: ${error.message}`);
        });
      } else if (handle.requestId) {
        // Never retrieved: withdraw the request, or it lands in the account later.
        const response = await fetch(
          `https://api.pinata.cloud/v3/files/public/pin_by_cid/${handle.requestId}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` } },
        ).catch((error) => ({ ok: false, status: error.message }));
        if (!response.ok) console.log(`   cleanup could not cancel request ${handle.requestId}: ${response.status}`);
      }
    }
  });
});
