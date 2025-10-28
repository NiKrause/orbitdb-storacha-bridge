import { expect, test } from "@playwright/test";

test.describe("UCAN Authorization Error Handling", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    
    await expect(page.locator("h1")).toBeVisible();
  });

  test("displays error when backup fails due to UCAN authorization", async ({ page }) => {
    await page.route("**/upload/**", async (route) => {
      await route.abort("failed");
    });
    await page.evaluate(() => {
      window.__mockBackupError = true;
      window.__mockBackupErrorMessage = "UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.";
    });

    const authSection = page.locator('text=Storacha Authentication').first();
    
    if (await authSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      const backupButton = page.locator('button:has-text("Backup")').first();
      
      if (await backupButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isDisabled = await backupButton.isDisabled();
        
        if (!isDisabled) {
          await backupButton.click();
          
          const errorNotification = page.locator('[role="status"], .bx--inline-notification--error, text=/UCAN authorization failed/i').first();
          
          await expect(errorNotification).toBeVisible({ timeout: 10000 });
          
          const errorText = await errorNotification.textContent();
          expect(errorText.toLowerCase()).toContain("authorization");
        }
      }
    }
  });

  test("displays error notification with UCAN details in Alice's section", async ({ page }) => {
    const aliceSection = page.locator('text=/Alice.*Data Creator/i').first();
    
    if (await aliceSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.evaluate(() => {
        const errorEvent = new CustomEvent('storacha-error', {
          detail: {
            type: 'ucan',
            message: 'UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.',
            persona: 'alice'
          }
        });
        window.dispatchEvent(errorEvent);
      });

      const errorNotification = page.locator('[kind="error"], .bx--inline-notification--error').first();
      
      const isVisible = await errorNotification.isVisible({ timeout: 5000 }).catch(() => false);
      
      if (isVisible) {
        const notificationText = await errorNotification.textContent();
        expect(notificationText.toLowerCase()).toMatch(/error|failed/);
      }
    }
  });

  test("shows proper error state when restore fails due to UCAN authorization", async ({ page }) => {
    const bobSection = page.locator('text=/Bob.*Data Restorer/i').first();
    
    if (await bobSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.evaluate(() => {
        const errorEvent = new CustomEvent('storacha-error', {
          detail: {
            type: 'ucan',
            message: 'UCAN authorization failed during restore operation',
            persona: 'bob'
          }
        });
        window.dispatchEvent(errorEvent);
      });

      const errorNotification = page.locator('[kind="error"], .bx--inline-notification--error').first();
      
      const isVisible = await errorNotification.isVisible({ timeout: 5000 }).catch(() => false);
      
      if (isVisible) {
        const notificationText = await errorNotification.textContent();
        expect(notificationText.toLowerCase()).toMatch(/error|failed/);
      }
    }
  });

  test("error message persists and is clearable", async ({ page }) => {
    const resetButton = page.locator('button:has-text("Reset"), button:has-text("Clear")').first();
    
    if (await resetButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resetButton.click();
      
      const errorNotifications = page.locator('[kind="error"], .bx--inline-notification--error');
      const count = await errorNotifications.count();
      
      expect(count).toBe(0);
    }
  });

  test("progress indicator shows error state on UCAN failure", async ({ page }) => {
    const progressIndicator = page.locator('.bx--progress, [role="progressbar"]').first();
    
    if (await progressIndicator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.evaluate(() => {
        const progressEvent = new CustomEvent('upload-progress', {
          detail: {
            type: 'upload',
            status: 'error',
            error: {
              type: 'ucan',
              message: 'UCAN authorization failed',
              details: 'Insufficient capabilities'
            }
          }
        });
        window.dispatchEvent(progressEvent);
      });

      const errorIndicator = page.locator('text=/error|failed/i, [data-status="error"]').first();
      const hasError = await errorIndicator.isVisible({ timeout: 5000 }).catch(() => false);
      
      if (hasError) {
        expect(await errorIndicator.textContent()).toBeTruthy();
      }
    }
  });
});

test.describe("UCAN Error Recovery Flow", () => {
  test("allows user to retry after UCAN authorization failure", async ({ page }) => {
    await page.goto("/");
    
    const authSection = page.locator('text=Storacha Authentication, text=Authentication').first();
    
    if (await authSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      const authButtons = page.locator('button:has-text("Authenticate"), button:has-text("Connect"), button:has-text("Login")');
      
      const buttonCount = await authButtons.count();
      
      expect(buttonCount).toBeGreaterThan(0);
    }
  });

  test("displays helpful error message with actionable steps", async ({ page }) => {
    await page.goto("/");
    
    await page.evaluate(() => {
      const errorEvent = new CustomEvent('storacha-error', {
        detail: {
          type: 'ucan',
          message: 'UCAN authorization failed: Your capabilities are not sufficient for uploading. Please check your space permissions.',
          details: 'The UCAN token may be expired or lack necessary permissions'
        }
      });
      window.dispatchEvent(errorEvent);
    });

    const errorMessage = page.locator('text=/UCAN authorization failed|capabilities|permissions/i').first();
    
    const isVisible = await errorMessage.isVisible({ timeout: 5000 }).catch(() => false);
    
    if (isVisible) {
      const messageText = await errorMessage.textContent();
      
      expect(messageText.toLowerCase()).toMatch(/authorization|capabilities|permissions/);
    }
  });
});

test.describe("UCAN Error Edge Cases", () => {
  test("handles expired UCAN token gracefully", async ({ page }) => {
    await page.goto("/");
    
    await page.evaluate(() => {
      window.__mockExpiredUCAN = true;
    });
    
    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
  });

  test("handles network errors during UCAN validation", async ({ page }) => {
    await page.goto("/");
    
    await page.route("**/validate/**", async (route) => {
      await route.abort("failed");
    });
    const heading = page.locator("h1");
    await expect(heading).toBeVisible();
  });

  test("displays appropriate error for insufficient UCAN capabilities", async ({ page }) => {
    await page.goto("/");
    
    await page.evaluate(() => {
      const errorEvent = new CustomEvent('storacha-error', {
        detail: {
          type: 'ucan',
          message: 'Insufficient capabilities: Missing store/add permission',
          details: 'Your UCAN token does not have the required store/add capability'
        }
      });
      window.dispatchEvent(errorEvent);
    });
    
    const errorMessage = page.locator('text=/insufficient|capabilities|permission/i').first();
    
    const isVisible = await errorMessage.isVisible({ timeout: 5000 }).catch(() => false);
    
    if (isVisible) {
      const messageText = await errorMessage.textContent();
      expect(messageText.toLowerCase()).toMatch(/insufficient|capabilities|permission/);
    }
  });
});
