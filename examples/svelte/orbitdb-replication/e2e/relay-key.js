/**
 * The relay the tests run against: a libp2p node on this machine, keyed from a
 * fixed seed so its address is known before it starts — the page is built with
 * that address in VITE_RELAY_ADDRS.
 *
 * The seed is not a secret: the relay listens on 127.0.0.1, holds nothing, and
 * exists for the length of a test run.
 */
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { sha256 } from "multiformats/hashes/sha2";

const seed = (await sha256.digest(new TextEncoder().encode("orbitdb-replication e2e relay"))).digest;

export const relayPrivateKey = await generateKeyPairFromSeed("Ed25519", seed);
export const relayPeerId = peerIdFromPrivateKey(relayPrivateKey).toString();
export const relayPort = Number(process.env.RELAY_PORT || 9092);
export const relayAddr = `/ip4/127.0.0.1/tcp/${relayPort}/ws/p2p/${relayPeerId}`;
