/**
 * @fileoverview Lighthouse storage backend for OrbitDB Storacha Bridge
 *
 * Pay once, stored in perpetuity: a one-time payment funds an endowment that renews the
 * Filecoin deals. That is a different bargain from every other backend here, and it fits a
 * different job -- a small archive you want to stop thinking about, not a rolling backup
 * whose old versions you would happily expire, because here you pay for those forever too.
 *
 * CAR uploads go to a Kubo-shaped `/api/v0/dag/import`, so the blocks inside keep the CIDs
 * we gave them. No SDK dependency: their JS client insists on a `.car` path on disk in
 * Node, which would mean writing a temp file for bytes we already hold in memory. Posting
 * the multipart body ourselves removes that, and works unchanged in a browser.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 * @see {@link ../../docs/STORAGE-BACKENDS.md} for the cost model and the trade-offs
 */

import { defineBackend, handleId, BackendError } from "./types.js";

const DEFAULT_NODE = "https://upload.lighthouse.storage";
const DEFAULT_API = "https://api.lighthouse.storage";
const DEFAULT_GATEWAY = "https://gateway.lighthouse.storage";

const CAR_MIME = "application/vnd.ipld.car";

/**
 * Create a Lighthouse backend.
 *
 * @param {object} options
 * @param {string} [options.apiKey] - Lighthouse API key; falls back to LIGHTHOUSE_API_KEY
 * @param {"shared"|"user"} [options.keyOwnership="shared"] - who the key belongs to.
 *   Lighthouse lets each person mint their own key by signing with their own wallet
 *   (`POST /api/auth/create_api_key`), and only then is nothing secret being shipped to a
 *   browser -- so this is what decides `browserSafeAuth`. The key is unscoped and
 *   long-lived either way: an XSS is a full account takeover, user-minted or not.
 * @param {string} [options.gateway]
 * @param {string} [options.node] - upload node
 * @param {string} [options.api] - account API
 * @param {"walrus"} [options.storageType] - Lighthouse can put the bytes on Walrus/Sui instead
 * @returns {import("./types.js").StorageBackend}
 */
export function createLighthouseBackend(options = {}) {
  const apiKey =
    options.apiKey ||
    (typeof process !== "undefined"
      ? process.env?.LIGHTHOUSE_API_KEY
      : undefined);

  if (!apiKey) {
    throw new BackendError(
      "INVALID_BACKEND",
      "createLighthouseBackend needs an apiKey (or LIGHTHOUSE_API_KEY)",
    );
  }

  const node = (options.node || DEFAULT_NODE).replace(/\/+$/, "");
  const api = (options.api || DEFAULT_API).replace(/\/+$/, "");
  const gateway = (options.gateway || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const storageType = options.storageType;

  const authHeaders = (extra = {}) => ({
    Authorization: `Bearer ${apiKey}`,
    ...(storageType ? { "X-Storage-Type": storageType } : {}),
    ...extra,
  });

  const call = async (url, init = {}) => {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new BackendError(
        "NOT_FOUND",
        `Lighthouse ${init.method || "GET"} ${url} failed: HTTP ${response.status} ${await response
          .text()
          .catch(() => "")}`.trim(),
      );
    }
    return response;
  };

  /** One page of the account listing, normalised to backend entries. */
  const listFiles = async (listOptions = {}) => {
    const query = new URLSearchParams({
      lastKey: listOptions.cursor ?? "null",
      fileType: listOptions.fileType || "all",
    });
    const response = await call(`${api}/api/user/files_uploaded?${query}`, {
      headers: authHeaders({ "Content-Type": "application/json" }),
    });
    const body = await response.json();
    const files = body?.data?.fileList || body?.fileList || [];
    return files.map((file) => ({
      id: file.cid,
      cid: file.cid,
      backend: "lighthouse",
      size: Number(file.fileSizeInBytes) || undefined,
      // Deletion addresses Lighthouse's own file id, not the CID.
      fileId: file.id,
      insertedAt: file.createdAt,
      raw: file,
    }));
  };

  return defineBackend({
    name: "lighthouse",

    capabilities: {
      // No pin-by-CID endpoint: the bytes have to travel.
      pinByCid: false,
      carImport: true,
      // A plain /api/v0/add is hashed by Lighthouse with its own chunker and always comes
      // back as UnixFS or raw -- never dag-cbor -- so an OrbitDB block cannot be stored
      // under its own CID here. Only Storacha ever could, which is why the per-block path
      // existed and why it does not survive the move. Backups go up as a CAR.
      preservesInnerCids: false,
      browserSafeAuth: options.keyOwnership === "user",
      delegation: false,
      listing: true,
      deletion: true,
      minBlobSize: 0,
    },

    /** @type {import("./types.js").StorageBackend["putBlob"]} */
    putBlob: async (bytes, meta = {}) => {
      const name = meta.name || "blob";
      const type = meta.type || "application/octet-stream";
      const isCar = meta.car ?? type === CAR_MIME;

      const form = new FormData();
      form.append("file", new File([bytes], name, { type }));

      // dag/import unpacks the archive and keeps the inner blocks; add() would treat the
      // CAR as an opaque file and hand back a CID for the container instead.
      const url = isCar
        ? `${node}/api/v0/dag/import`
        : `${node}/api/v0/add?wrap-with-directory=false&cid-version=1`;

      const response = await call(url, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });

      const body = await response.json();
      const data = Array.isArray(body) ? body[0] : body.data || body;
      const cid = data.Hash || data.cid;
      if (!cid) {
        throw new BackendError(
          "NOT_FOUND",
          `Lighthouse accepted the upload but returned no CID: ${JSON.stringify(data).slice(0, 200)}`,
        );
      }

      return {
        id: cid,
        cid,
        backend: "lighthouse",
        size: Number(data.Size ?? bytes.length),
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
          `Lighthouse gateway did not serve ${cid}: HTTP ${response.status}` +
            (response.status === 402
              ? " (402 is what this gateway answers for content it does not hold)"
              : ""),
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    /** @type {import("./types.js").StorageBackend["list"]} */
    list: listFiles,

    /** @type {import("./types.js").StorageBackend["remove"]} */
    remove: async (handle) => {
      let fileId = typeof handle === "object" ? handle?.fileId : undefined;

      if (!fileId) {
        // putBlob does not learn the file id, so a delete usually has to look it up.
        // Match on the CID and refuse rather than guess: this account is paid for once
        // and its files are meant to be permanent.
        const cid = handleId(handle);
        const entries = await listFiles();
        const match = entries.find((entry) => entry.cid === cid);
        if (!match?.fileId) {
          throw new BackendError(
            "NOT_FOUND",
            `No Lighthouse file found for ${cid}`,
          );
        }
        fileId = match.fileId;
      }

      await call(
        `${api}/api/user/delete_file?id=${encodeURIComponent(fileId)}`,
        {
          method: "DELETE",
          headers: authHeaders({ "Content-Type": "application/json" }),
        },
      );
    },
  });
}

export default createLighthouseBackend;
