import { defineConfig } from "@playwright/test";

const port = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 4173;

export default defineConfig({
  webServer: {
    // The built site, as it is deployed. The dev server finds dependencies
    // while a test runs and reloads the page to add them, and it would not
    // notice a build that leaves the page blank.
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    port: port,
    timeout: 300000, // building takes a while
    reuseExistingServer: !process.env.CI,
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
