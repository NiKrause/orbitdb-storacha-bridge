/**
 * Where the relay addresses come from.
 *
 * A browser cannot listen, so Alice and Bob are only reachable through a relay.
 * This example used to name one in its source, and that address had been dead
 * for a while before anyone noticed: the port refuses connections, and the demo
 * simply waited. So the relays name themselves instead. A relay deployed with
 * `relay-button` posts a signed `relay-bootstrap-v2` record to a public Aleph
 * channel, listing the addresses it is actually reachable at, and this reads
 * that channel. Reading Aleph needs no account and no key; signing does.
 *
 * `VITE_RELAY_ADDRS` wins when it is set, so a relay on your own machine — the
 * E2E tests start one — needs neither the network nor the registry.
 */
import {
  fetchAlephBootstrapPosts,
  filterRelayBootstrapPostsByProfile,
  selectCurrentRelayBootstrapPosts,
  isBrowserDialableMultiaddr,
  dedupeMultiaddrs,
} from "@le-space/aleph-bootstrap";
import { logger } from "./logger.js";

// Only relays this demo can use: an OrbitDB app that dials a `uc-go-peer`
// relay never forms a shared circuit. A live relay republishes every 6 hours,
// so two missed cadences means the machine behind the record is gone — records
// are never withdrawn, because the key that signed one dies with the machine.
const PROFILE = "orbitdb-relay";
const MAX_AGE_MS = 13 * 60 * 60 * 1000;

const fromEnv = (import.meta.env.VITE_RELAY_ADDRS || "")
  .split(",")
  .map((addr) => addr.trim())
  .filter(Boolean);

/** Where the addresses in use came from, for the page to say so. */
export const relaySource = fromEnv.length > 0 ? "VITE_RELAY_ADDRS" : `Aleph (profile ${PROFILE})`;

let discovery = null;

/**
 * Every relay currently registered under the profile — one record per relay,
 * newest first, addresses a browser can dial.
 *
 * `discoverAlephBootstrapMultiaddrs` would be the one-line version, and it
 * keeps a single record per `registrationId`. The relays deployed from one
 * profile share that id, so it hands back whichever registered last: measured
 * on 2026-09-18, that was a relay which accepts connections and never answers
 * identify, while the other one was healthy. Dialling both costs one failed
 * dial and is the difference between a demo that connects and one that waits.
 */
async function registeredRelays() {
  const posts = filterRelayBootstrapPostsByProfile(
    await fetchAlephBootstrapPosts({ pagination: 100 }),
    PROFILE,
  );

  const byRelay = new Map();
  for (const post of posts) {
    const peerId = post.content?.peerId;
    if (!peerId) continue;
    byRelay.set(peerId, [...(byRelay.get(peerId) ?? []), post]);
  }

  const addresses = [];
  for (const relayPosts of byRelay.values()) {
    // Per relay, the package's own rules: signature and shape checked, stale
    // records dropped, newest kept.
    const [current] = selectCurrentRelayBootstrapPosts(relayPosts, { maxAgeMs: MAX_AGE_MS });
    if (!current?.content) continue;
    addresses.push(
      ...(current.content.multiaddrs ?? []).filter((addr) => isBrowserDialableMultiaddr(addr)),
    );
  }

  return dedupeMultiaddrs(addresses);
}

/**
 * The relays to dial. Asked for once per page load, however many peers ask.
 *
 * @returns {Promise<string[]>} multiaddrs, each with its `/p2p/` id; empty when
 *   no relay is registered, or the registry could not be read.
 */
export async function relayMultiaddrs() {
  if (fromEnv.length > 0) return fromEnv;

  discovery ??= registeredRelays()
    .then((addrs) => {
      logger.info(`🔗 ${addrs.length} relay address(es) from ${relaySource}`);
      return addrs;
    })
    .catch((error) => {
      // A demo that cannot read the registry should say it found no relay,
      // not fail to start.
      logger.warn(`⚠️ Could not read the relay registry: ${error.message}`);
      return [];
    });

  return discovery;
}
