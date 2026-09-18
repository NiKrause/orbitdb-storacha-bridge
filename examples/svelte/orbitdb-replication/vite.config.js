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
  optimizeDeps: {
    // Found only when a backup or an identity first needs them, and the dev
    // server reloads the page to add them — in the middle of that step.
    include: ["crypto", "events", "stream"],
  },
  resolve: {
    // The bridge is linked from the repository root (file:../../../), so its
    // files and their dependencies resolve imports from the root, where the
    // polyfill plugin is not installed — yet the plugin adds shim imports to
    // them too. Resolve the plugin from this example instead. Marking the shims
    // external got the build through, and left the built page blank: the
    // browser cannot resolve them either.
    dedupe: ["vite-plugin-node-polyfills"],
  },
  test: {
    include: ["src/**/*.spec.js"],
    exclude: ["e2e/**", "src/routes/**/*.svelte.spec.js"],
  },
});
