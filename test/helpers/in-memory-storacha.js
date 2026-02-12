import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as client from "@ucanto/client";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { kadDHT } from "@libp2p/kad-dht";
import { CAR, HTTP } from "@ucanto/transport";
import * as CARTransport from "@ucanto/transport/car";
import { Message, delegate } from "@ucanto/core";
import { createServer, handle } from "@storacha/upload-api";
import { createContext, cleanupContext } from "@storacha/upload-api/test/context";
import * as ProviderCaps from "@storacha/capabilities/provider";
import * as TopCaps from "@storacha/capabilities/top";
import * as DidMailto from "@storacha/did-mailto";
import { Absentee } from "@ucanto/principal";
import * as ed25519 from "@ucanto/principal/ed25519";
import * as DID from "@ipld/dag-ucan/did";
import { CID } from "multiformats/cid";
import * as Link from "multiformats/link";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";
import { base64 } from "multiformats/bases/base64";
import { createLogger } from "../../lib/logger.js";

const colors = {
  teal: "\x1b[96m",
  violet: "\x1b[95m",
  reset: "\x1b[0m",
};

const serverLogger = createLogger("storacha:server");
const ucanLogger = createLogger("storacha:ucan");
const heliaLogger = createLogger("storacha:helia");

function colorize(color, message) {
  return `${color}${message}${colors.reset}`;
}

let heliaNode;
let heliaStartPromise;
let heliaWsMultiaddr;
let heliaTcpMultiaddr;
let heliaPeerId;
let gatewayServer;
let gatewayUrl;

async function ensureHelia() {
  if (heliaNode) {
    return heliaNode;
  }
  if (!heliaStartPromise) {
    heliaStartPromise = (async () => {
      const libp2p = await createLibp2p({
        transports: [tcp(), webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        addresses: {
          listen: ["/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/tcp/0/ws"],
        },
        services: {
          identify: identify(),
          ping: ping(),
          dht: kadDHT({ clientMode: false }),
        },
      });

      const node = await createHelia({ libp2p });
      unixfs(node);

      heliaPeerId = node.libp2p.peerId?.toString?.() ?? null;
      const addrs = node.libp2p.getMultiaddrs().map((addr) => addr.toString());
      heliaWsMultiaddr = addrs.find((addr) => addr.includes("/ws")) ?? null;
      heliaTcpMultiaddr = addrs.find((addr) => !addr.includes("/ws")) ?? null;
      if (!heliaWsMultiaddr || !heliaPeerId || !heliaTcpMultiaddr) {
        throw new Error("Failed to determine Helia WS multiaddr");
      }

      heliaLogger(
        colorize(
          colors.violet,
          `🟣 Helia node started (peer: ${heliaPeerId}, ws: ${heliaWsMultiaddr})`,
        ),
      );
      return node;
    })();
  }
  heliaNode = await heliaStartPromise;
  return heliaNode;
}

async function startGatewayServer() {
  if (gatewayServer && gatewayUrl) {
    return { server: gatewayServer, url: gatewayUrl };
  }

  const helia = await ensureHelia();
  const fs = unixfs(helia);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url || !req.url.startsWith("/ipfs/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    const cid = req.url.slice("/ipfs/".length);
    if (!cid) {
      res.writeHead(400);
      res.end();
      return;
    }

    try {
      const chunks = [];
      for await (const chunk of fs.cat(cid)) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const bytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from(bytes));
    } catch (error) {
      res.writeHead(404);
      res.end();
      heliaLogger(
        colorize(
          colors.violet,
          `🟣 Gateway miss for ${cid}: ${error?.message ?? error}`,
        ),
      );
    }
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind gateway HTTP server");
  }

  gatewayServer = server;
  gatewayUrl = `http://127.0.0.1:${address.port}`;
  heliaLogger(
    colorize(colors.violet, `🟣 Gateway started at ${gatewayUrl}`),
  );

  return { server, url: gatewayUrl };
}

