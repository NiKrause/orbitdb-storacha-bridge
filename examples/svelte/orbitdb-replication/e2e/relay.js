/**
 * A relay for the tests, in place of the public one the demo uses.
 *
 * Two browser nodes cannot listen, so each reserves a slot here and is
 * reachable through it. Reservations carry no data or time limit
 * (`applyDefaultLimit: false`), so OrbitDB can sync over the relayed
 * connection and the test does not hang on whether WebRTC came up.
 */
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { relayPrivateKey, relayPort } from "./relay-key.js";

const relay = await createLibp2p({
  privateKey: relayPrivateKey,
  addresses: { listen: [`/ip4/127.0.0.1/tcp/${relayPort}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    relay: circuitRelayServer({
      reservations: { maxReservations: 64, applyDefaultLimit: false },
    }),
  },
});

for (const address of relay.getMultiaddrs()) {
  console.log(`relay listening on ${address.toString()}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    relay.stop().then(() => process.exit(0));
  });
}
