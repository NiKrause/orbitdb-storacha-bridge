import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

// update version in package.json and title
const file = fileURLToPath(new URL("package.json", import.meta.url));
const json = readFileSync(file, "utf8");
const pkg = JSON.parse(json);

// Create build date
const buildDate =
  new Date().toISOString().split("T")[0] +
  " " +
  new Date().toLocaleTimeString(); // YYYY-MM-DD HH:MM:SS format

export default defineConfig({
  plugins: [
    sveltekit(),
    nodePolyfills({
      include: [
        "path",
        "util",
        "buffer",
        "process",
        "events",
        "crypto",
        "os",
        "stream",
        "string_decoder",
        "readable-stream",
        "safe-buffer",
      ],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    // VitePWA disabled - use custom service worker if needed
    // VitePWA({
    //   registerType: "autoUpdate",
    //   ...
    // }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  build: {
    rollupOptions: {
      external: [
        "vite-plugin-node-polyfills/shims/process",
        "vite-plugin-node-polyfills/shims/buffer",
        "vite-plugin-node-polyfills/shims/path",
        "vite-plugin-node-polyfills/shims/util",
        "vite-plugin-node-polyfills/shims/crypto",
        "vite-plugin-node-polyfills/shims/stream",
      ],
    },
  },
});
