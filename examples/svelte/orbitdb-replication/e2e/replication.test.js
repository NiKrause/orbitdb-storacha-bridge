/**
 * Alice and Bob replicate, and the backup is a second route for the same data:
 * Alice writes todos and backs them up, Bob meets her through the relay and
 * receives them, restores the backup, and writes a todo of his own that travels
 * back to Alice.
 *
 * The relay runs on this machine (see playwright.config.js), the test plays
 * Aleph, and every other request that would leave the machine is refused — so a
 * demo that quietly depends on public infrastructure fails here.
 * ALEPH_LIVE=1 uses the real Aleph instead.
 */
import { expect, test } from "@playwright/test";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

const LIVE = process.env.ALEPH_LIVE === "1";
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

test("Alice's todos reach Bob by replication and by backup, and his reach her", async ({ page }) => {
  const aleph = LIVE ? null : await standInForAleph(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Use Aleph" }).click();
  await expect(page.getByTestId("storage-label")).toHaveText("Aleph");

  await page.getByRole("button", { name: /^1\. Initialize Alice/ }).click();
  await expect(page.getByText(/Alice's OrbitDB instance ready/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^2\. Add Todos/ }).click();
  await expect(page.getByText(/Successfully added 3 todos/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /^3\. Backup to Aleph/ }).click();
  // Three entries, the manifest, the access controller, and the identity that
  // signed the entries.
  await expect(page.getByText(/Backup created on Aleph: 6 blocks in one CAR/)).toBeVisible({
    timeout: 60_000,
  });
  if (aleph) expect(aleph.uploads.size).toBe(2); // the CAR and its metadata

  // Bob can only start once Alice is reachable through the relay.
  const initializeBob = page.getByRole("button", { name: /^1\. Initialize Bob/ });
  await expect(initializeBob).toBeEnabled({ timeout: 60_000 });
  await initializeBob.click();
  // Replication, not the backup: Bob opens Alice's address and the entries arrive.
  await expect(page.getByText(/opened shared database with 3 replicated todos/)).toBeVisible({
    timeout: 120_000,
  });

  await page.getByRole("button", { name: /^3\. Restore from Aleph/ }).click();
  await expect(page.getByText(/Database restored from Aleph: 3 entries/)).toBeVisible({
    timeout: 90_000,
  });

  // And back the other way: Bob writes, Alice sees it.
  await page.getByRole("button", { name: /^2\. Add Todo \(Test Replication/ }).click();
  await expect(page.getByText(/Bob added todo - should appear in Alice/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("alice-todos")).toContainText("Added by Bob", { timeout: 60_000 });

  if (aleph) expect(aleph.refused).toEqual([]);
});
