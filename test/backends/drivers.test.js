/**
 * @fileoverview What each driver refuses to be, and what it admits it cannot do
 *
 * The conformance suite checks a live backend against the contract. These tests check the
 * part that needs no network: whether a driver can be constructed at all, and whether the
 * capabilities it declares follow from how it was constructed. Both matter more than they
 * look. A capability set is what `chooseBackupStrategy` reads and what a caller trusts, so
 * a driver that overstates itself fails later, further away, and less legibly.
 *
 * @author @NiKrause
 * @requires ../../lib/backends/
 */

import { createPinataBackend } from "../../lib/backends/pinata.js";
import { createLighthouseBackend } from "../../lib/backends/lighthouse.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";

describe("Pinata", () => {
  test("needs either a JWT or a way to mint upload URLs", () => {
    expect(() => createPinataBackend({})).toThrow(/jwt or a getUploadUrl/);
  });

  test("a JWT buys listing, deletion and pinning, but not a browser", () => {
    const backend = createPinataBackend({ jwt: "test" });
    expect(backend.capabilities).toMatchObject({
      pinByCid: true,
      listing: true,
      deletion: true,
      browserSafeAuth: false,
    });
  });

  test("a presigned URL is browser-safe, and says what it lost", () => {
    const backend = createPinataBackend({
      getUploadUrl: async () => "https://example.invalid",
    });
    expect(backend.capabilities.browserSafeAuth).toBe(true);
    // Absent, not present-and-failing: a caller checks the flag, not a try/catch.
    expect(backend.list).toBeUndefined();
    expect(backend.remove).toBeUndefined();
    expect(backend.pinCid).toBeUndefined();
  });

  test("never claims to preserve our CIDs, so backups go up as a CAR", () => {
    expect(
      createPinataBackend({ jwt: "t" }).capabilities.preservesInnerCids,
    ).toBe(false);
  });
});

describe("Lighthouse", () => {
  test("needs an API key", () => {
    expect(() => createLighthouseBackend({})).toThrow(/needs an apiKey/);
  });

  test("a shared key is not browser-safe; a user-minted one is", () => {
    expect(
      createLighthouseBackend({ apiKey: "t" }).capabilities.browserSafeAuth,
    ).toBe(false);
    expect(
      createLighthouseBackend({ apiKey: "t", keyOwnership: "user" })
        .capabilities.browserSafeAuth,
    ).toBe(true);
  });

  test("imports CARs but cannot pin a CID it does not have", () => {
    const backend = createLighthouseBackend({ apiKey: "t" });
    expect(backend.capabilities.carImport).toBe(true);
    expect(backend.capabilities.pinByCid).toBe(false);
    expect(backend.pinCid).toBeUndefined();
  });
});

describe("Aleph", () => {
  test("refuses to ingest without a way to make it persistent", () => {
    // /api/v0/add returns a CID whether or not anything will keep the bytes. A driver
    // that let that pass would hand back something shaped exactly like a good backup.
    expect(() => createAlephBackend({})).toThrow(/needs publishStore/);
    expect(() => createAlephBackend({})).toThrow(/not pinned/);
  });

  test("ephemeral has to be asked for by name", () => {
    const backend = createAlephBackend({ ephemeral: true });
    expect(backend.capabilities.pinByCid).toBe(false);
    expect(backend.capabilities.listing).toBe(false);
  });

  test("capabilities follow from what the caller supplied", () => {
    const backend = createAlephBackend({
      publishStore: async () => ({ item_hash: "abc" }),
      forget: async () => {},
      address: "0xabc",
    });
    expect(backend.capabilities).toMatchObject({
      pinByCid: true,
      listing: true,
      deletion: true,
      // no key exists to leak: the STORE message is signed by the user's own wallet
      browserSafeAuth: true,
      // only /api/v0/add exists on that host, so no CAR import
      carImport: false,
    });
  });

  test("marks an ephemeral upload as not persistent", async () => {
    const backend = createAlephBackend({ ephemeral: true });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ Hash: "bafytest", Size: "4" }),
    });
    try {
      const handle = await backend.putBlob(new Uint8Array([1, 2, 3, 4]));
      expect(handle.persistent).toBe(false);
      expect(handle.cid).toBe("bafytest");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("marks a stored upload as persistent and keeps the item hash", async () => {
    const backend = createAlephBackend({
      publishStore: async (cid) => ({ item_hash: `store-for-${cid}` }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ Hash: "bafytest", Size: "4" }),
    });
    try {
      const handle = await backend.putBlob(new Uint8Array([1, 2, 3, 4]));
      expect(handle.persistent).toBe(true);
      expect(handle.itemHash).toBe("store-for-bafytest");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
