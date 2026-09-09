/**
 * @fileoverview A stand-in for Aleph's IPFS host.
 *
 * The real one is public, keyless and free, which makes it tempting to point
 * the suite straight at it. That would mean every CI run writes into somebody
 * else's infrastructure and every offline developer sees red, to prove a
 * contract that is about our side of the wire.
 *
 * So: the two endpoints the driver actually uses, with the shapes measured
 * against the live host on 2026-09-09 — `POST /api/v0/add` answering
 * `{ Name, Hash, Size }`, and `GET /ipfs/<id>` returning exactly what went in.
 * The live check lives separately and is opt-in.
 *
 * The ids it issues are content addresses, which the real host's are not: Aleph
 * returns a CIDv0 for the UnixFS wrapper it makes. That difference does not
 * reach the driver, which treats the id as opaque — and a stub that invented a
 * *less* opaque id would be a worse test, not a better one.
 */

import { createServer } from "node:http";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

/**
 * Pull the single file part out of a multipart body.
 *
 * Deliberately minimal: the driver sends one part, and a general parser here
 * would be a second implementation to get wrong. It finds the blank line that
 * ends the part headers and the boundary that follows the content — which is
 * the whole format, for one part.
 */
function filePart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);

  const start = body.indexOf(boundary);
  if (start < 0) return null;
  const headerEnd = body.indexOf("\r\n\r\n", start);
  if (headerEnd < 0) return null;

  const contentStart = headerEnd + 4;
  const nextBoundary = body.indexOf(boundary, contentStart);
  if (nextBoundary < 0) return null;

  // The CRLF before the closing boundary belongs to the format, not the file.
  return body.subarray(contentStart, nextBoundary - 2);
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/**
 * Start the stub.
 *
 * @returns {Promise<{ url: string, gatewayUrl: string, ingestUrl: string,
 *   publish: (cid: string, bytes: Uint8Array) => void, count: () => number,
 *   stop: () => Promise<void> }>}
 */
export async function startAlephStub() {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map();
  let uploads = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "POST" && url.pathname === "/api/v0/add") {
        const body = await readBody(request);
        const file = filePart(body, request.headers["content-type"]);
        if (!file) {
          response.writeHead(400).end("no file part");
          return;
        }
        const bytes = new Uint8Array(file);
        const id = CID.create(1, raw.code, await sha256.digest(bytes)).toString();
        store.set(id, bytes);
        uploads++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ Name: "blob", Hash: id, Size: String(bytes.length) }));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/ipfs/")) {
        const bytes = store.get(url.pathname.slice("/ipfs/".length));
        if (!bytes) {
          response.writeHead(404).end("not found");
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(bytes));
        return;
      }

      // Everything else 404s, exactly as the real host does for `dag/import`,
      // `block/put`, `pin/add` and `cat` — so a driver that starts reaching for
      // them fails here rather than in production.
      response.writeHead(404).end("not found");
    } catch (error) {
      response.writeHead(500).end(String(error?.message ?? error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    ingestUrl: `${url}/api/v0/add`,
    gatewayUrl: `${url}/ipfs`,
    /** Make a CID resolvable without uploading — what `pinCid` then points at. */
    publish: (cid, bytes) => store.set(cid, bytes),
    count: () => uploads,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export default startAlephStub;
