/**
 * @fileoverview In-process storage backend for OrbitDB Storacha Bridge
 *
 * The reference driver: everything the contract asks for, nothing a network can add.
 * It exists so the conformance suite has a baseline that cannot fail for reasons of
 * its own, and so demos and tests can run a full backup/restore cycle with no service,
 * no credentials and no wallet.
 *
 * Ids are real CIDs — raw codec, sha-256 — so a caller that treats the id as content
 * addressed is not learning a habit that only works here.
 *
 * @author @NiKrause
 * @requires ./types.js - the backend contract
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { defineBackend, handleId, BackendError } from "./types.js";

/**
 * Create an in-process backend.
 *
 * @param {object} [options]
 * @param {Map<string, Uint8Array>} [options.store] - bring your own map to inspect it from a test
 * @param {(cid: string) => Promise<Uint8Array|null>} [options.resolve] - when given, the
 *   backend can pin by CID: `pinCid()` calls this to fetch the bytes, the way a real
 *   pinning service fetches from the IPFS network. Declaring `pinByCid` follows from it.
 * @returns {import("./types.js").StorageBackend}
 */
export function createMemoryBackend(options = {}) {
  const store = options.store || new Map();
  const resolve = options.resolve;

  const put = async (bytes, meta = {}) => {
    const digest = await sha256.digest(bytes);
    const cid = CID.create(1, raw.code, digest).toString();
    // Copied, not referenced. A real backend serialises the bytes onto a wire,
    // so a caller can reuse its buffer afterwards without touching what was
    // stored; holding the caller's array here would make this driver the one
    // place that behaves differently, and it is the driver every other one is
    // measured against.
    store.set(cid, bytes.slice());
    return {
      id: cid,
      cid,
      backend: "memory",
      size: bytes.length,
      ...(meta.name ? { name: meta.name } : {}),
    };
  };

  const backend = {
    name: "memory",

    capabilities: {
      pinByCid: Boolean(resolve),
      carImport: false,
      // the bytes are handed back exactly as they arrived, keyed by their own
      // hash — and by copy, so "exactly as they arrived" survives a caller that
      // reuses its buffer
      preservesInnerCids: true,
      browserSafeAuth: true,
      delegation: false,
      listing: true,
      deletion: true,
      minBlobSize: 0,
    },

    putBlob: put,

    getBlob: async (handle) => {
      const id = handleId(handle);
      const bytes = store.get(id);
      if (!bytes) {
        throw new BackendError("NOT_FOUND", `No blob for ${id}`);
      }
      // Likewise on the way out: what the caller does to this must not reach
      // back into the store.
      return bytes.slice();
    },

    list: async () =>
      Array.from(store.entries()).map(([cid, bytes]) => ({
        id: cid,
        cid,
        backend: "memory",
        size: bytes.length,
      })),

    remove: async (handle) => {
      store.delete(handleId(handle));
    },
  };

  if (resolve) {
    backend.pinCid = async (cid, meta = {}) => {
      const key = String(cid);
      const bytes = await resolve(key);
      if (!bytes) {
        throw new BackendError("NOT_FOUND", `Cannot resolve ${cid} to pin it`);
      }

      // Pinning stores the bytes under the CID it was handed. Re-deriving one here
      // would silently re-code the block -- a dag-cbor entry pinned as raw keeps its
      // digest and loses its codec, which reads as success and restores as garbage.
      const parsed = CID.parse(key);
      if (parsed.multihash.code !== sha256.code) {
        throw new BackendError(
          "UNSUPPORTED",
          `${cid} is not sha-256 addressed; this backend cannot verify it`,
        );
      }
      const rehashed = CID.create(
        parsed.version,
        parsed.code,
        await sha256.digest(bytes),
      );
      if (rehashed.toString() !== key) {
        throw new BackendError(
          "NOT_FOUND",
          `Resolved bytes for ${cid} do not hash to it`,
        );
      }

      store.set(key, bytes);
      return {
        id: key,
        cid: key,
        backend: "memory",
        size: bytes.length,
        ...(meta.name ? { name: meta.name } : {}),
      };
    };
  }

  return defineBackend(backend);
}

export default createMemoryBackend;
