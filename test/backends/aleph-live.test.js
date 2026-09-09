/**
 * @fileoverview The Aleph driver against the real host. Opt-in.
 *
 * `ALEPH_LIVE=true npm test -- test/backends/aleph-live.test.js`
 *
 * The stub in the conformance table proves the contract; this proves the
 * *assumptions the stub was built on*, which is a different question and the
 * one that goes stale. Every claim in `lib/backends/aleph.js` about what the
 * live host does came from probing it by hand on 2026-09-09, and a hand probe
 * is a fact with no expiry date attached. This is that probe, made repeatable.
 *
 * Not in CI on purpose: it writes into public infrastructure that costs
 * somebody else something, and it would fail for anyone working offline. Run
 * it when the driver changes, or when Aleph does.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createAlephBackend } from "../../lib/backends/aleph.js";

jest.setTimeout(180_000);

const live = process.env.ALEPH_LIVE === "true";
const maybe = live ? describe : describe.skip;

if (!live) {
  console.log("⏭️  Skipping the live Aleph check — set ALEPH_LIVE=true to run it");
}

maybe("the real Aleph host, as the driver assumes it", () => {
  test("a CAR-shaped binary blob survives byte for byte, with no key at any point", async () => {
    const backend = createAlephBackend();

    // Random bytes, so nothing can succeed by returning something plausible.
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;

    const handle = await backend.putBlob(bytes, {
      name: "conformance.car",
      contentType: "application/vnd.ipld.car",
    });

    // The claim the driver's design rests on: the id is Aleph's, not ours.
    expect(handle.id).toBeTruthy();
    expect(handle.cid).toBeUndefined();
    expect(handle.retained).toBe(false); // ingest without a wallet keeps nothing

    const back = await backend.getBlob(handle);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  test("an empty blob is a blob here too", async () => {
    const backend = createAlephBackend();
    const handle = await backend.putBlob(new Uint8Array(0));
    const back = await backend.getBlob(handle);
    expect(back.length).toBe(0);
  });

  test("without a wallet it declares no pinning, rather than pretending", async () => {
    const backend = createAlephBackend();
    expect(backend.capabilities.pinByCid).toBe(false);
    expect(backend.pinCid).toBeUndefined();
  });
});
