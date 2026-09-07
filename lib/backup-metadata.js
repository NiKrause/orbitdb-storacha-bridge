/**
 * What a backup's metadata is, with no dependencies at all.
 *
 * Split out of `backup-helpers.js` for one reason: that module logs, so
 * importing a *predicate* from it pulls in the logging framework and, through
 * it, `@libp2p/logger`. Fine in Node; measurable in a browser bundle, where
 * `restore-cid.js` exists precisely so that reading a backup costs almost
 * nothing (issue #58).
 *
 * Nothing here imports anything. That is the point, and it is worth keeping
 * true: anything added below that needs a logger belongs in `backup-helpers.js`
 * instead.
 */

/** Names are `<prefix>-metadata.json` and `<prefix>-blocks.car`. */
export function getBackupFilenames(prefix) {
  return { metadata: `${prefix}-metadata.json`, blocks: `${prefix}-blocks.car` };
}

/**
 * Whether this is metadata we can act on.
 *
 * Accepts both shapes deliberately: the pre-CAR `{ root, path }` databases and
 * the CAR-era `{ address, manifestCID }` ones. A reader that only handles one
 * of them checks for its own fields after this, so that "not a backup" and
 * "a backup of the other kind" stay different answers.
 */
export function isValidMetadata(metadata) {
  if (
    !metadata ||
    typeof metadata.version !== "string" ||
    typeof metadata.timestamp !== "number" ||
    !Array.isArray(metadata.databases)
  ) {
    return false;
  }
  return metadata.databases.every(
    (db) => Boolean(db?.root && db?.path) || Boolean(db?.address && db?.manifestCID),
  );
}
