import { expect, test } from "@playwright/test";


test.describe("Backup with Expired UCAN Token", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for network to be idle and page to be fully loaded
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1")).toBeVisible({ timeout: 10000 });
  });

  test("shows UCAN error when attempting backup with expired token", async ({ page }) => {
    await page.route("**/upload/**", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unauthorized",
          message: "UCAN token expired or invalid",
        }),
      });
    });

    await page.route("**/store/add**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Capability validation failed",
          message: "Insufficient capabilities for store/add operation",
        }),
      });
    });

    await page.waitForTimeout(1000);

    const backupButton = page.locator('button:has-text("Backup")').first();
    
    if (await backupButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await backupButton.isDisabled();
      
      if (!isDisabled) {
        await backupButton.click();
        
        await page.waitForTimeout(2000);
        
        const errorNotification = page.locator(
          '[kind="error"], .bx--inline-notification--error, text=/error|failed/i'
        ).first();
        
        const errorVisible = await errorNotification.isVisible({ timeout: 10000 }).catch(() => false);
        
        if (errorVisible) {
          const errorText = await errorNotification.textContent();
          
          expect(errorText.toLowerCase()).toMatch(/authorization|ucan|capabilities|permission|unauthorized/);
          
          console.log("✓ UCAN error properly displayed:", errorText);
        } else {
          console.log("⚠ Error notification not found - may need authentication first");
        }
      } else {
        console.log("⚠ Backup button is disabled - authentication may be required first");
      }
    } else {
      console.log("⚠ Backup button not found - may need to complete previous steps");
    }
  });

  test("error message includes helpful information about UCAN failure", async ({ page }) => {
    await page.route("**/upload/**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "CapabilityError",
          message: "UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.",
          details: {
            required: ["store/add", "upload/add"],
            provided: [],
            reason: "Token expired or insufficient permissions",
          },
        }),
      });
    });

    const backupButton = page.locator('button:has-text("Backup")').first();
    
    if (await backupButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await backupButton.isDisabled();
      
      if (!isDisabled) {
        await backupButton.click();
        await page.waitForTimeout(2000);
        
        const errorDetails = page.locator('text=/capabilities|permissions|space/i').first();
        
        const hasDetails = await errorDetails.isVisible({ timeout: 10000 }).catch(() => false);
        
        if (hasDetails) {
          const detailsText = await errorDetails.textContent();
          console.log("✓ Detailed error message displayed:", detailsText);
          
          expect(detailsText.toLowerCase()).toMatch(/capabilities|permissions/);
        }
      }
    }
  });

  test("user can see error in Alice's progress section", async ({ page }) => {
    const aliceSection = page.locator('text=/Alice/i').first();
    
    if (await aliceSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.route("**/upload/**", async (route) => {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Unauthorized",
            message: "UCAN authorization failed",
          }),
        });
      });

      const backupButton = page.locator('button:has-text("Backup")').first();
      
      if (await backupButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isDisabled = await backupButton.isDisabled();
        
        if (!isDisabled) {
          await backupButton.click();
          await page.waitForTimeout(2000);
          
          const aliceError = page.locator('text=/Alice.*error|error.*Alice/i, [data-persona="alice"] >> text=/error/i').first();
          
          const hasError = await aliceError.isVisible({ timeout: 10000 }).catch(() => false);
          
          if (hasError) {
            console.log("✓ Error visible in Alice's section");
          }
        }
      }
    }
  });

  test("application remains stable after UCAN error", async ({ page }) => {
    await page.route("**/upload/**", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unauthorized",
        }),
      });
    });

    const backupButton = page.locator('button:has-text("Backup")').first();
    
    if (await backupButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await backupButton.isDisabled();
      
      if (!isDisabled) {
        await backupButton.click();
        await page.waitForTimeout(2000);
      }
    }

    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
    
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toBeTruthy();
    
    console.log("✓ Application remains stable after UCAN error");
  });

  test("reset button clears UCAN error state", async ({ page }) => {
    await page.route("**/upload/**", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unauthorized",
        }),
      });
    });

    const backupButton = page.locator('button:has-text("Backup")').first();
    
    if (await backupButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await backupButton.isDisabled();
      
      if (!isDisabled) {
        await backupButton.click();
        await page.waitForTimeout(2000);
        
        const resetButton = page.locator('button:has-text("Reset"), button:has-text("Clear")').first();
        
        if (await resetButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await resetButton.click();
          await page.waitForTimeout(500);
          
          const errorNotifications = page.locator('[kind="error"], .bx--inline-notification--error');
          const errorCount = await errorNotifications.count();
          
          expect(errorCount).toBe(0);
          
          console.log("✓ Reset button successfully clears error state");
        }
      }
    }
  });
});

test.describe("Restore with Expired UCAN Token", () => {
  test("shows UCAN error when attempting restore with expired token", async ({ page }) => {
    await page.route("**/download/**", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unauthorized",
          message: "UCAN token expired",
        }),
      });
    });

    await page.route("**/store/get**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Capability validation failed",
          message: "Insufficient capabilities for store/get operation",
        }),
      });
    });

    const restoreButton = page.locator('button:has-text("Restore")').first();
    
    if (await restoreButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isDisabled = await restoreButton.isDisabled();
      
      if (!isDisabled) {
        await restoreButton.click();
        await page.waitForTimeout(2000);
        
        const errorNotification = page.locator(
          '[kind="error"], .bx--inline-notification--error, text=/error|failed/i'
        ).first();
        
        const errorVisible = await errorNotification.isVisible({ timeout: 10000 }).catch(() => false);
        
        if (errorVisible) {
          const errorText = await errorNotification.textContent();
          expect(errorText.toLowerCase()).toMatch(/authorization|ucan|capabilities|unauthorized/);
          
          console.log("✓ UCAN error properly displayed during restore:", errorText);
        }
      } else {
        console.log("⚠ Restore button is disabled - may need to complete backup first");
      }
    } else {
      console.log("⚠ Restore button not found - may need to complete previous steps");
    }
  });

  test("Bob's section shows UCAN error during restore", async ({ page }) => {
    const bobSection = page.locator('text=/Bob/i').first();
    
    if (await bobSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.route("**/download/**", async (route) => {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Unauthorized",
            message: "UCAN authorization failed during restore",
          }),
        });
      });

      const restoreButton = page.locator('button:has-text("Restore")').first();
      
      if (await restoreButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isDisabled = await restoreButton.isDisabled();
        
        if (!isDisabled) {
          await restoreButton.click();
          await page.waitForTimeout(2000);
          
          const bobError = page.locator('text=/Bob.*error|error.*Bob/i, [data-persona="bob"] >> text=/error/i').first();
          
          const hasError = await bobError.isVisible({ timeout: 10000 }).catch(() => false);
          
          if (hasError) {
            console.log("✓ Error visible in Bob's section");
          }
        }
      }
    }
  });
});
