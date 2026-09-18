import { defineConfig } from "@playwright/test";
import { relayAddr, relayPort } from "./e2e/relay-key.js";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4174;

export default defineConfig({
  webServer: [
    {
      // Alice and Bob meet here, rather than on the public relay.
      command: "node e2e/relay.js",
      port: relayPort,
      timeout: 60000,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The built site, as it is deployed. The dev server finds dependencies
      // while a test runs and reloads the page to add them, and it would not
      // notice a build that leaves the page blank.
      command: `npm run build && npm run preview -- --port ${port} --strictPort`,
      port: port,
      timeout: 300000, // building takes a while
      reuseExistingServer: !process.env.CI,
      env: { VITE_RELAY_ADDRS: relayAddr },
    },
  ],
  testDir: "e2e",
  use: {
    baseURL: `http://localhost:${port}`,
  },
  // Two OrbitDB nodes, a relay and a replication round trip
  timeout: 180000,
  expect: {
    timeout: 15000,
  },
});
