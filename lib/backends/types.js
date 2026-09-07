/**
 * The backend seam: what this library needs from whoever stores the bytes.
 *
 * Storacha did not degrade, it vanished — writes off 2026-05-15, endpoints gone
 * by September. The lesson recorded in #54 is not "pick a better provider", it
 * is that **in this library the provider is the volatile part and everything
 * else is ours**: around a surface of four operations sits ~7.4k lines of
 * OrbitDB work — block extraction, CID bridging, CAR packing, identity and
 * access-controller preservation, courier-sync — none of which cares who holds
 * the bytes. So the provider becomes a driver, and no single one of them can
 * take the project with it again.
 *
 * These are JSDoc types rather than classes on purpose: the repository is plain
 * JavaScript, a driver is an object literal with four functions, and nothing
 * here should need to be extended, only implemented.
 *
 * ## The one thing that must not be assumed
 *
 * **A handle is not a CID.** For Storacha it happened to be one —
 * `client.uploadFile()` returns something whose `.toString()` is a CID, and the
 * existing code passes that around as if that were the definition. It is not:
 *
 * | Class | How bytes move | Who computes the CID | Handle looks like |
 * | --- | --- | --- | --- |
 * | **Pin-by-CID** | they don't — we publish, the service fetches | us | the CID we gave it |
 * | **Blob push** | we push a CAR, get an opaque id | us, inside the CAR | a vendor id |
 * | **File push** | we push a file, the service hashes it | **them** | *their* CID |
 *
 * A backend of the third kind hands back a CID for content it chunked its own
 * way, which is not the CID of anything we know. Treating that as ours is how a
 * restore silently produces a database that is not the one that was backed up.
 * Hence {@link BlobHandle}: an opaque `id`, and a `cid` only where the backend
 * genuinely preserves ours.
 *
 * @module backends/types
 */

/**
 * What a backend gives back when it has stored something, and what it wants
 * back to find it again.
 *
 * @typedef {Object} BlobHandle
 * @property {string} id What this backend calls the thing. **Opaque.** Pass it
 *   back to `getBlob` or `remove`; do not parse it, and do not assume it is a
 *   CID even when it looks like one.
 * @property {string} [cid] Our CID for the bytes, present **only** when the
 *   backend preserved it — either because we told it the CID (`pinCid`) or
 *   because it stores blobs verbatim. Absent means "this backend re-chunked or
 *   renamed it", which is a fact about the backend, not a missing field.
 * @property {number} [size] Bytes, if the backend reports it.
 * @property {Date} [storedAt] When the backend says it took delivery.
 */

/**
 * What a driver can and cannot do, so the bridge picks a strategy instead of
 * hardcoding one — and so the conformance suite can be table-driven rather than
 * a pile of per-driver special cases.
 *
 * Every field is required, including the `false` ones. A capability that is
 * merely absent reads as an oversight; one that is explicitly `false` is a
 * statement, and the suite asserts against it either way.
 *
 * @typedef {Object} BackendCapabilities
 * @property {boolean} pinByCid The backend will fetch content we have already
 *   published to IPFS, given its CID — class 1 above. The best case: hashes are
 *   preserved by construction, no bytes cross a vendor API, and a browser needs
 *   one small authorised call.
 * @property {boolean} carImport The backend understands a CAR as a CAR rather
 *   than as an opaque file. Rarer than it sounds; not needed if we import the
 *   CAR back into Helia ourselves.
 * @property {boolean} preservesInnerCids Bytes come back **exactly** as they
 *   went in, so the CIDs inside a CAR survive the round trip. This is the one
 *   capability that must never be taken on trust: the conformance suite proves
 *   it by verifying every block against its own CID on the way back, which
 *   `CarReader` does not do (see `lib/restore-cid.js`).
 * @property {boolean} browserSafeAuth A browser can authenticate without
 *   holding a credential that would be an account takeover if leaked —
 *   a presigned URL, a per-user key, a wallet signature, or no key at all.
 * @property {boolean} delegation Authority can be handed to somebody else,
 *   time-bounded and revocable: a UCAN, a presigned URL, a session key.
 * @property {boolean} listing `list()` can enumerate what is stored. Restore
 *   discovery depends on it — a backend without it needs its pointer carried
 *   some other way.
 * @property {boolean} deletion `remove()` actually removes. A permanent archive
 *   may honestly answer `false` here.
 */

