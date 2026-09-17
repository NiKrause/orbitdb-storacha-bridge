/**
 * @fileoverview What the Pinata driver refuses to be, and what it admits it cannot do.
 *
 * Offline. The first half needs no network at all: whether the driver can be
 * constructed, and whether the capabilities it declares follow from how it was
 * constructed. A capability set is what a caller trusts, so a driver that
 * overstates itself fails later, further away and less legibly.
 *
 * The second half replays answers the live service gave on 2026-09-17 through a
 * stand-in `fetch` — a shared gateway's 429, a free plan's 403 — so the driver's
 * reading of them stays pinned down without a network. Whether uploads, listing,
 * deletion and pinning work against Pinata itself is a live question: see
 * pinata-live.test.js and the "Live backends" workflow.
 */

import { describe, test, expect, afterEach } from "@jest/globals";
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

  test("a JWT buys listing and deletion, but not a browser", () => {
    const backend = createPinataBackend({ jwt: "test" });
    expect(backend.capabilities).toMatchObject({
      listing: true,
      deletion: true,
      browserSafeAuth: false,
    });
    expect(typeof backend.list).toBe("function");
    expect(typeof backend.remove).toBe("function");
  });

  test("pin by CID is opt-in, because the free plan refuses it", () => {
    const free = createPinataBackend({ jwt: "t" });
    expect(free.capabilities.pinByCid).toBe(false);
    expect(free.pinCid).toBeUndefined();

    const paid = createPinataBackend({ jwt: "t", pinByCid: true });
    expect(paid.capabilities.pinByCid).toBe(true);
    expect(typeof paid.pinCid).toBe("function");
  });

  test("a presigned upload URL is browser-safe, and says what it lost", () => {
    // The driver falls back to PINATA_JWT, which the live workflow sets.
    delete process.env.PINATA_JWT;
    try {
      const backend = createPinataBackend({
        getUploadUrl: async () => "https://example.invalid",
        pinByCid: true, // asked for, but there is no key to do it with
      });
      expect(backend.capabilities.browserSafeAuth).toBe(true);
      expect(backend.capabilities.pinByCid).toBe(false);
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

describe("Pinata driver, reading what the service answers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer each call with the next response in line; record what was asked. */
  const replay = (...responses) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method || "GET" });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next();
    };
    return calls;
  };
  const tooMany = () =>
    new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });

  test("a gateway 429 is waited out, not reported as missing", async () => {
    const bytes = new TextEncoder().encode("served on the second try");
    const calls = replay(tooMany, () => new Response(bytes));
    const backend = createPinataBackend({ jwt: "t" });

    const back = await backend.getBlob("bafkreiexample");
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a gateway that keeps answering 429 is reported, with the way out", async () => {
    const calls = replay(tooMany);
    const backend = createPinataBackend({ jwt: "t", gatewayRetries: 2 });

    await expect(backend.getBlob("bafkreiexample")).rejects.toThrow(
      /HTTP 429.*after 2 retries.*dedicated gateway/,
    );
    expect(calls).toHaveLength(3);
  });

  test("a dedicated gateway is used as given, and not told to use one", async () => {
    const calls = replay(tooMany);
    const backend = createPinataBackend({
      jwt: "t",
      gateway: "https://example.mypinata.cloud/",
      gatewayRetries: 0,
    });

    const error = await backend.getBlob("bafkreiexample").catch((e) => e);
    expect(calls[0].url).toBe("https://example.mypinata.cloud/ipfs/bafkreiexample");
    expect(error.message).not.toMatch(/dedicated gateway/);
  });

  test("a plan that lacks pin by CID is UNSUPPORTED, and says so", async () => {
    // The body the free plan returned on 2026-09-17, minus its request id.
    replay(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "Forbidden",
              reason: "This feature is not supported by the current plan type",
              message: "The requested action was forbidden",
            },
          }),
          { status: 403 },
        ),
    );
    const backend = createPinataBackend({ jwt: "t", pinByCid: true });

    const error = await backend.pinCid("bafkreiexample").catch((e) => e);
    expect(error.code).toBe("UNSUPPORTED");
    expect(error.message).toMatch(/paid-plan feature/);
  });

  test("a key Pinata rejects is a misconfigured backend, not a missing file", async () => {
    replay(() => new Response('{"error":"not authenticated"}', { status: 401 }));
    const backend = createPinataBackend({ jwt: "t" });

    const error = await backend.list().catch((e) => e);
    expect(error.code).toBe("INVALID_BACKEND");
  });

  test("only a 404 means not there", async () => {
    replay(() => new Response("not found", { status: 404 }));
    const backend = createPinataBackend({ jwt: "t" });

    const error = await backend.remove({ fileId: "gone" }).catch((e) => e);
    expect(error.code).toBe("NOT_FOUND");
  });
});
