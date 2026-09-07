/**
 * @fileoverview Pinata storage backend for OrbitDB Storacha Bridge
 *
 * Pinata is the only evaluated backend that can both take a CAR and pin a CID that is
 * already on IPFS, and those are the two shapes this library wants. Pinning by CID is the
 * better one: we already run Helia, so `pinCid()` moves no bytes through a vendor API and
 * the hashes cannot drift, because nobody but us ever computed them.
 *
 * No SDK dependency -- the v3 API is three documented endpoints and `fetch`, which keeps
 * the package lean and works unchanged in the browser.
 *
 * Two modes, and the capability set says which one you got:
 *
 *   - **with a JWT** — full backend: upload, list, delete, pin by CID. The JWT is a bearer
 *     secret, so `browserSafeAuth` is false; this belongs on a relay or in Node.
 *   - **with `getUploadUrl`** — a presigned upload URL minted elsewhere. Nothing secret
 *     reaches the browser, so `browserSafeAuth` is true, but the operations that need the
 *     account key are gone and the driver declares them gone rather than failing later.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 * @see {@link https://docs.pinata.cloud/files/uploading-files} for the CAR upload rules
 */

import { defineBackend, handleId, BackendError } from "./types.js";

const DEFAULT_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const DEFAULT_API_URL = "https://api.pinata.cloud/v3";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud";

/** Pinata treats a CAR upload as a CAR only when told to. */
const CAR_MIME = "application/vnd.ipld.car";

/**
 * Create a Pinata backend.
 *
 * @param {object} options
 * @param {string} [options.jwt] - Pinata JWT; falls back to PINATA_JWT
 * @param {() => Promise<string>} [options.getUploadUrl] - mint a presigned upload URL
 *   instead of holding a JWT. Uploads only; see the note above.
 * @param {string} [options.gateway] - retrieval gateway; a dedicated one is strongly
 *   preferred, the shared one is rate limited and slow
 * @param {"public"|"private"} [options.network="public"] - CAR uploads are public only
 * @param {string} [options.uploadUrl]
 * @param {string} [options.apiUrl]
 * @returns {import("./types.js").StorageBackend}
 */
export function createPinataBackend(options = {}) {
  const jwt =
    options.jwt ||
    (typeof process !== "undefined" ? process.env?.PINATA_JWT : undefined);
  const getUploadUrl = options.getUploadUrl;

  if (!jwt && !getUploadUrl) {
    throw new BackendError(
      "INVALID_BACKEND",
      "createPinataBackend needs either a jwt or a getUploadUrl function",
    );
  }

  const network = options.network || "public";
  const uploadUrl = options.uploadUrl || DEFAULT_UPLOAD_URL;
  const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const gateway = (options.gateway || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const keyed = Boolean(jwt);

  /** Call the account API. Only available in JWT mode. */
  const api = async (path, init = {}) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new BackendError(
        "NOT_FOUND",
        `Pinata ${init.method || "GET"} ${path} failed: HTTP ${response.status} ${await response
          .text()
          .catch(() => "")}`.trim(),
      );
    }
    return response.status === 204 ? null : response.json();
  };

  const backend = {
    name: "pinata",

    capabilities: {
      pinByCid: keyed,
      // A CAR uploaded with car=true is unpacked and its blocks indexed. Paid plans only.
      carImport: true,
      // A plain file push is hashed by Pinata with its own chunker, so per-block upload is
      // not safe here -- and at 60 requests a minute on the free tier it would be unwise
      // even if it were. Declaring false routes backups through a CAR, which is correct.
      preservesInnerCids: false,
      browserSafeAuth: !keyed,
      delegation: true,
      listing: keyed,
      deletion: keyed,
      minBlobSize: 0,
    },

    /** @type {import("./types.js").StorageBackend["putBlob"]} */
    putBlob: async (bytes, meta = {}) => {
      const name = meta.name || "blob";
      const type = meta.type || "application/octet-stream";
      const isCar = meta.car ?? type === CAR_MIME;

      const form = new FormData();
      form.append("file", new File([bytes], name, { type }));
      form.append("network", network);
      form.append("name", name);
      if (isCar) {
        form.append("car", "true");
      }

      const target = getUploadUrl ? await getUploadUrl() : uploadUrl;
      const response = await fetch(target, {
        method: "POST",
        headers:
          keyed && !getUploadUrl ? { Authorization: `Bearer ${jwt}` } : {},
        body: form,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new BackendError(
          "UNSUPPORTED",
          `Pinata upload failed: HTTP ${response.status} ${detail}`.trim() +
            (isCar
              ? " (CAR uploads need a paid plan, the public network, and a single root CID)"
              : ""),
        );
      }

      const body = await response.json();
      const data = body?.data || body;
      return {
        id: data.cid,
        cid: data.cid,
        backend: "pinata",
        size: data.size ?? bytes.length,
        // Deletion addresses Pinata's own file id, not the CID.
        fileId: data.id,
        raw: data,
      };
    },

    /** @type {import("./types.js").StorageBackend["getBlob"]} */
    getBlob: async (handle) => {
      const cid = handleId(handle);
      const response = await fetch(`${gateway}/ipfs/${cid}`);
      if (!response.ok) {
        throw new BackendError(
          "NOT_FOUND",
          `Pinata gateway did not serve ${cid}: HTTP ${response.status}` +
            (response.status === 404
              ? " (a CAR upload is processed asynchronously; it may not be indexed yet)"
              : ""),
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };

  if (keyed) {
    backend.pinCid = async (cid, meta = {}) => {
      const body = await api("/files/public/pin_by_cid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cid: String(cid),
          ...(meta.name ? { name: meta.name } : {}),
        }),
      });
      const data = body?.data || body || {};
      return {
        id: String(cid),
        cid: String(cid),
        backend: "pinata",
        fileId: data.id,
        // "prechecking" or "retrieving": Pinata has accepted the job, not finished it.
        status: data.status,
        raw: data,
      };
    };

    backend.list = async (listOptions = {}) => {
      const query = new URLSearchParams();
      if (listOptions.limit) query.set("limit", String(listOptions.limit));
      if (listOptions.cursor) query.set("pageToken", listOptions.cursor);
      if (listOptions.cid) query.set("cid", String(listOptions.cid));

      const body = await api(
        `/files/${network}${query.size ? `?${query}` : ""}`,
      );
      const files = body?.data?.files || [];
      return files.map((file) => ({
        id: file.cid,
        cid: file.cid,
        backend: "pinata",
        size: file.size,
        fileId: file.id,
        insertedAt: file.created_at,
        raw: file,
      }));
    };

    backend.remove = async (handle) => {
      let fileId = typeof handle === "object" ? handle?.fileId : undefined;

      if (!fileId) {
        // Only a CID was given. Resolve it, and refuse unless the record we found is
        // actually the one asked for -- deleting the wrong file is not recoverable.
        const cid = handleId(handle);
        const matches = await backend.list({ cid, limit: 2 });
        const match = matches.find((entry) => entry.cid === cid);
        if (!match?.fileId) {
          throw new BackendError(
            "NOT_FOUND",
            `No Pinata file found for ${cid}; pass the handle from putBlob to delete it`,
          );
        }
        fileId = match.fileId;
      }

      await api(`/files/${network}/${fileId}`, { method: "DELETE" });
    };
  }

  return defineBackend(backend);
}

export default createPinataBackend;
