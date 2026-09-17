/**
 * @fileoverview Pinata storage backend for OrbitDB Storacha Bridge
 *
 * Pinata is the only evaluated backend that can both take a CAR and pin a CID that is
 * already on IPFS, and those are the two shapes this library wants. Pinning by CID is the
 * better one: we already run Helia, so `pinCid()` moves no bytes through a vendor API and
 * the hashes cannot drift, because nobody but us ever computed them.
 *
 * Both are paid-plan features, so both are opt-in (`pinByCid`, `carImport`). Measured on
 * the free plan on 2026-09-17: uploads, listing and deletion work, a CAR goes up as a plain
 * file and comes back byte for byte, and pin by CID answers 403 "not supported by the
 * current plan type".
 *
 * No SDK dependency -- the v3 API is three documented endpoints and `fetch`, which keeps
 * the package lean and works unchanged in the browser.
 *
 * Two modes, and the capability set says which one you got:
 *
 *   - **with a JWT** — full backend: upload, list, delete, and pin by CID on a paid plan.
 *     The JWT is a bearer secret, so `browserSafeAuth` is false; this belongs on a relay or
 *     in Node.
 *   - **with `getUploadUrl`** — a presigned upload URL minted elsewhere. Nothing secret
 *     reaches the browser, so `browserSafeAuth` is true, but the operations that need the
 *     account key are gone and the driver declares them gone rather than failing later.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 * @see {@link https://docs.pinata.cloud/files/uploading-files} for the CAR upload rules
 */

/* global FormData, URLSearchParams */

import { defineBackend, handleId, BackendError } from "./types.js";

const DEFAULT_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const DEFAULT_API_URL = "https://api.pinata.cloud/v3";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud";

/** Pinata treats a CAR upload as a CAR only when told to. */
const CAR_MIME = "application/vnd.ipld.car";

/** How often a gateway 429 is waited out before it counts as a failure. */
const GATEWAY_RETRIES = 4;
/** The longest single wait, whatever Retry-After asks for. */
const MAX_RETRY_WAIT_MS = 30_000;

/** Pinata's words for a feature the account's plan does not include. */
const PLAN_REFUSAL = /not supported by the current plan/i;

/**
 * What a refusal means to a caller: a plan without the feature is "cannot", a key Pinata
 * rejects or has not scoped for the call is a misconfigured backend, and only a 404 is
 * "not there".
 */
const codeFor = (status, detail) => {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || (status === 403 && !PLAN_REFUSAL.test(detail))) {
    return "INVALID_BACKEND";
  }
  return "UNSUPPORTED";
};

/** Retry-After when the gateway sends one, otherwise doubling from a second. */
const retryWait = (response, attempt) => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A gateway as a URL. Pinata's dashboard lists gateways as bare domains
 * (`<name>.mypinata.cloud`), and one pasted as shown would otherwise reach
 * `fetch` without a scheme and fail every read with "Invalid URL".
 */
