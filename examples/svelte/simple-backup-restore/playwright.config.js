import { defineConfig } from "@playwright/test";

export default defineConfig({
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  testDir: "e2e",
  use: {
    baseURL: "http://localhost:5173",
  },
});
