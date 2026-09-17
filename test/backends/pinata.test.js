/**
 * @fileoverview What the Pinata driver refuses to be, and what it admits it cannot do.
 *
 * Offline, so it proves only the part that needs no network: whether the driver
 * can be constructed, and whether the capabilities it declares follow from how
 * it was constructed. A capability set is what a caller trusts, so a driver that
 * overstates itself fails later, further away and less legibly. Whether uploads,
 * listing, deletion and pinning work against Pinata is a live question — see
 * pinata-live.test.js and the "Live backends" workflow.
 */

import { describe, test, expect } from "@jest/globals";
import { createPinataBackend } from "../../lib/backends/pinata.js";

describe("Pinata driver, offline", () => {
  const savedJwt = process.env.PINATA_JWT;

  test("needs either a JWT or a way to mint upload URLs", () => {
    delete process.env.PINATA_JWT;
    try {
      expect(() => createPinataBackend({})).toThrow(/jwt or a getUploadUrl/);
    } finally {
      if (savedJwt !== undefined) process.env.PINATA_JWT = savedJwt;
    }
  });

  test("a JWT buys listing, deletion and pinning, but not a browser", () => {
    const backend = createPinataBackend({ jwt: "test" });
    expect(backend.capabilities).toMatchObject({
      pinByCid: true,
      listing: true,
      deletion: true,
      browserSafeAuth: false,
    });
    expect(typeof backend.pinCid).toBe("function");
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.remove).toBe("function");
  });

  test("a presigned upload URL is browser-safe, and says what it lost", () => {
    // The driver falls back to PINATA_JWT, which the live workflow sets.
    delete process.env.PINATA_JWT;
    try {
      const backend = createPinataBackend({
        getUploadUrl: async () => "https://example.invalid",
      });
      expect(backend.capabilities.browserSafeAuth).toBe(true);
      // Absent rather than present-and-failing: a caller checks the flag.
      expect(backend.list).toBeUndefined();
      expect(backend.remove).toBeUndefined();
      expect(backend.pinCid).toBeUndefined();
    } finally {
      if (savedJwt !== undefined) process.env.PINATA_JWT = savedJwt;
    }
  });

  test("CAR import is opt-in, because only paid plans have it", () => {
    expect(createPinataBackend({ jwt: "t" }).capabilities.carImport).toBe(false);
    expect(
      createPinataBackend({ jwt: "t", carImport: true }).capabilities.carImport,
    ).toBe(true);
  });

  test("never claims to preserve our CIDs, so backups go up as a CAR", () => {
    expect(
      createPinataBackend({ jwt: "t" }).capabilities.preservesInnerCids,
    ).toBe(false);
  });
});
