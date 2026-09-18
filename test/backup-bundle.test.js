/**
 * What a browser pays to back up.
 *
 * `backup-car.js` used to import the main entry, which imports
 * `@storacha/client` at the top — so a page that backs up to Aleph carried the
 * whole Storacha SDK. Measured in a real bundle: 88 kB gzipped, a fifth of the
 * mesh demo. Issue #58 fixed the same thing for restoring; this holds the line
 * for backing up.
 *
 * A static walk, not a bundler: what a bundler puts in the page is exactly the
 * graph of static imports, and `await import(...)` is what keeps the
 * Storacha-only paths out of it.
 */
import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../lib");

/** Every module a bundler would pull in for this entry, following static imports only. */
function staticImportGraph(entry) {
  const seen = new Set();
  const queue = [resolve(LIB, entry)];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // a package, not a file of ours — recorded by name below
    }

    // `import … from "x"`, `export … from "x"`, and bare `import "x"`, but not
    // `await import("x")`, which a bundler splits off.
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)]
      .map((match) => match[1])
      .concat(
        [...source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map((match) => match[1]),
      );

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
      } else {
        seen.add(specifier); // a package name, kept as itself
      }
    }
  }

  return seen;
}

describe("what the backup path pulls in", () => {
  test("backing up does not reach the Storacha client", () => {
    const graph = staticImportGraph("backup-car.js");
    const storacha = [...graph].filter((id) => id.startsWith("@storacha/") || id.startsWith("@ucanto/"));

    expect(storacha).toEqual([]);
  });

  test("restoring from a CID does not either", () => {
    const graph = staticImportGraph("restore-cid.js");
    const storacha = [...graph].filter((id) => id.startsWith("@storacha/") || id.startsWith("@ucanto/"));

    expect(storacha).toEqual([]);
  });

  test("the walk does find it where it really is", () => {
    // The control: the main entry does import the client, and if this stops
    // being true the two assertions above would pass for the wrong reason.
    const graph = staticImportGraph("orbitdb-storacha-bridge.js");

    expect([...graph]).toContain("@storacha/client");
  });
});
