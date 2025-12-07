import { defineConfig } from "@playwright/test";

const port = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 5173;

export default defineConfig({
  webServer: {
    command: `npm run dev -- --port ${port}`,
    port: port,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: process.env.PORT || "5173",
    },
  },
  testDir: "e2e",
  use: {
    baseURL: `http://localhost:${port}`,
  },
});
