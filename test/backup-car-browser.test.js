/**
 * CAR backups in a browser. Bundlers stand in for Node's `stream` with
 * stream-browserify, whose `Readable.from` throws. A CAR built through it fails
 * every browser backup before anything is uploaded, so the stand-in is used here.
 */
import { describe, it, expect, jest } from "@jest/globals";
import * as nodeStream from "node:stream";
import { CarReader } from "@ipld/car";
import * as Block from "multiformats/block";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";

// What stream-browserify 3 (readable-stream 3) does.
class BrowserReadable extends nodeStream.Readable {
  static from() {
    throw new Error("Readable.from is not available in the browser");
  }
}

jest.unstable_mockModule("stream", () => ({
  ...nodeStream,
  default: { ...nodeStream.default, Readable: BrowserReadable },
  Readable: BrowserReadable,
}));

const { createCARFromBlocks, readBlocksFromCAR } = await import(
  "../lib/backup-car.js"
);

describe("createCARFromBlocks with a browser's stream", () => {
  it("uses the stand-in", async () => {
    const { Readable } = await import("stream");
    expect(() => Readable.from([])).toThrow("not available in the browser");
  });

  it("builds a CAR that reads back block for block", async () => {
    const encoded = await Promise.all(
      [0, 1, 2, 3, 4].map((n) =>
        Block.encode({ value: { n }, codec: dagCbor, hasher: sha256 }),
      ),
    );
    const blocks = new Map(
      encoded.map((block) => [block.cid.toString(), { bytes: block.bytes }]),
    );
    const root = encoded[0].cid.toString();

    const carBytes = await createCARFromBlocks(blocks, root);

    const reader = await CarReader.fromBytes(carBytes);
    expect((await reader.getRoots()).map(String)).toEqual([root]);
    const readBack = await readBlocksFromCAR(carBytes);
    expect([...readBack.keys()]).toEqual([...blocks.keys()]);
    for (const [cid, { bytes }] of blocks) {
      expect(readBack.get(cid).bytes).toEqual(bytes);
    }
  });
});
