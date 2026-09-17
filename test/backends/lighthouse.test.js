/**
 * @fileoverview What the Lighthouse driver refuses to be, what it sends, and how it reads
 * what comes back.
 *
 * Offline. The requests are checked against the shapes `@lighthouse-web3/sdk` 0.4.7
 * sends, and the answers are replayed through a stand-in `fetch`. The traps the Pinata
 * driver fell into against a live account — a backup's CAR restored as something else, a
 * file name with a path turned into folders, a refusal reduced to a status code — are
 * pinned down here before Lighthouse gets the chance. Whether uploads, listing and
 * deletion work against Lighthouse itself is a live question: see the "Live backends"
 * workflow.
 */

import { describe, test, expect, afterEach } from "@jest/globals";
import { createLighthouseBackend } from "../../lib/backends/lighthouse.js";

describe("Lighthouse driver, offline", () => {
  const savedKey = process.env.LIGHTHOUSE_API_KEY;

  test("needs an API key", () => {
    delete process.env.LIGHTHOUSE_API_KEY;
    try {
      expect(() => createLighthouseBackend({})).toThrow(/needs an apiKey/);
    } finally {
      if (savedKey !== undefined) process.env.LIGHTHOUSE_API_KEY = savedKey;
    }
  });

  test("lists and deletes, never pins by CID, and never claims our CIDs", () => {
    const backend = createLighthouseBackend({ apiKey: "k" });
    expect(backend.capabilities).toMatchObject({
      pinByCid: false,
      preservesInnerCids: false,
      listing: true,
      deletion: true,
    });
    expect(backend.pinCid).toBeUndefined();
  });

  test("CAR import is opt-in, because backupDatabase restores by fetching the CAR back", () => {
    expect(createLighthouseBackend({ apiKey: "k" }).capabilities.carImport).toBe(false);
    expect(createLighthouseBackend({ apiKey: "k", carImport: true }).capabilities.carImport).toBe(true);
  });

  test("a key is browser-safe only when its owner minted it", () => {
    expect(createLighthouseBackend({ apiKey: "k" }).capabilities.browserSafeAuth).toBe(false);
    expect(
      createLighthouseBackend({ apiKey: "k", keyOwnership: "user" }).capabilities.browserSafeAuth,
    ).toBe(true);
  });
});

