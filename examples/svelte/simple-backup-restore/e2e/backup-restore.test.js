/**
 * A backup goes to Aleph and comes back on another node: Alice backs up her
 * todos, Bob restores them.
 *
 * The test plays Aleph — uploads are kept in memory and served back — and
 * refuses every other request that would leave this machine, so it also checks
 * that the demo needs nothing else. ALEPH_LIVE=1 uses the real Aleph instead.
 */
import { expect, test } from "@playwright/test";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

const LIVE = process.env.ALEPH_LIVE === "1";
const TODOS = [
  "Buy groceries for the week",
  "Walk the dog in the park",
  "Finish the OrbitDB project",
];
const CORS = { "access-control-allow-origin": "*" };

/** Aleph's ingest and gateway, in memory. */
async function standInForAleph(page) {
  const uploads = new Map();
  const refused = [];

  // Registered first, so it runs last: every request the routes below leave.
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => {
      const url = route.request().url();
      // Carbon's stylesheet names its fonts on IBM's CDN; the page does without.
      if (!/\.woff2?(\?|$)/.test(url)) refused.push(url);
      return route.abort();
    },
  );

  await page.route(
    (url) => url.hostname === "ipfs.aleph.cloud" && url.pathname === "/api/v0/add",
    async (route) => {
      const request = route.request();
      const form = await new Response(request.postDataBuffer(), {
        headers: { "content-type": await request.headerValue("content-type") },
      }).formData();
      const file = form.get("file");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = CID.create(1, raw.code, await sha256.digest(bytes)).toString();
      uploads.set(id, bytes);
      await route.fulfill({
        headers: CORS,
        contentType: "application/json",
        body: `${JSON.stringify({ Name: file.name, Hash: id, Size: String(bytes.length) })}\n`,
      });
    },
  );

  await page.route(
    (url) => url.hostname === "ipfs.aleph.cloud" && url.pathname.startsWith("/ipfs/"),
    async (route) => {
      const id = new URL(route.request().url()).pathname.slice("/ipfs/".length);
      const bytes = uploads.get(id);
      await route.fulfill(
        bytes
          ? { headers: CORS, contentType: "application/octet-stream", body: Buffer.from(bytes) }
          : { status: 404, headers: CORS, body: "not found" },
      );
    },
  );

  return { uploads, refused };
}

test("Alice backs up her todos to Aleph, and Bob restores them", async ({ page }) => {
  test.setTimeout(180_000);
  const aleph = LIVE ? null : await standInForAleph(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Use Aleph" }).click();
  await expect(page.getByTestId("storage-label")).toHaveText("Aleph");
  await page.getByText("Mnemonic Seed Phrase (Traditional)").click();

  await page.getByRole("button", { name: /^1\. Initialize Alice/ }).click();
  await expect(page.getByText("Alice's OrbitDB instance ready")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "2. Add Todos" }).click();
  await expect(page.getByText("Successfully added 3 todos")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "3. Backup to Aleph" }).click();
  // Three entries, the manifest, the access controller, and the identity that
  // signed the entries.
  await expect(page.getByText("Backup created on Aleph: 6 blocks in one CAR")).toBeVisible({
    timeout: 30_000,
  });
  if (aleph) expect(aleph.uploads.size).toBe(2); // the CAR and its metadata

  await page.getByRole("button", { name: /^1\. Initialize Bob/ }).click();
  await expect(page.getByText(/Bob's OrbitDB instance ready/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "2. Restore from Aleph" }).click();
  await expect(page.getByText(/Database restored from Aleph: 3 todos/)).toBeVisible({
    timeout: 60_000,
  });
  for (const todo of TODOS) {
    await expect(page.getByTestId("bob-todos")).toContainText(todo);
  }

  if (aleph) expect(aleph.refused).toEqual([]);
});
