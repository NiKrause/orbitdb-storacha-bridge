/**
 * @fileoverview Making Aleph keep something: the STORE message, and nothing else.
 *
 * `createAlephBackend` stores without a key and says plainly that it does not
 * retain. This is the other half — and it is deliberately a separate module,
 * because the two have different requirements and only one of them needs a
 * wallet. An application that only ever reads, or only ever uploads, should
 * never have to load this file.
 *
 * ## No tokens move
 *
 * The wallet **signs a string**. Aleph then checks that the signing address has
 * enough balance or credit to cover what it is being asked to keep. There is no
 * transaction, no gas and no transfer: the token is the evidence, not the
 * payment. Worth stating because "pay for storage with a wallet" reads as the
 * opposite.
 *
 * ## Injected, not imported
 *
 * `sign` has the shape of `personal_sign` — `(address, message) => signature` —
 * which is what a browser wallet provides and what a Node signer can wrap. So
 * this module imports no wallet, no SDK and no key, and **no key ever passes
 * through the library**. In a browser the key never leaves the wallet at all.
 *
 * ## The format, and where each part was established
 *
 * The envelope, the hash and the signing payload are taken from `relay-button`,
 * which posts INSTANCE and AGGREGATE messages through the same route:
 *
 *     item_content = JSON.stringify(content)
 *     item_hash    = sha256hex(item_content)
 *     signed       = sign(sender, [chain, sender, type, item_hash].join("\n"))
 *
 * The STORE *content* is the one part not in that codebase, and was confirmed
 * against `api2.aleph.im` on 2026-09-09 — a correctly shaped message with a
 * deliberately invalid signature is accepted with **202** and left pending,
 * which separates "the schema is wrong" from "the signature is wrong".
 *
 * One trap, since it costs nothing to name: the content carries its *own*
 * `item_type` and `item_hash`, and they mean something different from the
 * envelope's. In the envelope they say "the message body is inline". In the
 * content they say "the thing to keep is this IPFS CID".
 *
 * @author @NiKrause
 * @requires ./aleph.js - the backend this supplies `pin` to
 */

import { BackendError } from "./types.js";

export const DEFAULT_ALEPH_API_HOST = "https://api2.aleph.im";
export const DEFAULT_ALEPH_CHANNEL = "ALEPH-CLOUDSOLUTIONS";

/** Hex sha-256 of a string, via WebCrypto — present in browsers and in Node 18+. */
async function sha256Hex(payload) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the unsigned STORE message for a CID.
 *
 * Exported so it can be tested without a wallet, and read without running one.
 *
 * @param {object} args
 * @param {string} args.sender - the wallet address
 * @param {string} args.cid - what to keep
 * @param {string} [args.channel]
 * @param {number} [args.now] - seconds; injected so a test is not a clock
 * @param {(payload: string) => Promise<string>} [args.hasher]
 */
export async function buildStoreMessage({ sender, cid, channel = DEFAULT_ALEPH_CHANNEL, now, hasher = sha256Hex }) {
  const time = now ?? Date.now() / 1000;
  const content = {
    address: sender,
    // "the thing to keep is an IPFS CID" — not the envelope's item_type
    item_type: "ipfs",
    item_hash: cid,
    time,
  };
  const item_content = JSON.stringify(content);

  return {
    sender,
    chain: "ETH",
    type: "STORE",
    item_hash: await hasher(item_content),
    item_type: "inline",
    item_content,
    time,
    channel,
  };
}

/** What the wallet actually puts its name to. */
export const signaturePayload = (message) =>
  [message.chain, message.sender, message.type, message.item_hash].join("\n");

/**
 * A `pin` function for {@link createAlephBackend}.
 *
 * @param {object} options
 * @param {string} options.sender - the wallet address doing the keeping
 * @param {(address: string, message: string) => Promise<string>} options.sign -
 *   `personal_sign`, or anything shaped like it. The library never sees a key.
 * @param {string} [options.apiHost]
 * @param {string} [options.channel]
 * @param {(payload: string) => Promise<string>} [options.hasher]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now] - seconds
 * @returns {(cid: string, meta?: object) => Promise<{ itemHash: string, status: string }>}
 */
export function createAlephPin(options = {}) {
  const { sender, sign } = options;
  const apiHost = options.apiHost || DEFAULT_ALEPH_API_HOST;
  const channel = options.channel || DEFAULT_ALEPH_CHANNEL;
  const hasher = options.hasher || sha256Hex;
  const doFetch = options.fetch || globalThis.fetch;
  const now = options.now;

  if (!sender) throw new BackendError("INVALID_BACKEND", "createAlephPin needs the wallet address as `sender`");
  if (typeof sign !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs a `sign` function");
  if (typeof doFetch !== "function") throw new BackendError("INVALID_BACKEND", "createAlephPin needs fetch");

  return async function pin(cid) {
    const unsigned = await buildStoreMessage({ sender, cid, channel, hasher, now: now?.() });
    const signature = await sign(sender, signaturePayload(unsigned));
    const message = {
      ...unsigned,
      signature: signature.startsWith("0x") ? signature : `0x${signature}`,
    };

    const response = await doFetch(`${apiHost}/api/v0/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sync: true }),
    });

    // 202 means Aleph took the message, not that it kept the file: the
    // signature and the balance are checked afterwards. Reporting it as done
    // would be the exact lie this module exists to avoid, so the caller gets
    // the status it was given.
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      throw new BackendError(
        "UNSUPPORTED",
        `Aleph refused the STORE message: ${response.status} ${detail.slice(0, 200)}`,
      );
    }

    const body = await response.json().catch(() => ({}));
    return {
      itemHash: unsigned.item_hash,
      status: body?.message_status ?? "pending",
    };
  };
}

export default createAlephPin;
