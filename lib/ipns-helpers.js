/**
 * IPNS Helper Functions for OrbitDB Restoration
 *
 * Provides functions to publish and resolve OrbitDB metadata via IPNS
 * Uses the ipns package (already available as transitive dependency) and Helia's libp2p DHT
 */

import { createIPNSRecord, marshalIPNSRecord, unmarshalIPNSRecord } from "ipns";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { CID } from "multiformats/cid";
import { logger } from "./logger.js";

/**
 * Create an IPNS key pair
 * @returns {Promise<Object>} - { privateKey, publicKey, peerId, ipnsKey }
 */
export async function createIPNSKeyPair() {
  const keyPair = await generateKeyPair("Ed25519");
  const peerId = await keyPair.publicKey.toPeerId();

  logger.info(`🔑 Created IPNS key pair: ${peerId.toString()}`);

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    peerId: peerId,
    ipnsKey: `/ipns/${peerId.toString()}`,
  };
}

/**
 * Publish metadata to IPNS using Helia's libp2p DHT
 * @param {Object} helia - Helia instance
 * @param {Object} privateKey - Private key for signing
 * @param {Object} metadata - Metadata object to publish
 * @param {number} lifetime - Lifetime in nanoseconds (default: 1 hour = 3600000000000ns)
 * @returns {Promise<Object>} - { ipnsKey, metadataCID, ipnsRecord }
 */
export async function publishMetadataToIPNS(
  helia,
  privateKey,
  metadata,
  lifetime = 3600000000000,
) {
  // Convert metadata to JSON and store in IPFS
  const { unixfs: unixfsModule } = await import("@helia/unixfs");
  const fs = unixfsModule(helia);

  const jsonString = JSON.stringify(metadata, null, 2);
  const jsonBytes = new TextEncoder().encode(jsonString);

  // Create async iterable
  async function* dataGenerator() {
    yield jsonBytes;
  }

  // Add to IPFS
  const cid = await fs.addFile({ content: dataGenerator() });
  const cidString = cid.toString();

  logger.info(`📤 Stored metadata in IPFS: ${cidString}`);

  // Parse CID for IPNS
  const metadataCID = CID.parse(cidString);

  // Create IPNS record
  const sequence = 0;
  const ipnsRecord = await createIPNSRecord(
    privateKey,
    metadataCID.bytes,
    sequence,
    lifetime,
  );

  // Marshal IPNS record
  const ipnsRecordBytes = marshalIPNSRecord(ipnsRecord);

  // Publish to DHT using libp2p
  const _libp2p = helia.libp2p;
  const peerId = await privateKey.publicKey.toPeerId();

  // Get IPNS key (peer ID as IPNS key)
  const ipnsKey = `/ipns/${peerId.toString()}`;

  // Store IPNS record
  // For now, we'll store it in the local datastore for testing
  // In production, this would be published to DHT
  try {
    logger.info(`📤 Publishing IPNS record: ${ipnsKey}`);

    // Try to use @helia/ipns if available
    let published = false;
    try {
      // Try @helia/ipns first
      const { ipns: ipnsModule } = await import("@helia/ipns");
      const name = ipnsModule(helia);
      await name.publish(peerId, metadataCID);
      published = true;
      logger.info(
        `✅ Published IPNS record using @helia/ipns: ${ipnsKey} -> ${cidString}`,
      );
    } catch (importError) {
      // @helia/ipns not available, store IPNS record in IPFS for cross-node access
      logger.info(`@helia/ipns not available, storing IPNS record in IPFS`);

      // Store IPNS record in IPFS so it can be accessed by other nodes
      const { unixfs: unixfsModule } = await import("@helia/unixfs");
      const fs = unixfsModule(helia);

      const recordGenerator = async function* () {
        yield ipnsRecordBytes;
      };

      const recordCID = await fs.addFile({ content: recordGenerator() });
      const recordCIDString = recordCID.toString();

      // Store mapping in IPFS as well, so other nodes can find it
      // Create a mapping object: { peerId: recordCID }
      const mapping = {
        peerId: peerId.toString(),
        recordCID: recordCIDString,
        metadataCID: cidString,
      };

      const mappingGenerator = async function* () {
        yield new TextEncoder().encode(JSON.stringify(mapping));
      };

      const mappingCID = await fs.addFile({ content: mappingGenerator() });
      const mappingCIDString = mappingCID.toString();

      // Store mapping CID in local datastore for quick lookup
      const datastore = helia.datastore;
      const ipnsKeyBytes = new TextEncoder().encode(
        `/ipns/${peerId.toString()}`,
      );
      const mappingCIDBytes = new TextEncoder().encode(mappingCIDString);
      await datastore.put(ipnsKeyBytes, mappingCIDBytes);

      published = true;
      logger.info(
        `✅ Stored IPNS record in IPFS: ${ipnsKey} -> ${cidString} (record: ${recordCIDString}, mapping: ${mappingCIDString})`,
      );
      logger.info(
        `⚠️ Note: Using IPFS storage for testing. For production, use DHT or @helia/ipns.`,
      );

      // Return mapping CID for cross-node access
      return {
        ipnsKey,
        metadataCID: cidString,
        ipnsRecord: ipnsRecordBytes,
        published,
        mappingCID: mappingCIDString, // For cross-node access
        recordCID: recordCIDString,
      };
    }

    return {
      ipnsKey,
      metadataCID: cidString,
      ipnsRecord: ipnsRecordBytes,
      published,
    };
  } catch (error) {
    logger.error(`Error publishing to IPNS: ${error.message}`);
    // Fallback: return the record even if publish fails
    logger.warn(
      `⚠️ IPNS publish failed, but IPNS record created: ${error.message}`,
    );
    return {
      ipnsKey,
      metadataCID: cidString,
      ipnsRecord: ipnsRecordBytes,
      published: false,
    };
  }
}

