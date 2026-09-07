/**
 * @fileoverview Aleph Cloud storage backend for OrbitDB Storacha Bridge
 *
 * The only backend here a browser can write to with no key at all. Probed on 2026-09-05:
 * `POST https://ipfs.aleph.cloud/api/v0/add` answers without authentication and returns
 * `access-control-allow-origin: *`, so a page can post to it directly, no relay, no proxy,
 * no token to leak.
 *
 * Two things that probe also established, and both are encoded below rather than left in
 * a comment:
 *
 *   - **Only `add` exists.** `dag/import`, `block/put`, `dag/put`, `pin/add` and `cat` all
 *     answer 404 on that host. So there is no way to write a dag-cbor block under its own
 *     CID; a backup goes up as one CAR and the inner CIDs come back when we unpack it.
 *   - **`add` is ingest, not persistence.** What keeps the bytes is a wallet-signed STORE
 *     message with the `ipfs` storage engine. A `putBlob` that only ingested would return
 *     a CID that looks like a successful backup and is not one, so this driver refuses to
 *     be built without a way to publish that message -- unless the caller says
 *     `ephemeral: true` and means it.
 *
 * And a STORE is not permanent either: Aleph rejects or removes one whose publisher runs
 * out of credits, with `balance_insufficient`. `list()` therefore reports status and
 * hides rejected stores by default, because a rejected store is not a backup.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 */

import { defineBackend, handleId, BackendError } from "./types.js";

const DEFAULT_NODE = "https://ipfs.aleph.cloud";
const DEFAULT_GATEWAY = "https://ipfs.aleph.cloud";
const DEFAULT_API = "https://api2.aleph.im";

/**
 * Create an Aleph Cloud backend.
 *
 * @param {object} options
 * @param {(cid: string, meta?: object) => Promise<object>} [options.publishStore] - publish
 *   the signed STORE message that makes the ingest persistent. Takes the CID, returns the
 *   Aleph message (or anything with `item_hash`). Signing needs a wallet, which is the
 *   caller's business -- `@le-space/browser` in relay-button already does this.
 * @param {(itemHash: string) => Promise<void>} [options.forget] - publish a FORGET message;
 *   supplying it is what makes this backend declare deletion.
 * @param {string} [options.address] - publisher address, needed to list
 * @param {boolean} [options.ephemeral=false] - allow ingest with no STORE message. The
 *   bytes reach an IPFS node and stay only as long as it feels like keeping them.
 * @param {string} [options.node] - IPFS ingest host
 * @param {string} [options.gateway]
 * @param {string} [options.api] - Aleph message API
 * @returns {import("./types.js").StorageBackend}
 */
export function createAlephBackend(options = {}) {
  const publishStore = options.publishStore;
  const forget = options.forget;
  const address = options.address;
  const ephemeral = options.ephemeral === true;

  if (!publishStore && !ephemeral) {
    throw new BackendError(
      "INVALID_BACKEND",
      "createAlephBackend needs publishStore to make an upload persistent. " +
        "Aleph's /api/v0/add only ingests: without a signed STORE message the bytes are " +
        "not pinned and the backup is not a backup. Pass { ephemeral: true } if that is " +
        "genuinely what you want.",
    );
  }

  const node = (options.node || DEFAULT_NODE).replace(/\/+$/, "");
  const gateway = (options.gateway || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const api = (options.api || DEFAULT_API).replace(/\/+$/, "");

  const backend = {
    name: "aleph",

    capabilities: {
      // The STORE message pins a CID that is already on IPFS, which is pin-by-CID in
      // everything but name -- but only when a signer was supplied.
      pinByCid: Boolean(publishStore),
      // No dag/import on this host.
      carImport: false,
      preservesInnerCids: false,
      // No key exists to leak. The STORE message is signed by the user's own wallet.
      browserSafeAuth: true,
      delegation: false,
      listing: Boolean(address),
      deletion: Boolean(forget),
      minBlobSize: 0,
    },

    /** @type {import("./types.js").StorageBackend["putBlob"]} */
    putBlob: async (bytes, meta = {}) => {
      const name = meta.name || "blob";
      const form = new FormData();
      form.append(
        "file",
        new File([bytes], name, {
          type: meta.type || "application/octet-stream",
        }),
      );

      const response = await fetch(`${node}/api/v0/add`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new BackendError(
          "NOT_FOUND",
          `Aleph ingest failed: HTTP ${response.status} ${await response.text().catch(() => "")}`.trim(),
        );
      }

      const data = await response.json();
      const cid = data.Hash || data.cid;
      if (!cid) {
        throw new BackendError(
          "NOT_FOUND",
          `Aleph accepted the upload but returned no hash: ${JSON.stringify(data).slice(0, 200)}`,
        );
      }

      const handle = {
        id: cid,
        cid,
        backend: "aleph",
        size: Number(data.Size ?? bytes.length),
        raw: data,
      };

      if (!publishStore) {
        // Ephemeral by explicit request. Say so on the handle so nothing downstream
        // mistakes this for a stored backup.
        return { ...handle, persistent: false };
      }

      const message = await publishStore(cid, meta);
      return {
        ...handle,
        persistent: true,
        itemHash: message?.item_hash || message?.itemHash,
        raw: { add: data, store: message },
      };
    },

    /** @type {import("./types.js").StorageBackend["getBlob"]} */
    getBlob: async (handle) => {
      const cid = handleId(handle);
      const response = await fetch(`${gateway}/ipfs/${cid}`);
      if (!response.ok) {
        throw new BackendError(
          "NOT_FOUND",
          `Aleph gateway did not serve ${cid}: HTTP ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };

  if (publishStore) {
    backend.pinCid = async (cid, meta = {}) => {
      const message = await publishStore(String(cid), meta);
      return {
        id: String(cid),
        cid: String(cid),
        backend: "aleph",
        persistent: true,
        itemHash: message?.item_hash || message?.itemHash,
        raw: message,
      };
    };
  }

  if (address) {
    backend.list = async (listOptions = {}) => {
      const url = new URL("/api/v0/messages.json", api);
      url.searchParams.set("msgTypes", "STORE");
      url.searchParams.set("addresses", address);
      url.searchParams.set(
        "message_statuses",
        listOptions.statuses || "processed",
      );
      url.searchParams.set("pagination", String(listOptions.limit || 100));
      url.searchParams.set("page", String(listOptions.page || 1));
      url.searchParams.set("sortOrder", "-1");

      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) {
        throw new BackendError(
          "NOT_FOUND",
          `Aleph message query failed: HTTP ${response.status}`,
        );
      }

      const payload = await response.json();
      return (payload?.messages || [])
        .map((message) => {
          const content = message?.content || {};
          const cid = content.item_hash;
          if (!cid) return null;
          return {
            id: cid,
            cid,
            backend: "aleph",
            size: content.size,
            itemHash: message.item_hash,
            status: message.confirmed === false ? "pending" : "processed",
            insertedAt: message.time
              ? new Date(message.time * 1000).toISOString()
              : undefined,
            raw: message,
          };
        })
        .filter(Boolean);
    };
  }

  if (forget) {
    backend.remove = async (handle) => {
      const itemHash =
        typeof handle === "object" ? handle?.itemHash : undefined;
      if (!itemHash) {
        throw new BackendError(
          "NOT_FOUND",
          "Aleph forgets a message, not a CID: pass the handle from putBlob, which carries itemHash",
        );
      }
      await forget(itemHash);
    };
  }

  return defineBackend(backend);
}

export default createAlephBackend;
