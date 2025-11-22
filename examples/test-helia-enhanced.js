#!/usr/bin/env node
/**
 * Enhanced Helia connectivity test with multiple transports and peer discovery
 * Based on patterns from https://github.com/ipfs-examples/helia-examples
 */

import { createLibp2p } from "libp2p";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { bootstrap } from "@libp2p/bootstrap";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { createHelia } from "helia";
import { CID } from "multiformats/cid";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";

// Enhanced bootstrap nodes list
const BOOTSTRAP_NODES = [
  // Official IPFS bootstrap nodes
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  // Direct IP bootstrap (more reliable in restricted networks)
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  '/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];

async function testEnhancedConnectivity() {
  console.log('🚀 Enhanced Helia IPFS Connectivity Test');
  console.log('   Based on https://github.com/ipfs-examples/helia-examples\n');
  console.log('═'.repeat(70));
  
  let helia, libp2p, blockstore, datastore;
  
  try {
    // Configuration
    console.log('\n📦 Creating libp2p with enhanced configuration');
    console.log(`   Transport: TCP (port 0 - random)`);
    console.log(`   Bootstrap nodes: ${BOOTSTRAP_NODES.length}`);
    console.log(`   Peer discovery: bootstrap`);
    console.log(`   Connection encrypter: Noise`);
    console.log(`   Stream muxer: Yamux`);
    
    const libp2pConfig = {
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0',  // Listen on random TCP port
        ]
      },
      transports: [
        tcp({
          // Enable connection limits
          maxConnections: 300,
          closeServerOnMaxConnections: {
            closeAbove: 300,
            listenBelow: 250
          }
        })
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        bootstrap({
          list: BOOTSTRAP_NODES,
          timeout: 10000, // 10 second timeout per dial
          tagName: 'bootstrap',
          tagValue: 50,
          tagTTL: 120000 // 2 minutes
        })
      ],
      services: {
        identify: identify(),
        pubsub: gossipsub({ 
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
          // Enable for better connectivity
          directPeers: [],
          doPX: true,
          // Adjust heartbeat for faster discovery
          heartbeatInterval: 1000
        }),
      },
      connectionManager: {
        minConnections: 25,
        maxConnections: 300,
        // Auto-dial known peers
        autoDial: true,
        autoDialInterval: 10000
      },
    };
    
    libp2p = await createLibp2p(libp2pConfig);
    console.log('✅ libp2p created successfully');
    console.log(`   Peer ID: ${libp2p.peerId.toString()}`);
    console.log(`   Addresses: ${libp2p.getMultiaddrs().length > 0 ? libp2p.getMultiaddrs()[0] : 'none'}`);
    
    // Event listeners
    console.log('\n🔍 Setting up event listeners');
    
    let discoveredPeers = new Set();
    let connectedPeers = new Set();
    let failedConnections = 0;
    
    libp2p.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      if (!discoveredPeers.has(peerId)) {
        discoveredPeers.add(peerId);
        console.log(`   📡 Discovered: ${peerId.substring(0, 20)}... (total: ${discoveredPeers.size})`);
      }
    });
    
    libp2p.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      if (!connectedPeers.has(peerId)) {
        connectedPeers.add(peerId);
        console.log(`   ✅ Connected: ${peerId.substring(0, 20)}... (total: ${connectedPeers.size})`);
      }
    });
    
    libp2p.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      connectedPeers.delete(peerId);
      console.log(`   ❌ Disconnected: ${peerId.substring(0, 20)}... (remaining: ${connectedPeers.size})`);
    });
    
    // Connection manager events
    libp2p.addEventListener('connection:prune', () => {
      console.log('   🔄 Connection manager pruned connections');
    });
    
    // Monitor connection attempts
    console.log('\n⏳ Monitoring for 45 seconds...');
    console.log('   Waiting for peer discovery and connections...\n');
    
    const startTime = Date.now();
    const monitorInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const peers = libp2p.getPeers();
      const connections = libp2p.getConnections();
      
      console.log(`   [${elapsed}s] Peers: ${peers.length} | Connections: ${connections.length} | Discovered: ${discoveredPeers.size}`);
      
      if (peers.length > 0 && elapsed >= 15) {
        console.log('\n✅ Early success! Connected to peers.');
        clearInterval(monitorInterval);
      }
    }, 5000);
    
    // Wait for connections
    await new Promise(resolve => setTimeout(resolve, 45000));
    clearInterval(monitorInterval);
    
    // Results
    const finalPeers = libp2p.getPeers();
    const connections = libp2p.getConnections();
    
    console.log('\n' + '═'.repeat(70));
    console.log('📊 FINAL RESULTS');
    console.log('═'.repeat(70));
    console.log(`   Discovered peers: ${discoveredPeers.size}`);
    console.log(`   Connected peers: ${finalPeers.length}`);
    console.log(`   Active connections: ${connections.length}`);
    
    if (finalPeers.length > 0) {
      console.log('\n✅ SUCCESS! Connected to IPFS public network');
      console.log('\n📋 Connected peers (top 10):');
      finalPeers.slice(0, 10).forEach((peer, i) => {
        console.log(`   ${i + 1}. ${peer.toString()}`);
      });
      if (finalPeers.length > 10) {
        console.log(`   ... and ${finalPeers.length - 10} more`);
      }
      
      // Test Helia
      console.log('\n📦 Creating Helia instance...');
      const uniqueId = `${Date.now()}-enhanced-test`;
      blockstore = new LevelBlockstore(`./helia-test-${uniqueId}`);
      datastore = new LevelDatastore(`./helia-test-${uniqueId}-data`);
      
      helia = await createHelia({ libp2p, blockstore, datastore });
      console.log('✅ Helia created and ready for use!');
      
    } else {
      console.log('\n⚠️  NO CONNECTIONS ESTABLISHED');
      console.log('\n🔍 Diagnostic Information:');
      console.log(`   • Discovered ${discoveredPeers.size} peers but could not connect`);
      console.log('   • This might indicate:');
      console.log('     - Firewall blocking outbound P2P connections');
      console.log('     - NAT traversal issues');
      console.log('     - Network restrictions (corporate/institutional)');
      console.log('     - Bootstrap nodes temporarily unavailable');
      console.log('\n💡 Recommendations:');
      console.log('   1. Check if ports 4001-4003 are allowed for outbound TCP');
      console.log('   2. Try running from a different network');
      console.log('   3. Use gateway fallback (which is already implemented)');
      console.log('   4. Consider using WebSocket transport for browser environments');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    
    if (helia) {
      await helia.stop();
      console.log('   ✓ Helia stopped');
    }
    
    if (libp2p && libp2p.status === 'started') {
      await libp2p.stop();
      console.log('   ✓ libp2p stopped');
    }
    
    if (blockstore) {
      await blockstore.close();
      console.log('   ✓ Blockstore closed');
    }
    
    if (datastore) {
      await datastore.close();
      console.log('   ✓ Datastore closed');
    }
    
    // Clean up test directories
    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir('.');
      for (const file of files) {
        if (file.startsWith('helia-test-')) {
          await fs.rm(file, { recursive: true, force: true });
          console.log(`   ✓ Removed ${file}`);
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
    
    console.log('\n' + '═'.repeat(70));
    console.log('✅ Test completed\n');
    process.exit(0);
  }
}

// Run the test
testEnhancedConnectivity().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