async function importCarToHelia(bytes) {
  const helia = await ensureHelia();
  const blobDigest = await sha256.digest(bytes);
  const blobCid = CID.createV1(0x55, blobDigest);
  await helia.blockstore.put(blobCid, bytes);
  heliaLogger(
    colorize(colors.violet, `🟣 Helia stored blob ${blobCid.toString()}`),
  );

  const { CarReader } = await import("@ipld/car");
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  let blockCount = 0;

  for await (const block of reader.blocks()) {
    await helia.blockstore.put(block.cid, block.bytes);
    blockCount += 1;
  }

  heliaLogger(
    colorize(colors.violet, `🟣 Helia stored ${blockCount} blocks from CAR`),
  );

  for (const root of roots) {
    try {
      await helia.libp2p.contentRouting.provide(root);
      heliaLogger(
        colorize(colors.violet, `🟣 Helia provided root ${root.toString()}`),
      );
    } catch (error) {
      const message = error?.message ?? String(error);
      if (message.includes("No content routers available")) {
        heliaLogger(
          colorize(
            colors.violet,
            `🟣 Helia provide skipped (no routers) for ${root.toString()}`,
          ),
        );
      } else {
        throw error;
      }
    }
  }

  if (roots.length > 0) {
    heliaLogger(
      colorize(
        colors.violet,
        `🟣 Helia import complete for roots: ${roots.map((root) => root.toString()).join(", ")}`,
      ),
    );
  }
}

async function importMessageBlocksToHelia(message) {
  const helia = await ensureHelia();
  let blockCount = 0;

  for (const block of message.iterateIPLDBlocks()) {
    await helia.blockstore.put(block.cid, block.bytes);
    blockCount += 1;
  }

  heliaLogger(
    colorize(
      colors.violet,
      `🟣 Helia stored ${blockCount} blocks from UCAN message`,
    ),
  );
}

function createCorsHttp() {
  return {
    ...http,
    createServer: (handler) =>
      http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Amz-Checksum-Sha256",
        );

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "PUT") {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            const bytes = new Uint8Array(Buffer.concat(chunks));
            importCarToHelia(bytes).catch((error) => {
              heliaLogger(
                colorize(
                  colors.violet,
                  `🟣 Helia import failed (PUT): ${error?.message ?? error}`,
                ),
              );
            });
          });
        }

        return handler(req, res);
      }),
  };
}

async function getOrCreateServiceSigner({
  persist = false,
  signerPath,
  defaultDid,
} = {}) {
  if (!persist) {
    const signer = await ed25519.generate();
    return defaultDid ? signer.withDID(defaultDid) : signer;
  }

  const file = signerPath || path.resolve(".tmp/in-memory-service-did.json");

  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof data.privateKey === "string") {
        let signer = ed25519.parse(data.privateKey);
        if (defaultDid) {
          signer = signer.withDID(defaultDid);
        }
        serverLogger(
          colorize(
            colors.teal,
            `🌐 Using persisted service DID: ${signer.did()} (key: ${signer.toDIDKey()})`,
          ),
        );
        return signer;
      }
    }
  } catch (err) {
    serverLogger(
      colorize(
        colors.teal,
        `⚠️ [in-memory-storacha] failed to load persisted signer: ${err.message}`,
      ),
    );
  }

  const signer = await ed25519.generate();
  const finalSigner = defaultDid ? signer.withDID(defaultDid) : signer;
  serverLogger(
    colorize(
      colors.teal,
      `🌐 Generated fresh service DID: ${finalSigner.did()} (key: ${finalSigner.toDIDKey()})`,
    ),
  );

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          did: finalSigner.did(),
          key: finalSigner.toDIDKey(),
          privateKey: ed25519.format(signer),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    serverLogger(
      colorize(colors.teal, `🌐 Persisted service DID to: ${file}`),
    );
  } catch (err) {
    serverLogger(
      colorize(
        colors.teal,
        `⚠️ [in-memory-storacha] failed to persist signer: ${err.message}`,
      ),
    );
  }

  return finalSigner;
}