describe("Lighthouse driver, requests and answers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer each call with the next response in line; record what was asked. */
  const replay = (...responses) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method || "GET", headers: init?.headers, body: init?.body });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next();
    };
    return calls;
  };
  const added = (name, hash = "bafkreiadded") => () =>
    Response.json({ Name: name, Hash: hash, Size: "2" });

  test("a plain upload goes to add, as the SDK sends it, with the key as bearer", async () => {
    const calls = replay(added("round-trip.bin"));
    const backend = createLighthouseBackend({ apiKey: "secret-key" });

    const handle = await backend.putBlob(new Uint8Array([1, 2]), { name: "round-trip.bin" });

    expect(calls[0].url).toBe(
      "https://upload.lighthouse.storage/api/v0/add?wrap-with-directory=false&cid-version=1",
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer secret-key");
    expect(calls[0].body.get("file").name).toBe("round-trip.bin");
    expect(handle).toMatchObject({ id: "bafkreiadded", backend: "lighthouse" });
    // Lighthouse hashed these bytes itself; the handle does not pretend the CID is ours.
    expect(handle.cid).toBeUndefined();
  });

  test("a backup's CAR goes up as a plain file unless CAR import is asked for", async () => {
    const calls = replay(added("backup-blocks.car"));
    const backend = createLighthouseBackend({ apiKey: "k" });

    await backend.putBlob(new Uint8Array([1, 2]), {
      name: "did:key:z6Mk/backup-blocks.car",
      type: "application/vnd.ipld.car",
    });

    expect(calls[0].url).toContain("/api/v0/add?");
  });

  test("with CAR import, a CAR goes to dag/import under a .car name, and the root is ours", async () => {
    const calls = replay(() => Response.json({ Root: { Cid: { "/": "bafyreiroot" } } }));
    const backend = createLighthouseBackend({ apiKey: "k", carImport: true });

    const handle = await backend.putBlob(new Uint8Array([1, 2]), {
      name: "space/backup-blocks",
      type: "application/vnd.ipld.car",
    });

    expect(calls[0].url).toBe("https://upload.lighthouse.storage/api/v0/dag/import");
    expect(calls[0].body.get("file").name).toBe("backup-blocks.car");
    expect(handle).toMatchObject({ id: "bafyreiroot", cid: "bafyreiroot" });
  });

  test("a name with a path goes up as a file, not a folder", async () => {
    const calls = replay(added("backup-2026-09-17-metadata.json"));
    const backend = createLighthouseBackend({ apiKey: "k" });

    await backend.putBlob(new TextEncoder().encode("{}"), {
      name: "did:key:z6Mk/backup-2026-09-17-metadata.json",
    });

    expect(calls[0].body.get("file").name).toBe("backup-2026-09-17-metadata.json");
  });

  test("an answer with one entry per line yields the file's own CID, not a folder's", async () => {
    replay(
      () =>
        new Response(
          [
            JSON.stringify({ Name: "folder", Hash: "bafybeifolder", Size: "90" }),
            JSON.stringify({ Name: "blob.json", Hash: "bafkreifile", Size: "2" }),
          ].join("\n"),
        ),
    );
    const backend = createLighthouseBackend({ apiKey: "k" });

    const handle = await backend.putBlob(new TextEncoder().encode("{}"), { name: "blob.json" });

    expect(handle.id).toBe("bafkreifile");
  });

  test("an upload refusal carries Lighthouse's reason and a code a caller can branch on", async () => {
    replay(() => Response.json({ error: "Invalid API key" }, { status: 401 }));
    const backend = createLighthouseBackend({ apiKey: "k" });

    const error = await backend.putBlob(new Uint8Array([1])).catch((e) => e);
    expect(error.code).toBe("INVALID_BACKEND");
    expect(error.message).toMatch(/HTTP 401.*Invalid API key/);
  });

  test("an expired plan is UNSUPPORTED, not a bad key, and says so", async () => {
    // The body a live account answered on 2026-09-17, whose key the listing accepted.
    replay(() =>
      Response.json(
        {
          success: false,
          error: "Trial expired",
          details: "Your trial period has expired. Please upgrade to a paid plan",
        },
        { status: 403 },
      ),
    );
    const backend = createLighthouseBackend({ apiKey: "k" });

    const error = await backend.putBlob(new Uint8Array([1])).catch((e) => e);
    expect(error.code).toBe("UNSUPPORTED");
    expect(error.message).toMatch(/HTTP 403.*Trial expired.*plan does not include uploads/);
  });

  test("a 403 without a plan reason is still a misconfigured key", async () => {
    replay(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    const backend = createLighthouseBackend({ apiKey: "k" });

    const error = await backend.putBlob(new Uint8Array([1])).catch((e) => e);
    expect(error.code).toBe("INVALID_BACKEND");
  });

  test("listing reads fileList, with or without a data wrapper, and keeps the file id for deletion", async () => {
    const file = { cid: "bafkreilisted", id: "file-uuid", fileSizeInBytes: "31", createdAt: 1 };
    const calls = replay(() => Response.json({ fileList: [file], totalFiles: 1 }));
    const backend = createLighthouseBackend({ apiKey: "k" });

    const [entry] = await backend.list();

    expect(calls[0].url).toBe(
      "https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null&fileType=all",
    );
    expect(entry).toMatchObject({ id: "bafkreilisted", cid: "bafkreilisted", fileId: "file-uuid", size: 31 });
  });

  test("removing by CID looks the file up, then deletes it by its Lighthouse id", async () => {
    const calls = replay(
      () => Response.json({ fileList: [{ cid: "bafkreigone", id: "file-uuid" }] }),
      () => Response.json({ message: "File deleted successfully." }),
    );
    const backend = createLighthouseBackend({ apiKey: "k" });

    await backend.remove("bafkreigone");

    expect(calls[1]).toMatchObject({
      url: "https://api.lighthouse.storage/api/user/delete_file?id=file-uuid",
      method: "DELETE",
    });
  });

  test("a CID the listing does not show is refused, not guessed at", async () => {
    const calls = replay(() => Response.json({ fileList: [{ cid: "bafkreiother", id: "x" }] }));
    const backend = createLighthouseBackend({ apiKey: "k" });

    const error = await backend.remove("bafkreimissing").catch((e) => e);
    expect(error.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  test("a gateway 429 is waited out, and a bare-domain gateway is read over https", async () => {
    const bytes = new TextEncoder().encode("served on the second try");
    const calls = replay(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      () => new Response(bytes),
    );
    const backend = createLighthouseBackend({ apiKey: "k", gateway: "example.lighthouse.storage/" });

    const back = await backend.getBlob("bafkreiexample");

    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.lighthouse.storage/ipfs/bafkreiexample",
      "https://example.lighthouse.storage/ipfs/bafkreiexample",
    ]);
  });

  test("a gateway refusal carries the gateway's reason", async () => {
    replay(() => new Response("Payment Required: content not found on Lighthouse", { status: 402 }));
    const backend = createLighthouseBackend({ apiKey: "k" });

    const error = await backend.getBlob("bafkreiexample").catch((e) => e);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toMatch(/HTTP 402 "Payment Required: content not found on Lighthouse"/);
  });
});
