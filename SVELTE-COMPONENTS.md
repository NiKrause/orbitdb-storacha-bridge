# Storacha Svelte Components

This document provides detailed documentation for the Svelte components included in the OrbitDB-Storacha-Bridge project for browser-based integration.

## Table of Contents

- [Storacha Svelte Components](#storacha-svelte-components)
  - [Table of Contents](#table-of-contents)
  - [Component Overview](#component-overview)
  - [StorachaAuth.svelte](#storachaauthsvelte)
  - [StorachaTest.svelte](#storachatestsvelte)
  - [StorachaTestWithReplication.svelte](#storachatestwithreplicationsvelte)
  - [StorachaTestWithWebAuthn.svelte](#storachatestwithwebauthnsvelte)
  - [WebAuthnDIDProvider.js](#webauthndidproviderjs)
  - [StorachaIntegration.svelte](#storachaintegrationsvelte)
  - [Svelte App Demos](#svelte-app-demos)
  - [Live Demo](#live-demo)
  - [Return to Main Documentation](#return-to-main-documentation)

## Component Overview

The OrbitDB-Storacha-Bridge project includes **Svelte components** for browser-based demos and integration. These components provide various authentication methods, backup/restore functionality, and P2P replication capabilities.

## StorachaAuth.svelte

**Location:** [`src/components/StorachaAuth.svelte`](src/components/StorachaAuth.svelte)

Authentication component supporting multiple Storacha authentication methods:

- Storacha credentials (Storacha-Key and Storacha Proof)
- UCAN authentication (delegated UCAN + corresponding temporary private key)
- WebAuthN/Passkey (P-256) UCANs and delegation (planed)

## StorachaTest.svelte

**Location:** [`src/components/StorachaTest.svelte`](src/components/StorachaTest.svelte)

Basic backup/restore demo with Alice & Bob using independent OrbitDB instances:

- Creates separate OrbitDB databases with different addresses
- No P2P replication - data exchange via Storacha backup/restore only
- Demonstrates entry-only backup approach (recreates database from entries + config)
- Uses mnemonic seed generation and DID-based identity management

## StorachaTestWithReplication.svelte

**Location:** [`src/components/StorachaTestWithReplication.svelte`](src/components/StorachaTestWithReplication.svelte)

Advanced replication demo with Alice & Bob using shared database and P2P connectivity:

- Creates shared OrbitDB database with same address for both peers
- Full P2P replication via libp2p with circuit relay support  
- Backup/restore preserves replication capabilities
- Uses Carbon Design System components for enhanced UI

## StorachaTestWithWebAuthn.svelte

**Location:** [`src/components/StorachaTestWithWebAuthn.svelte`](src/components/StorachaTestWithWebAuthn.svelte)

WebAuthn biometric authentication demo with hardware-secured DID identities:

- WebAuthn biometric authentication (Face ID, Touch ID, Windows Hello, PIN)
- Hardware-secured DID creation using WebAuthn credentials
- CBOR public key parsing from WebAuthn attestation objects
- Backup/restore with biometric-secured identities

## WebAuthnDIDProvider.js

**Location:** [`src/components/WebAuthnDIDProvider.js`](src/components/WebAuthnDIDProvider.js)

WebAuthn DID Provider for OrbitDB - Complete identity provider implementation:

- WebAuthn integration with OrbitDB's identity system
- Public key extraction from WebAuthn credentials via CBOR parsing
- DID specification compliance (`did:webauthn:...` format)
- Hardware-secured private keys that never leave the secure element
- Biometric authentication for every signing operation

## StorachaIntegration.svelte

**Location:** [`src/components/StorachaIntegration.svelte`](src/components/StorachaIntegration.svelte)

Full integration component for existing OrbitDB Svelte applications:

- Hash and identity preserving backup/restore (full database reconstruction)
- Progress tracking with real-time upload/download indicators
- LocalStorage credential management with auto-login
- Space management (create, list, select Storacha spaces)
- Note: Currently has browser limitations for full hash preservation ([Issue #4](../../issues/4))

## Svelte App Demos

In the examples/svelte diretory you find three simple to advanced OrbitDB-Storacha examples.

- simple-backup-restore (Alice creates a db and a Storacha backup - Bob restores it into his own - no replication)
- orbitdb-replication (Alice creates a db with todos and creates a backup - Bob replicates it (but cannot add Todo's because of missing access permissions)  )
- ucan-delegation (P-256 UCAN's currently not supported by Storacha upload-service)

## Live Demo

<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 2rem; margin: 2rem 0;">

<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 30px rgba(0,0,0,0.2);">
<h3 style="color: white; margin-top: 0; margin-bottom: 1rem; font-size: 1.25rem;">Storacha Integration Widget in Simple TODO Example</h3>
<div style="position: relative; padding-bottom: 75%; height: 0; overflow: hidden; border-radius: 8px; background: #000;">
<iframe 
  src="https://simple-todo.le-space.de/" 
  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
  allow="clipboard-read; clipboard-write"
  title="Storacha Integration Widget Demo"
></iframe>
</div>
</div>

<div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 30px rgba(0,0,0,0.2);">
<h3 style="color: white; margin-top: 0; margin-bottom: 1rem; font-size: 1.25rem;">Simple Backup & Restore Demo</h3>
<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; background: #000;">
<iframe 
  src="https://www.youtube.com/embed/Bzeg5gHlQvE" 
  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
  allowfullscreen
  title="Simple Backup & Restore Live Demo"
></iframe>
</div>
</div>

<div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 30px rgba(0,0,0,0.2);">
<h3 style="color: white; margin-top: 0; margin-bottom: 1rem; font-size: 1.25rem;">OrbitDB Replication Demo</h3>
<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; background: #000;">
<iframe 
  src="https://www.youtube.com/embed/ZOYeMIiVwr8" 
  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
  allowfullscreen
  title="OrbitDB Replication Live Demo"
></iframe>
</div>
</div>

</div>

## Return to Main Documentation

[← Back to README](README.md)