const gatewayUrl = (value) => {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * Create a Pinata backend.
 *
 * @param {object} options
 * @param {string} [options.jwt] - Pinata JWT; falls back to PINATA_JWT
 * @param {() => Promise<string>} [options.getUploadUrl] - mint a presigned upload URL
 *   instead of holding a JWT. Uploads only; see the note above.
 * @param {string} [options.gateway] - retrieval gateway: `https://<name>.mypinata.cloud`, or
 *   the bare domain as Pinata's dashboard shows it. The account's dedicated gateway is
 *   strongly preferred: the shared one rate limits with 429s, which are waited out, but slowly
 * @param {number} [options.gatewayRetries=4] - how often a gateway 429 is waited out
 * @param {"public"|"private"} [options.network="public"] - CAR uploads are public only
 * @param {boolean} [options.pinByCid=false] - offer `pinCid()`. Paid plans only; the free
 *   plan refuses it with 403, so it is declared only when asked for.
 * @param {boolean} [options.carImport=false] - send CARs with `car=true`, so Pinata unpacks
 *   and indexes the blocks. Paid plans only. Without it a CAR goes up as one opaque file,
 *   exactly as on Aleph, and comes back byte for byte for us to unpack.
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
  const gateway = gatewayUrl(options.gateway || DEFAULT_GATEWAY);
  const keyed = Boolean(jwt);
  const carImport = options.carImport === true;
  const pinByCid = keyed && options.pinByCid === true;
  const gatewayRetries = options.gatewayRetries ?? GATEWAY_RETRIES;

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
      const detail = await response.text().catch(() => "");
      throw new BackendError(
        codeFor(response.status, detail),
        `Pinata ${init.method || "GET"} ${path} failed: HTTP ${response.status} ${detail}`.trim() +
          (PLAN_REFUSAL.test(detail) ? " (a paid-plan feature)" : ""),
      );
    }
    return response.status === 204 ? null : response.json();
  };

  const backend = {
    name: "pinata",

    capabilities: {
      // Paid plans only — the free plan answers 403 — so declared only when asked for.
      pinByCid,
      // A CAR uploaded with car=true is unpacked and its blocks indexed — paid plans only,
      // so it is opt-in. The free plan stores the CAR as a file, which is all a backup needs.
      carImport,
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
      const isCar = carImport && (meta.car ?? type === CAR_MIME);

      const form = new FormData();
      // The file's own name must not carry a path. backupDatabase names files
      // `<space>/backup-…`, and Pinata turns a path into a folder and answers with
      // the folder's CID, which a gateway serves as an HTML listing. The full name
      // still goes up as the upload's `name`.
      const fileName = name.split("/").filter(Boolean).pop() || "blob";
      form.append("file", new File([bytes], fileName, { type }));
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
          codeFor(response.status, detail),
          `Pinata upload failed: HTTP ${response.status} ${detail}`.trim() +
            (isCar
              ? " (CAR import needs a paid plan, the public network, and a single root CID)"
              : ""),
        );
      }

      const body = await response.json();
      const data = body?.data || body;
      return {
        id: data.cid,
        // Only an imported CAR comes back under a CID that is ours — its root. A file
        // upload is hashed by Pinata's own chunker, so like Aleph's it names their
        // encoding of our bytes, and the handle does not pretend otherwise.
        ...(isCar ? { cid: data.cid } : {}),
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
      let response;
      // A 429 says "not now", not "not there": wait as told, a few times.
      for (let attempt = 0; ; attempt++) {
        response = await fetch(`${gateway}/ipfs/${cid}`);
        if (response.status !== 429 || attempt >= gatewayRetries) break;
        await response.body?.cancel();
        await sleep(retryWait(response, attempt));
      }
      if (!response.ok) {
        // A gateway says why it refused ("… not pinned to their Pinata account.
        // - ERR_ID:00006"); a status code alone does not.
        const reason = (await response.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        throw new BackendError(
          "NOT_FOUND",
          `Pinata gateway did not serve ${cid}: HTTP ${response.status}` +
            (reason ? ` "${reason}"` : "") +
            (response.status === 404
              ? " (a CAR upload is processed asynchronously; it may not be indexed yet)"
              : "") +
            (response.status === 429
              ? ` (still rate limited after ${gatewayRetries} retries` +
                (gateway === DEFAULT_GATEWAY
                  ? "; the shared gateway is for testing, pass the account's dedicated gateway as `gateway`)"
                  : ")")
              : ""),
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };

  if (pinByCid) {
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
        // The id of the pin *request* in Pinata's queue. The file it becomes gets an id
        // of its own once retrieved, so this is deliberately not `fileId`: remove() then
        // resolves the file by CID instead of deleting by an id that names something else.
        requestId: data.id,
        // "prechecking" or "retrieving": Pinata has accepted the job, not finished it.
        status: data.status,
        raw: data,
      };
    };
  }

  if (keyed) {
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
