import { expect, test } from "@playwright/test";

test("home page has expected h1", async ({ page }) => {
  await page.goto("/");
  // Wait for the page to be fully loaded and interactive
  await page.waitForLoadState("networkidle");
  // Wait for the h1 to be visible with a longer timeout
  await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });
});
