import { defineConfig } from "@playwright/test";

const port = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 5173;

export default defineConfig({
  webServer: {
    command: "npm run dev",
    port: port,
    timeout: 120000, // 2 minutes for server to start
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: process.env.PORT || "5173",
    },
  },
  testDir: "e2e",
  use: {
    baseURL: `http://localhost:${port}`,
  },
  // Increase global test timeout
  timeout: 60000, // 60 seconds per test
  expect: {
    timeout: 10000, // 10 seconds for assertions
  },
});