/**
 * Resolve IPNS key to get metadata CID
 * @param {Object} helia - Helia instance
 * @param {Object} publicKey - Public key or peer ID
 * @returns {Promise<string>} - Metadata CID
 */
export async function resolveIPNS(helia, publicKey) {
  const _libp2p = helia.libp2p;
  const peerId = await publicKey.toPeerId();
  const ipnsKey = `/ipns/${peerId.toString()}`;

  logger.info(`📥 Resolving IPNS key: ${ipnsKey}`);

  try {
    // Try to use @helia/ipns if available, otherwise use local datastore
    try {
      // Try @helia/ipns first
      const { ipns: ipnsModule } = await import("@helia/ipns");
      const name = ipnsModule(helia);
      const resolvedCID = await name.resolve(peerId);
      const cidString = resolvedCID.toString();
      logger.info(`✅ Resolved IPNS using @helia/ipns to CID: ${cidString}`);
      return cidString;
    } catch (importError) {
      // @helia/ipns not available, read from IPFS
      logger.info(`@helia/ipns not available, reading from IPFS`);

      // Try to get mapping CID from local datastore first
      let mappingCIDString = null;
      try {
        const datastore = helia.datastore;
        const ipnsKeyBytes = new TextEncoder().encode(
          `/ipns/${peerId.toString()}`,
        );
        const mappingCIDBytes = await datastore.get(ipnsKeyBytes);
        if (mappingCIDBytes && mappingCIDBytes.length > 0) {
          mappingCIDString = new TextDecoder().decode(mappingCIDBytes);
        }
      } catch (e) {
        // Mapping not in local datastore, will need to search IPFS
        logger.info(`Mapping not in local datastore, will search IPFS`);
      }

      // If we have mapping CID, use it; otherwise we need to find it
      // For now, if mapping is not found, throw error
      // In production, you would search DHT or use a different discovery mechanism
      if (!mappingCIDString) {
        throw new Error(
          `IPNS record mapping not found for ${ipnsKey}. The mapping must be published first.`,
        );
      }

      // Download mapping from IPFS
      const { unixfs: unixfsModule } = await import("@helia/unixfs");
      const fs = unixfsModule(helia);
      const mappingCID = CID.parse(mappingCIDString);

      const mappingChunks = [];
      for await (const chunk of fs.cat(mappingCID)) {
        mappingChunks.push(chunk);
      }

      const mappingLength = mappingChunks.reduce(
        (acc, chunk) => acc + chunk.length,
        0,
      );
      const mappingBytes = new Uint8Array(mappingLength);
      let mappingOffset = 0;
      for (const chunk of mappingChunks) {
        mappingBytes.set(chunk, mappingOffset);
        mappingOffset += chunk.length;
      }

      const mapping = JSON.parse(new TextDecoder().decode(mappingBytes));
      const recordCIDString = mapping.recordCID;
      const recordCID = CID.parse(recordCIDString);

      // Download IPNS record from IPFS
      const chunks = [];
      for await (const chunk of fs.cat(recordCID)) {
        chunks.push(chunk);
      }

      // Combine chunks
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const ipnsRecordBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        ipnsRecordBytes.set(chunk, offset);
        offset += chunk.length;
      }

      // Unmarshal IPNS record
      const ipnsRecord = unmarshalIPNSRecord(ipnsRecordBytes);

      // Extract CID from IPNS record
      const cidBytes = ipnsRecord.value;
      const cid = CID.decode(cidBytes);
      const cidString = cid.toString();

      logger.info(`✅ Resolved IPNS from IPFS to CID: ${cidString}`);

      return cidString;
    }
  } catch (error) {
    logger.error(`Error resolving IPNS: ${error.message}`);
    throw error;
  }
}

/**
 * Download and parse metadata from IPFS
 * @param {Object} helia - Helia instance
 * @param {string} cid - CID of metadata
 * @returns {Promise<Object>} - Parsed metadata object
 */
export async function getMetadataFromIPFS(helia, cid) {
  const { unixfs: unixfsModule } = await import("@helia/unixfs");
  const fs = unixfsModule(helia);

  const cidObj = CID.parse(cid);

  // Download from IPFS network
  const chunks = [];
  for await (const chunk of fs.cat(cidObj)) {
    chunks.push(chunk);
  }

  // Combine chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const allBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    allBytes.set(chunk, offset);
    offset += chunk.length;
  }

  // Parse JSON
  const jsonString = new TextDecoder().decode(allBytes);
  const metadata = JSON.parse(jsonString);

  logger.info(`📄 Retrieved metadata from IPFS`);

  return metadata;
}
