<script>
  import StorachaTestWithReplication from "$lib/StorachaTestWithReplication.svelte";
  import { theme } from "$lib/theme.js";
  import {
    Content,
    Header,
    HeaderUtilities,
    Button,
    Toggle,
  } from "carbon-components-svelte";
  import { Light, Asleep } from "carbon-icons-svelte";
  import { onMount } from "svelte";

  onMount(() => {
    // Create floating particles
    const particlesContainer = document.querySelector(".particles");
    if (particlesContainer) {
      for (let i = 0; i < 50; i++) {
        const particle = document.createElement("div");
        particle.className = "particle";
        particle.style.left = Math.random() * 100 + "%";
        particle.style.animationDelay = Math.random() * 15 + "s";
        particle.style.animationDuration = 15 + Math.random() * 10 + "s";
        particlesContainer.appendChild(particle);
      }
    }
  });

  function toggleTheme() {
    theme.toggle();
  }

  $: isDark = $theme === "g100";
</script>

<svelte:head>
  <title>OrbitDB Storacha Backup Restore with Replication Test</title>
  <meta
    name="description"
    content="Test the OrbitDB Storacha Backup Restore functionality"
  />
</svelte:head>

<!-- Floating particles background -->
<div class="particles"></div>

<Header company="OrbitDB Storacha Bridge">
  <HeaderUtilities>
    <Button
      kind="ghost"
      size="sm"
      icon={isDark ? Light : Asleep}
      iconDescription={isDark ? "Switch to light mode" : "Switch to dark mode"}
      on:click={toggleTheme}
    >
      {isDark ? "Light" : "Dark"}
    </Button>
  </HeaderUtilities>
</Header>

<Content>
  <div style="display:flex;justify-content:center;margin:2rem 0;">
    <div>
      <div style="display:flex;justify-content:center;margin-bottom:1rem;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="120"
          height="120"
          viewBox="0 0 32 32"
        >
          <defs>
            <linearGradient
              id="orbitGradient"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" style="stop-color:#4F46E5;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#7C3AED;stop-opacity:1" />
            </linearGradient>
            <linearGradient
              id="storageGradient"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" style="stop-color:#06B6D4;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#0891B2;stop-opacity:1" />
            </linearGradient>
          </defs>
          <circle
            cx="16"
            cy="16"
            r="15"
            fill="var(--cds-layer)"
            stroke="var(--cds-border-subtle)"
            stroke-width="1"
          />
          <circle cx="16" cy="16" r="4" fill="url(#storageGradient)" />
          <g class="orbit-animation" style="transform-origin: 16px 16px;">
            <ellipse
              cx="16"
              cy="16"
              rx="10"
              ry="6"
              fill="none"
              stroke="url(#orbitGradient)"
              stroke-width="1.5"
              opacity="0.8"
            />
            <ellipse
              cx="16"
              cy="16"
              rx="6"
              ry="10"
              fill="none"
              stroke="url(#orbitGradient)"
              stroke-width="1.5"
              opacity="0.8"
            />
            <circle cx="26" cy="16" r="1.5" fill="url(#orbitGradient)" />
            <circle cx="6" cy="16" r="1.5" fill="url(#orbitGradient)" />
            <circle cx="16" cy="6" r="1.5" fill="url(#orbitGradient)" />
            <circle cx="16" cy="26" r="1.5" fill="url(#orbitGradient)" />
          </g>
          <path
            d="M12 12 Q10 10 8 12 Q6 14 8 16 Q10 18 12 16 Q14 14 12 12"
            fill="url(#storageGradient)"
            opacity="0.6"
          />
          <path
            d="M20 20 Q22 18 24 20 Q26 22 24 24 Q22 26 20 24 Q18 22 20 20"
            fill="url(#storageGradient)"
            opacity="0.6"
          />
        </svg>
      </div>
      <h1
        style="text-align:center;margin:0 0 0.5rem 0;"
        class="gradient-text-purple"
      >
        OrbitDB Storacha Bridge
      </h1>
      <p
        style="text-align:center;margin:0 0 1rem 0;color:var(--cds-text-secondary);"
      >
        Test backup and restore with P2P replication via <span
          class="gradient-text-cyan"
          style="font-weight:600;">Storacha/Filecoin</span
        >
      </p>
      <p
        style="text-align:center;color:var(--cds-text-helper);font-size:0.875rem;"
      >
        Decentralized Filecoin Storage for Local-First Peer-To-Peer Web & Mobile
        Apps
      </p>
      
      <!-- Technology Stack Logos Row -->
      <div style="display:flex;align-items:center;justify-content:center;gap:1.5rem;margin-top:1.5rem;flex-wrap:wrap;">
        <a href="https://orbitdb.org/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/orbitdb.png" alt="OrbitDB" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">OrbitDB</span>
        </a>
        <a href="https://docs.storacha.network/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/storacha-logo.jpeg" alt="Storacha" style="width:20px;height:20px;object-fit:contain;border-radius:4px;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">Storacha</span>
        </a>
        <a href="https://helia.io/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/helia.svg" alt="Helia" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">Helia</span>
        </a>
        <a href="https://docs.ipfs.tech/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/ipfs.png" alt="IPFS" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">IPFS</span>
        </a>
        <a href="https://docs.libp2p.io/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/libp2p.png" alt="libp2p" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">libp2p</span>
        </a>
        <a href="https://docs.filecoin.io/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/filecoin.svg" alt="Filecoin" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">Filecoin</span>
        </a>
        <a href="https://protocol.ai/" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:0.25rem;text-decoration:none;color:inherit;">
          <img src="/protocol-labs.png" alt="Protocol Labs" style="width:20px;height:20px;object-fit:contain;" />
          <span style="font-size:0.75rem;color:var(--cds-text-secondary);">Protocol Labs</span>
        </a>
      </div>
    </div>
  </div>

  <div
    class="orbital-card"
    style="border-radius:1rem;padding:1rem;margin:0 auto;"
  >
    <StorachaTestWithReplication />
  </div>

  <div style="text-align:center;margin:2rem 0;color:var(--cds-text-secondary);">
    <small>OrbitDB Storacha Bridge with P2P Replication Demo</small>
    <div
      style="margin-top:0.5rem;color:var(--cds-text-helper);font-size:0.75rem;"
    >
      Real-time peer-to-peer database replication with decentralized backup/restore
    </div>
  </div>
</Content>
