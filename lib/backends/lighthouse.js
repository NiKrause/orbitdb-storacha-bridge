/**
 * @fileoverview Lighthouse storage backend for OrbitDB Storage Bridge
 *
 * Pay once, stored in perpetuity: a one-time payment funds an endowment that renews the
 * Filecoin deals. That is a different bargain from every other backend here, and it fits a
 * different job -- a small archive you want to stop thinking about, not a rolling backup
 * whose old versions you would happily expire, because here you pay for those forever too.
 *
 * No SDK dependency. The endpoints and shapes below are the ones `@lighthouse-web3/sdk`
 * 0.4.7 uses: `POST {node}/api/v0/add?wrap-with-directory=false&cid-version=1` with one
 * multipart `file`, `POST {node}/api/v0/dag/import` for a CAR, `GET
 * {api}/api/user/files_uploaded` for the listing and `DELETE {api}/api/user/delete_file`.
 * Their Node client insists on a path on disk; posting the multipart body ourselves takes
 * the bytes we already hold, and works unchanged in a browser.
 *
 * What the Pinata driver learned against a live account applies here too, so it is built
 * in rather than rediscovered: a backup's CAR goes up as a plain file unless CAR import is
 * asked for, because `backupDatabase` restores by fetching the CAR back; a file name
 * carries no path, because a Kubo-shaped `add` turns a path into folders; and a refusal
 * says what the service said.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 * @see {@link ../../docs/STORAGE-BACKENDS.md} for the cost model and the trade-offs
 */

/* global FormData, URLSearchParams */

import { defineBackend, handleId, BackendError } from "./types.js";

const DEFAULT_NODE = "https://upload.lighthouse.storage";
const DEFAULT_API = "https://api.lighthouse.storage";
const DEFAULT_GATEWAY = "https://gateway.lighthouse.storage";

const CAR_MIME = "application/vnd.ipld.car";

/** How often a gateway 429 is waited out before it counts as a failure. */
const GATEWAY_RETRIES = 4;
/** The longest single wait, whatever Retry-After asks for. */
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * What a refusal means to a caller: a key the service rejects is a misconfigured
 * backend, only a 404 is "not there", and anything else is "cannot".
 */
const codeFor = (status) => {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "INVALID_BACKEND";
  return "UNSUPPORTED";
};

/** The first 240 characters of what the service said, on one line. */
const reasonOf = async (response) =>
  (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 240);

/** Retry-After when the gateway sends one, otherwise doubling from a second. */
const retryWait = (response, attempt) => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A base URL as given, or over https when given as a bare domain. */
const baseUrl = (value) => {
  const trimmed = String(value).trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * An `add` or `dag/import` answer: one JSON object, a JSON array, or one object per
 * line — Kubo answers the last way whenever more than one entry comes back.
 */
const parseEntries = (text) => {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
};

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
 * @param {boolean} [options.carImport=false] - send CARs to `dag/import`, so Lighthouse
 *   unpacks them and the blocks inside keep their CIDs. The handle then names the CAR's
 *   root, which a gateway serves as that block, not as the CAR — so `backupDatabase`,
 *   which restores by fetching the CAR back, needs this off. Without it a CAR goes up as
 *   one plain file and comes back byte for byte.
 * @param {string} [options.gateway] - retrieval gateway; a bare domain is read over https
 * @param {number} [options.gatewayRetries=4] - how often a gateway 429 is waited out
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

  const node = baseUrl(options.node || DEFAULT_NODE);
  const api = baseUrl(options.api || DEFAULT_API);
  const gateway = baseUrl(options.gateway || DEFAULT_GATEWAY);
  const storageType = options.storageType;
  const carImport = options.carImport === true;
  const gatewayRetries = options.gatewayRetries ?? GATEWAY_RETRIES;

  const authHeaders = (extra = {}) => ({
    Authorization: `Bearer ${apiKey}`,
    ...(storageType ? { "X-Storage-Type": storageType } : {}),
    ...extra,
  });

  /** Call the account API; a refusal carries the service's reason and a code. */
  const call = async (url, init = {}) => {
    const response = await fetch(url, init);
    if (!response.ok) {
      const path = url.replace(api, "");
      throw new BackendError(
        codeFor(response.status),
        `Lighthouse ${init.method || "GET"} ${path} failed: HTTP ${response.status} ${await reasonOf(response)}`.trim(),
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
      // dag/import unpacks a CAR and keeps the CIDs inside — opt-in, see carImport above.
      carImport,
      // A plain /api/v0/add is hashed by Lighthouse with its own chunker and always comes
      // back as UnixFS or raw -- never dag-cbor -- so an OrbitDB block cannot be stored
      // under its own CID here. Backups go up as a CAR.
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
      const isCar = carImport && (meta.car ?? type === CAR_MIME);

      // No path in the file's own name: backupDatabase names files `<space>/backup-…`,
      // and a Kubo-shaped add turns a path into folders and answers for those too. The
      // SDK sends the base name for the same reason. dag/import wants a .car name.
      const baseName = name.split("/").filter(Boolean).pop() || "blob";
      const fileName = isCar && !/\.car$/i.test(baseName) ? `${baseName}.car` : baseName;

      const form = new FormData();
      form.append("file", new File([bytes], fileName, { type }));

      const url = isCar
        ? `${node}/api/v0/dag/import`
        : `${node}/api/v0/add?wrap-with-directory=false&cid-version=1`;

      const response = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      if (!response.ok) {
        throw new BackendError(
          codeFor(response.status),
          `Lighthouse upload failed: HTTP ${response.status} ${await reasonOf(response)}`.trim(),
        );
      }

      const entries = parseEntries(await response.text());
      const data = entries.find((entry) => entry?.Name === fileName) ?? entries[0] ?? {};
      const cid = data.Hash || data.cid || data.Root?.Cid?.["/"];
      if (!cid) {
        throw new BackendError(
          "UNSUPPORTED",
          `Lighthouse accepted the upload but returned no CID: ${JSON.stringify(data).slice(0, 200)}`,
        );
      }

      return {
        id: cid,
        // Only an imported CAR comes back under a CID that is ours — its root. A plain
        // upload is hashed by Lighthouse, so its CID names their encoding of our bytes.
        ...(isCar ? { cid } : {}),
        backend: "lighthouse",
        size: Number(data.Size ?? bytes.length),
        raw: data,
      };
    },

    /** @type {import("./types.js").StorageBackend["getBlob"]} */
    getBlob: async (handle) => {
      const cid = handleId(handle);
      let response;
      // A 429 says "not now", not "not there": wait as told, a few times.
      for (let attempt = 0; ; attempt++) {
        response = await fetch(`${gateway}/ipfs/${cid}`);
        if (response.status !== 429 || attempt >= gatewayRetries) break;
        await response.body?.cancel();
        await sleep(retryWait(response, attempt));
      }
      if (!response.ok) {
        const reason = await reasonOf(response);
        throw new BackendError(
          "NOT_FOUND",
          `Lighthouse gateway did not serve ${cid}: HTTP ${response.status}` +
            (reason ? ` "${reason}"` : "") +
            (response.status === 402
              ? " (402 is what this gateway answers for content it does not hold)"
              : "") +
            (response.status === 429 ? ` (still rate limited after ${gatewayRetries} retries)` : ""),
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
            `No Lighthouse file found for ${cid} in the first page of the listing; pass the listed entry to delete it`,
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
