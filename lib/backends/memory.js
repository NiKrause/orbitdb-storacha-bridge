/**
 * A backend that stores bytes in a Map.
 *
 * Not a toy: it is the reference implementation of {@link StorageBackend}, and
 * the reason the conformance suite is itself tested. A suite with no driver
 * that passes it proves nothing about the suite, and the phase this belongs to
 * (#54) exists precisely so the later drivers are cheap — which they only are
 * if the thing they must satisfy is known to be satisfiable.
 *
 * It is also the honest ceiling for what a backend can promise. Bytes go in and
 * come out identical because nothing happens to them in between, so it declares
 * `preservesInnerCids: true` and the suite's CAR round trip must pass here
 * before it is worth running anywhere else. What it cannot claim is everything
 * that needs a network: no `pinByCid`, no delegation.
 *
 * @module backends/memory
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { UnsupportedOperationError } from "./types.js";

/**
 * @param {Object} [options]
 * @param {boolean} [options.deletion=true] Declare and honour `remove()`. Set
 *   false to stand in for a permanent archive, which is a real class of backend
 *   and one the suite should be able to exercise.
 * @param {boolean} [options.listing=true] As above, for `list()`.
 * @returns {import("./types.js").StorageBackend & { size: number }}
 */
export function createMemoryBackend({ deletion = true, listing = true } = {}) {
  /** @type {Map<string, { bytes: Uint8Array, cid: string, storedAt: Date }>} */
  const store = new Map();

  /** Handles are content addresses here, so storing twice is storing once. */
  const addressOf = async (bytes) => {
    const digest = await sha256.digest(bytes);
    return CID.create(1, raw.code, digest).toString();
  };

  // A handle may be passed whole or as its id; both mean the same lookup, and
  // insisting on one of them would only make callers unwrap and rewrap.
  const idOf = (handle) => (typeof handle === "string" ? handle : handle?.id);

  return {
    name: "memory",

    capabilities: {
      pinByCid: false,
      carImport: false,
      // Nothing happens to the bytes, so this is true by construction rather
      // than by promise — which is the only way it is ever really true.
      preservesInnerCids: true,
      browserSafeAuth: true,
      delegation: false,
      listing,
      deletion,
    },

    async putBlob(bytes, meta = {}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("putBlob wants a Uint8Array");
      const id = await addressOf(bytes);
      const record = {
        // Copied, so a caller reusing its buffer cannot rewrite what we hold —
        // the kind of bug that only shows up under load and looks like
        // corruption at the far end.
        bytes: bytes.slice(),
        cid: meta.cid ?? id,
        storedAt: new Date(),
      };
      store.set(id, record);
      return { id, cid: record.cid, size: record.bytes.length, storedAt: record.storedAt };
    },

    async getBlob(handle) {
      const id = idOf(handle);
      const record = store.get(id);
      if (!record) throw new Error(`memory backend holds nothing under ${id}`);
      return record.bytes.slice();
    },

    async list({ limit } = {}) {
      if (!listing) throw new UnsupportedOperationError("memory", "list");
      const all = [...store.entries()].map(([id, record]) => ({
        id,
        cid: record.cid,
        size: record.bytes.length,
        storedAt: record.storedAt,
      }));
      return typeof limit === "number" ? all.slice(0, limit) : all;
    },

    async remove(handle) {
      if (!deletion) throw new UnsupportedOperationError("memory", "remove");
      return store.delete(idOf(handle));
    },

    /** Not part of the interface — for tests that want to look inside. */
    get size() {
      return store.size;
    },
  };
}
