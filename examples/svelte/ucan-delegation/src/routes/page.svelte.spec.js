import { expect, test } from '@playwright/test';

test.describe("/+page.svelte", () => {
  test("should render h1", async ({ page }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
  });
});
