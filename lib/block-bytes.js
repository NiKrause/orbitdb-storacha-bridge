/**
 * @fileoverview Read a block's bytes from any Helia blockstore.
 *
 * `interface-blockstore` 7 — what Helia 6 and later hand out — streams a block
 * in chunks: `blockstore.get(cid)` returns an async iterable rather than a
 * promise of the bytes. Code written for the earlier interface still runs,
 * `await`s the iterable, and passes an object where bytes belong; the decode
 * after it fails far from the cause. This reads both.
 *
 * Imports nothing, so the light restore path can use it without pulling in a
 * node stack.
 */

/**
 * @param {{ get: (cid: any, options?: object) => any }} blockstore
 * @param {any} cid
 * @param {object} [options] - passed through, e.g. `{ signal }`
 * @returns {Promise<Uint8Array>}
 */
export async function readBlockBytes(blockstore, cid, options) {
  const result = blockstore.get(cid, options);
  if (result == null || typeof result[Symbol.asyncIterator] !== "function") {
    return await result;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of result) {
    chunks.push(chunk);
    length += chunk.length;
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
