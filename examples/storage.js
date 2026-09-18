/**
 * Where these examples put their backups.
 *
 * Storacha's uploads stopped working in May 2026, so the default here is Aleph,
 * which takes an upload without an account and without a key — a demo you can
 * run straight after cloning. `STORAGE=pinata` and `STORAGE=lighthouse` switch
 * to the paid services and read their key from the environment.
 *
 *   node examples/backup-demo.js                     # Aleph
 *   STORAGE=pinata PINATA_JWT=… node examples/backup-demo.js
 *   STORAGE=lighthouse LIGHTHOUSE_API_KEY=… node examples/backup-demo.js
 *
 * Aleph keeps nothing on its own: staying stored is a wallet-signed STORE
 * message this library does not send, so treat an Aleph backup as short-lived.
 */

import { createAlephBackend } from "../lib/backends/aleph.js";
import { createPinataBackend } from "../lib/backends/pinata.js";
import { createLighthouseBackend } from "../lib/backends/lighthouse.js";

/**
 * The backend named by STORAGE, with the label to print.
 *
 * @returns {{ backend: import("../lib/backends/types.js").StorageBackend, label: string }}
 */
export function storageFromEnv() {
  const choice = (process.env.STORAGE || "aleph").trim().toLowerCase();

  if (choice === "aleph") {
    return { backend: createAlephBackend(), label: "Aleph" };
  }

  if (choice === "pinata") {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) throw new Error("STORAGE=pinata needs PINATA_JWT (a JWT, not an API key)");
    return {
      backend: createPinataBackend({ jwt, gateway: process.env.PINATA_GATEWAY || undefined }),
      label: "Pinata",
    };
  }

  if (choice === "lighthouse") {
    const apiKey = process.env.LIGHTHOUSE_API_KEY;
    if (!apiKey) throw new Error("STORAGE=lighthouse needs LIGHTHOUSE_API_KEY");
    return { backend: createLighthouseBackend({ apiKey }), label: "Lighthouse" };
  }

  throw new Error(`STORAGE=${choice} is not one of: aleph, pinata, lighthouse`);
}
