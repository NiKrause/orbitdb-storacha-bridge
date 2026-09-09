/**
 * @fileoverview The STORE message: what gets signed, and what does not get seen.
 *
 * Two properties matter more than the wire format, and both are easy to lose
 * in a later refactor without anything turning red:
 *
 * 1. **The library never sees a key.** `sign` is called with an address and a
 *    string, and nothing else is ever handed to it or read from it.
 * 2. **A 202 is not a promise.** Aleph accepts the message before checking the
 *    signature or the balance, so reporting it as kept would be exactly the lie
 *    this module was written to avoid.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  buildStoreMessage,
  signaturePayload,
  createAlephPin,
  DEFAULT_ALEPH_CHANNEL,
} from "../../lib/backends/aleph-pin.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import { BackendError } from "../../lib/backends/types.js";

jest.setTimeout(30_000);

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const CID = "QmXFP7bcUKHowZN2faFrEdiABN1E6raBiRsQbGCtb5Fnwn";
const SIGNATURE = "0x" + "ab".repeat(65);

/** A fetch that records what it was asked to do and answers like Aleph. */
function recordingFetch(response = { status: 202, body: { message_status: "pending" } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe("the STORE message", () => {
  test("is the envelope relay-button already posts, with a different type", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1_757_000_000 });

    expect(message.chain).toBe("ETH");
    expect(message.type).toBe("STORE");
    expect(message.item_type).toBe("inline");
    expect(message.channel).toBe(DEFAULT_ALEPH_CHANNEL);

    // The hash is over the serialised content, and it is hex sha-256. Checked
    // against node's own implementation rather than against itself.
    const expected = createHash("sha256").update(message.item_content).digest("hex");
    expect(message.item_hash).toBe(expected);
  });

  test("names the CID in the content, where the meaning of the fields flips", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1 });
    const content = JSON.parse(message.item_content);

    expect(content.address).toBe(ADDRESS);
    // In the envelope, `item_type: inline` means "the body is here". In the
    // content it means "the thing to keep is an IPFS CID" — same name, other
    // subject, and the reason this test exists.
    expect(content.item_type).toBe("ipfs");
    expect(content.item_hash).toBe(CID);
    expect(message.item_type).toBe("inline");
  });

  test("what the wallet puts its name to is four fields, in order", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1 });
    expect(signaturePayload(message)).toBe(
      ["ETH", ADDRESS, "STORE", message.item_hash].join("\n"),
    );
  });
});

describe("pinning", () => {
  test("hands the signer an address and a string, and nothing else", async () => {
    const seen = [];
    const sign = async (...args) => {
      seen.push(args);
      return SIGNATURE;
    };
    const fetchImpl = recordingFetch();

    const pin = createAlephPin({ sender: ADDRESS, sign, fetch: fetchImpl });
    await pin(CID);

    expect(seen).toHaveLength(1);
    const [address, payload] = seen[0];
    expect(address).toBe(ADDRESS);
    expect(typeof payload).toBe("string");
    // The property, stated as an assertion: nothing beyond those two arguments
    // is offered to the signer, so there is nothing for it to leak back.
    expect(seen[0]).toHaveLength(2);
  });

  test("posts the signed message to the messages endpoint", async () => {
    const fetchImpl = recordingFetch();
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: fetchImpl,
    });

    const result = await pin(CID);

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, body } = fetchImpl.calls[0];
    expect(url).toBe("https://api2.aleph.im/api/v0/messages");
    expect(body.message.signature).toBe(SIGNATURE);
    expect(body.message.type).toBe("STORE");
    expect(result.itemHash).toBe(body.message.item_hash);
  });

  test("a bare signature is 0x-prefixed, because Aleph wants one", async () => {
    const fetchImpl = recordingFetch();
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => "ab".repeat(65),
      fetch: fetchImpl,
    });
    await pin(CID);
    expect(fetchImpl.calls[0].body.message.signature).toBe(SIGNATURE);
  });

  test("202 is reported as pending, not as kept", async () => {
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: recordingFetch({ status: 202, body: { message_status: "pending" } }),
    });

    // Aleph takes the message before it checks the signature or the balance.
    // Anything that reads as "done" here would be a promise nobody made.
    await expect(pin(CID)).resolves.toMatchObject({ status: "pending" });
  });

  test("a refusal is an error, with what the service said", async () => {
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: recordingFetch({ status: 422, body: { details: "InvalidMessageFormat" } }),
    });
    await expect(pin(CID)).rejects.toThrow(/refused the STORE message: 422/);
  });

  test("it refuses to be built without the things it cannot work without", () => {
    expect(() => createAlephPin({ sign: async () => "" })).toThrow(BackendError);
    expect(() => createAlephPin({ sender: ADDRESS })).toThrow(/sign/);
  });
});

describe("wired into the backend", () => {
  test("supplying pin is what declares pinByCid — and omitting it is honest", async () => {
    const withWallet = createAlephBackend({
      pin: createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: recordingFetch() }),
    });
    expect(withWallet.capabilities.pinByCid).toBe(true);
    expect(typeof withWallet.pinCid).toBe("function");

    const without = createAlephBackend();
    expect(without.capabilities.pinByCid).toBe(false);
    expect(without.pinCid).toBeUndefined();
  });

  test("a pinned handle says our CID survived, and that it is retained", async () => {
    const backend = createAlephBackend({
      pin: createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: recordingFetch() }),
    });

    const handle = await backend.pinCid(CID);
    // Pin-by-CID is the one path where the id *is* ours, because we gave it.
    expect(handle.id).toBe(CID);
    expect(handle.cid).toBe(CID);
    expect(handle.retained).toBe(true);
  });
});