/**
 * Anything worth telling the backend about the bytes. All optional, all hints:
 * a driver may ignore every field, and none of them may change what is stored.
 *
 * @typedef {Object} BlobMeta
 * @property {string} [name] A filename, for backends that want one.
 * @property {string} [contentType] Defaults to `application/vnd.ipld.car` where
 *   a driver needs to state one, because that is what this library uploads.
 * @property {string} [cid] Our CID for these bytes, when we know it. A driver
 *   that preserves it should echo it back in the handle.
 */

/**
 * A storage backend.
 *
 * Four required operations and one optional, which is the whole surface this
 * library ever needed from Storacha — the other 25 call sites were identity and
 * space handling, and that is exactly the part that does not generalise and
 * stays inside a driver.
 *
 * @typedef {Object} StorageBackend
 * @property {string} name Short, stable, lowercase — `"storacha"`, `"pinata"`.
 *   Appears in errors and in the conformance suite's output.
 * @property {BackendCapabilities} capabilities
 * @property {(bytes: Uint8Array, meta?: BlobMeta) => Promise<BlobHandle>} putBlob
 *   Store bytes. The bytes are usually a CAR, and a driver must not re-encode,
 *   compress or re-chunk them.
 * @property {(handle: BlobHandle | string) => Promise<Uint8Array>} getBlob
 *   Retrieve bytes by handle, or by its `id`. **Must return exactly what was
 *   stored** when `capabilities.preservesInnerCids` is true.
 * @property {(options?: { limit?: number, cursor?: string }) => Promise<BlobHandle[]>} list
 *   What is stored. Required to exist; may throw
 *   {@link UnsupportedOperationError} when `capabilities.listing` is false.
 * @property {(handle: BlobHandle | string) => Promise<boolean>} remove
 *   Remove it. `false` means "it was not there", which is not an error. May
 *   throw {@link UnsupportedOperationError} when `capabilities.deletion` is
 *   false.
 * @property {((cid: string, meta?: BlobMeta) => Promise<BlobHandle>)} [pinCid]
 *   Ask the backend to fetch and hold content already published to IPFS.
 *   Present if and only if `capabilities.pinByCid`.
 */

/**
 * Thrown by an operation a backend does not have.
 *
 * A distinct type rather than a plain `Error` so that calling code can tell
 * "this backend cannot" from "this backend failed", which are different
 * decisions: the first picks another strategy, the second retries or gives up.
 */
export class UnsupportedOperationError extends Error {
  /**
   * @param {string} backend
   * @param {string} operation
   */
  constructor(backend, operation) {
    super(`The ${backend} backend does not support ${operation}`);
    this.name = "UnsupportedOperationError";
    this.backend = backend;
    this.operation = operation;
  }
}

/** Every capability flag a driver must declare, in one place. */
export const CAPABILITY_FLAGS = Object.freeze([
  "pinByCid",
  "carImport",
  "preservesInnerCids",
  "browserSafeAuth",
  "delegation",
  "listing",
  "deletion",
]);

/**
 * Whether an object is shaped like a backend — checked, not assumed.
 *
 * Deliberately strict about the capabilities: a missing flag is reported rather
 * than defaulted, because defaulting one to `false` would silently disable a
 * feature and defaulting it to `true` would silently promise one.
 *
 * @param {any} backend
 * @returns {string[]} what is wrong; empty means it is a backend
 */
export function checkBackend(backend) {
  const problems = [];
  if (!backend || typeof backend !== "object") return ["not an object"];
  if (typeof backend.name !== "string" || backend.name.length === 0) {
    problems.push("no name");
  }
  for (const fn of ["putBlob", "getBlob", "list", "remove"]) {
    if (typeof backend[fn] !== "function") problems.push(`no ${fn}()`);
  }
  const caps = backend.capabilities;
  if (!caps || typeof caps !== "object") {
    problems.push("no capabilities");
  } else {
    for (const flag of CAPABILITY_FLAGS) {
      if (typeof caps[flag] !== "boolean") problems.push(`capabilities.${flag} is not declared`);
    }
    // The one place where a capability and the surface must agree, because
    // getting it wrong means calling a function that is not there.
    if (caps.pinByCid && typeof backend.pinCid !== "function") {
      problems.push("claims pinByCid but has no pinCid()");
    }
    if (!caps.pinByCid && typeof backend.pinCid === "function") {
      problems.push("has pinCid() but does not claim pinByCid");
    }
  }
  return problems;
}