async function startUploadApiServer(context) {
  const agent = createServer({
    ...context,
    codec: CAR.inbound,
  });

  const server = http.createServer(async (req, res) => {
    serverLogger(
      colorize(colors.teal, `🌐 upload-api ${req.method} ${req.url}`),
    );
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/receipt/")) {
      const taskCid = req.url.slice("/receipt/".length);
      if (!taskCid) {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        res.end();
        return;
      }

      const receiptResult = await context.agentStore.receipts.get(taskCid);
      if (receiptResult.error) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end();
        return;
      }

      const message = await Message.build({ receipts: [receiptResult.ok] });
      const body = CARTransport.request.encode(message).body;
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/car",
      });
      res.end(body);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/.well-known/did.json")) {
      const serviceDid = context.id.did();
      const didKey = context.id.toDIDKey();
      const publicKeyMultibase = didKey.startsWith("did:key:")
        ? didKey.slice("did:key:".length)
        : didKey;

      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          id: serviceDid,
          verificationMethod: [
            {
              id: `${serviceDid}#key-1`,
              type: "Ed25519VerificationKey2020",
              controller: serviceDid,
              publicKeyMultibase,
            },
          ],
        }),
      );
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (req.method === "PUT") {
      try {
        await importCarToHelia(new Uint8Array(body));
      } catch (error) {
        heliaLogger(
          colorize(
            colors.violet,
            `🟣 Helia import failed: ${error?.message ?? error}`,
          ),
        );
      }
    }

    if (req.method === "POST") {
      try {
        const message = await CARTransport.request.decode({
          headers: req.headers,
          body: new Uint8Array(body),
        });
        const invocations = message.invocations ?? [];
        const shouldImportBlocks = invocations.some((invocation) =>
          invocation.capabilities?.some(
            (cap) =>
              cap?.can === "space/blob/add" ||
              cap?.can === "blob/add" ||
              cap?.can === "upload/add",
          ),
        );
        if (shouldImportBlocks) {
          await importMessageBlocksToHelia(message);
        }
        for (const invocation of invocations) {
          const caps = invocation.capabilities?.map((cap) => ({
            can: cap?.can,
            with: cap?.with,
          }));
          ucanLogger(
            colorize(
              colors.teal,
              `🔐 UCAN invocation ${invocation.issuer?.did?.()} -> ${invocation.audience?.did?.()} ${JSON.stringify(caps)}`,
            ),
          );
        }
      } catch (error) {
        ucanLogger(
          colorize(
            colors.teal,
            `⚠️ UCAN request decode failed: ${error?.message ?? error}`,
          ),
        );
      }
    }

    const response = await handle(agent, { headers: req.headers, body });
    const responseType =
      response.headers?.["content-type"] || response.headers?.["Content-Type"];
    if (responseType?.includes("application/car")) {
      try {
        const receiptMessage = await CARTransport.response.decode({
          headers: response.headers,
          body: response.body,
        });
        for (const receipt of receiptMessage.receipts.values()) {
          const result = receipt.result;
          if (result?.error) {
            ucanLogger(
              colorize(
                colors.teal,
                `❌ UCAN receipt error for ${receipt.ran?.link?.()}: ${JSON.stringify(result.error)}`,
              ),
            );
          } else {
            ucanLogger(
              colorize(
                colors.teal,
                `✅ UCAN receipt ok for ${receipt.ran?.link?.()}`,
              ),
            );
          }
        }
      } catch (error) {
        ucanLogger(
          colorize(
            colors.teal,
            `⚠️ UCAN receipt decode failed: ${error?.message ?? error}`,
          ),
        );
      }
    }

    res.writeHead(response.status || 200, {
      ...response.headers,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end(response.body);
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind upload-api HTTP server");
  }

  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function createLocalCredentials(context) {
  const spaceAgent = await ed25519.generate();
  const space = await ed25519.generate();
  const spaceDid = space.did();

  const spaceProof = await delegate({
    issuer: space,
    audience: spaceAgent,
    capabilities: [
      { can: TopCaps.top.can, with: space.did() },
      { can: "assert/index", with: space.did() },
      { can: "space/blob/add", with: space.did() },
      { can: "space/blob/list", with: space.did() },
      { can: "space/blob/remove", with: space.did() },
      { can: "space/index/add", with: space.did() },
      { can: "filecoin/offer", with: space.did() },
      { can: "upload/add", with: space.did() },
      { can: "upload/list", with: space.did() },
      { can: "upload/remove", with: space.did() },
    ],
  });

  const accountDid = DidMailto.fromEmail("test@example.com");
  const account = Absentee.from({ id: accountDid });
  const providerAdd = ProviderCaps.add.invoke({
    issuer: spaceAgent,
    audience: context.id,
    with: account.did(),
    nb: {
      provider: context.id.did(),
      consumer: space.did(),
    },
    proofs: [
      await delegate({
        issuer: account,
        audience: spaceAgent,
        capabilities: [
          {
            can: "provider/add",
            with: account.did(),
            nb: {
              provider: context.id.did(),
              consumer: space.did(),
            },
          },
        ],
      }),
    ],
  });

  await context.provisionsStorage.put({
    cause: providerAdd,
    consumer: spaceDid,
    customer: account.did(),
    provider: context.id.did(),
  });

  const { ok, error } = await spaceProof.archive();
  if (error) {
    throw error;
  }

  return {
    storachaKey: ed25519.format(spaceAgent),
    storachaProof: Link.create(
      CAR.codec.code,
      await identity.digest(ok),
    ).toString(base64),
    spaceDid,
  };
}

function buildServiceConf(url, serviceDid) {
  const serviceURL = new URL(url);
  const principal = DID.parse(serviceDid);
  const connectOptions = {
    id: principal,
    codec: CAR.outbound,
    channel: HTTP.open({
      url: serviceURL,
      method: "POST",
    }),
  };

  return {
    access: client.connect(connectOptions),
    upload: client.connect(connectOptions),
    filecoin: client.connect(connectOptions),
    gateway: client.connect(connectOptions),
  };
}

export async function startInMemoryStorachaService(options = {}) {
  await ensureHelia();
  const gateway = await startGatewayServer();
  const context = await createContext({
    requirePaymentPlan: false,
    http: createCorsHttp(),
  });

  const signer = await getOrCreateServiceSigner({
    persist: options.persistServiceDid === true,
    signerPath: options.serviceDidPath,
    defaultDid: context.id.did(),
  });

  context.id = signer;
  context.signer = signer;

  const { server, url } = await startUploadApiServer(context);
  const credentials = await createLocalCredentials(context);
  const serviceConf = buildServiceConf(url, context.id.did());
  const receiptsEndpoint = new URL("/receipt/", url);

  return {
    context,
    server,
    url,
    gatewayUrl: gateway.url,
    serviceConf,
    receiptsEndpoint,
    helia: heliaNode,
    heliaPeerId,
    heliaWsMultiaddr,
    heliaTcpMultiaddr,
    ...credentials,
  };
}

export async function stopInMemoryStorachaService(service) {
  if (!service) {
    return;
  }

  if (service.server) {
    await new Promise((resolve) => service.server.close(() => resolve()));
  }

  if (gatewayServer) {
    await new Promise((resolve) => gatewayServer.close(() => resolve()));
    gatewayServer = null;
    gatewayUrl = null;
  }

  if (service.context) {
    await cleanupContext(service.context);
  }

  if (heliaNode) {
    await heliaNode.stop();
    if (heliaNode.libp2p && typeof heliaNode.libp2p.stop === "function") {
      await heliaNode.libp2p.stop();
    }
    heliaNode = null;
    heliaStartPromise = null;
    heliaWsMultiaddr = null;
    heliaTcpMultiaddr = null;
    heliaPeerId = null;
  }
}
