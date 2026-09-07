/**
 * @fileoverview Backup strategy selection
 *
 * Whether a backup goes up as loose blocks or as one CAR is not a preference, it is a
 * question the backend answers. These tests pin the answers, using capability sets that
 * describe real backends: Storacha stored exactly the bytes it was handed, Filecoin
 * Onchain Cloud rejects anything under 127 bytes and addresses pieces rather than blocks.
 *
 * @author @NiKrause
 * @requires ../../lib/orbitdb-storacha-bridge.js
 */

import { chooseBackupStrategy } from "../../lib/orbitdb-storacha-bridge.js";
import { createMemoryBackend } from "../../lib/backends/memory.js";

/** A backend that stores what it is given, under the CID we computed. */
const blockCapable = {
  name: "storacha-like",
  capabilities: { preservesInnerCids: true, minBlobSize: 0 },
};

/** Piece-addressed, 127-byte minimum: an OrbitDB entry does not fit. */
const pieceAddressed = {
  name: "foc-like",
  capabilities: { preservesInnerCids: false, minBlobSize: 127 },
};

/** Stores our bytes faithfully but still has a floor. */
const faithfulButPicky = {
  name: "picky",
  capabilities: { preservesInnerCids: true, minBlobSize: 127 },
};

describe("chooseBackupStrategy", () => {
  test("auto uploads blocks when the backend can hold them", () => {
    expect(chooseBackupStrategy(blockCapable)).toBe("blocks");
    expect(chooseBackupStrategy(createMemoryBackend())).toBe("blocks");
  });

  test("auto falls back to a CAR when the backend is piece-addressed", () => {
    expect(chooseBackupStrategy(pieceAddressed)).toBe("car");
  });

  test("a minimum size is enough on its own to force a CAR", () => {
    // Faithful storage does not help if an OrbitDB entry is below the floor.
    expect(chooseBackupStrategy(faithfulButPicky)).toBe("car");
  });

  test('asking for "blocks" on a backend that cannot is an error, not a silent CAR', () => {
    expect(() => chooseBackupStrategy(pieceAddressed, "blocks")).toThrow(
      /cannot store OrbitDB blocks individually/,
    );
    // and the error says what to do instead
    expect(() => chooseBackupStrategy(pieceAddressed, "blocks")).toThrow(
      /strategy: "car"/,
    );
  });

  test('"car" is always available', () => {
    expect(chooseBackupStrategy(pieceAddressed, "car")).toBe("car");
    expect(chooseBackupStrategy(blockCapable, "car")).toBe("car");
  });

  test("a backend that declares nothing gets a CAR", () => {
    // Defaults are all false, so an unspecific driver is treated as the careful case.
    expect(chooseBackupStrategy({ name: "vague", capabilities: {} })).toBe(
      "car",
    );
  });
});
