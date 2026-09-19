/**
 * Put a database somewhere a second device can find it, and get it back.
 *
 * Two calls, and between them nothing but a secret both devices can produce —
 * a passkey's PRF output, in the case this was written for
 * ([funkpost#93](https://github.com/NiKrause/funkpost/issues/93)):
 *
 *     // the device that still has the database, while it has internet
 *     await dehydrate({ orbitdb, address, seed, backend })
 *
 *     // any device holding the same seed, later, knowing nothing else
 *     const { db } = await hydrate({ orbitdb, seed })
 *
 * What makes that work is that the *name* is computed rather than remembered:
 * `derivePointerKey` stretches the seed into a key, the IPNS name follows from
 * the key, and the pointer under that name says where the backup is. The
 * second device needs no CID, no address, no file — see `pointer-ipns.js`.
 *
 * **There is no encrypted identity archive here, and that is not an
 * oversight.** The design this follows kept one because the signing key was
 * generated at random and therefore had to be carried. A key *derived* from
 * the same PRF output does not: the device recomputes it, the access
 * controller recognises it, and there is nothing to keep secret in the open.
 * Deriving it is the identity provider's business, not this module's — the
 * seed arrives here as bytes for a name, and nothing about who holds it.
 *
 * What this inherits from the pieces underneath, and says plainly rather than
 * hiding: a pointer lives as long as the routing endpoints keep it, and a
 * backup as long as the storage backend keeps it. Aleph takes an upload
 * without an account and keeps it without a promise. For a device that comes
 * back in a week this is enough; for an archive it is not.
 */

import {
  derivePointerKey,
  publishPointer,
  resolvePointer,
  DEFAULT_ENDPOINTS,
} from "./pointer-ipns.js";
import logger from "./logger.js";

/**
 * Back the database up and publish a pointer to it under a name the seed
 * derives.
 *
 * @param {Object} params
 * @param {Object} params.orbitdb
 * @param {string} params.address Database address to back up.
 * @param {Uint8Array} params.seed Secret bytes both devices can produce.
 * @param {string} [params.label] Distinguishes several pointers of one seed.
 * @param {Object} [params.backend] Storage backend (Aleph, Pinata, …).
 * @param {string[]} [params.endpoints] Routing endpoints to publish to.
 * @param {bigint|number} [params.sequence] Overrides the default, which is
 *   seconds since the epoch — monotonic, and readable in a log.
 * @param {Object} [params.backup] Extra options for `backupDatabaseCAR`.
 * @returns {Promise<{name: string, metadataCID: string, carCID: string, sequence: bigint, blocks: number}>}
 */
export async function dehydrate({
  orbitdb,
  address,
  seed,
  label,
  backend,
  endpoints = DEFAULT_ENDPOINTS,
  sequence,
  backup = {},
}) {
  if (!address) throw new Error("dehydrate needs the database address");
  const { backupDatabaseCAR } = await import("./backup-car.js");

  const result = await backupDatabaseCAR(orbitdb, address, {
    backend,
    ...backup,
  });
  if (!result?.success) {
    throw new Error(`the backup failed: ${result?.error ?? "no reason given"}`);
  }
  const metadataCID = result.backupFiles?.metadataCID;
  if (!metadataCID)
    throw new Error("the backup named no metadata CID to point at");

  const privateKey = await derivePointerKey(seed, { label });
  const published = await publishPointer({
    privateKey,
    cid: metadataCID,
    endpoints,
    ...(sequence === undefined ? {} : { sequence }),
  });

  logger.info(`💧 dehydrated ${address} → ${published.name}`);
  return {
    name: published.name,
    metadataCID,
    carCID: result.backupFiles?.carCID,
    sequence: published.sequence,
    blocks: result.blocksTotal ?? 0,
  };
}

/**
 * Find the pointer the seed names, and restore what it points at.
 *
 * The database comes back open. It replaces any handle the caller had for the
 * same address: `restoreFromCID` opens it itself, and writing through an older
 * handle fails once this one exists.
 *
 * @param {Object} params
 * @param {Object} params.orbitdb
 * @param {Uint8Array} params.seed
 * @param {string} [params.label]
 * @param {string[]} [params.endpoints]
 * @param {Object} [params.open] Options for `orbitdb.open` — a node without a
 *   pubsub service needs `{ sync: false }`.
 * @param {Object} [params.restore] Extra options for `restoreFromCID`.
 * @returns {Promise<{db: Object, address: string, name: string, metadataCID: string, blocks: number, entries: number|null}>}
 */
export async function hydrate({
  orbitdb,
  seed,
  label,
  endpoints = DEFAULT_ENDPOINTS,
  open = {},
  restore = {},
}) {
  const privateKey = await derivePointerKey(seed, { label });
  const pointer = await resolvePointer({ privateKey, endpoints });

  const { restoreFromCID } = await import("./restore-cid.js");
  const result = await restoreFromCID(orbitdb, {
    metadataCID: pointer.cid,
    open,
    ...restore,
  });

  logger.info(
    `💦 hydrated ${pointer.name} → ${result.address ?? "a database"}`,
  );
  return {
    db: result.database,
    address: result.address,
    name: pointer.name,
    metadataCID: pointer.cid,
    blocks: result.blocks,
    entries: result.entries,
  };
}
