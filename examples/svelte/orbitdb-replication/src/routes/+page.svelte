<script>
  import ReplicationDemo from "$lib/ReplicationDemo.svelte";
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
  <title>OrbitDB Storage Bridge: Replication</title>
  <meta
    name="description"
    content="Replicate an OrbitDB database between two peers, and back it up to Aleph, Pinata or Lighthouse"
  />
</svelte:head>

<!-- Floating particles background -->
<div class="particles"></div>

<Header company="OrbitDB Storage Bridge">
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
  <!-- Hero Section -->
  <div class="hero-section">
    <div class="hero-content">
      <div class="logo-container">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="120"
          height="120"
          viewBox="0 0 32 32"
          class="hero-logo"
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
          <circle cx="16" cy="16" r="4" fill="url(#storageGradient)" class="pulse-animation" />
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

      <h1 class="hero-title gradient-text-purple">
        OrbitDB Storage Bridge
      </h1>

      <p class="hero-subtitle">
        Peer-to-peer replication, with backups to <span
          class="gradient-text-cyan"
          style="font-weight:600;">Aleph, Pinata or Lighthouse</span
        >
      </p>

      <p class="hero-description">
        Bridge local-first peer-to-peer databases with decentralized storage
      </p>

      <!-- Feature Pills -->
      <div class="feature-pills">
        <div class="feature-pill">
          <span class="pill-icon">🔐</span>
          <span>Identity Preservation</span>
        </div>
        <div class="feature-pill">
          <span class="pill-icon">🔄</span>
          <span>P2P Replication</span>
        </div>
        <div class="feature-pill">
          <span class="pill-icon">📦</span>
          <span>CAR Archives</span>
        </div>
        <div class="feature-pill">
          <span class="pill-icon">⚡</span>
          <span>IPFS Network</span>
        </div>
        <div class="feature-pill">
          <span class="pill-icon">🌐</span>
          <span>Browser & Node.js</span>
        </div>
      </div>

      <!-- Technology Stack -->
      <div class="tech-stack">
        <div class="tech-stack-label">Powered by</div>
        <div class="tech-logos">
          <a href="https://orbitdb.org/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/orbitdb.png" alt="OrbitDB" />
            <span>OrbitDB</span>
          </a>
          <a href="https://helia.io/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/helia.svg" alt="Helia" />
            <span>Helia</span>
          </a>
          <a href="https://docs.ipfs.tech/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/ipfs.png" alt="IPFS" />
            <span>IPFS</span>
          </a>
          <a href="https://docs.libp2p.io/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/libp2p.png" alt="libp2p" />
            <span>libp2p</span>
          </a>
          <a href="https://docs.filecoin.io/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/filecoin.svg" alt="Filecoin" />
            <span>Filecoin</span>
          </a>
          <a href="https://protocol.ai/" target="_blank" rel="noopener noreferrer" class="tech-link">
            <img src="/protocol-labs.png" alt="Protocol Labs" />
            <span>Protocol Labs</span>
          </a>
        </div>
      </div>
    </div>
  </div>

  <div
    class="orbital-card"
    style="border-radius:1rem;padding:1rem;margin:0 auto;"
  >
    <ReplicationDemo />
  </div>

  <!-- Footer -->
  <footer class="app-footer">
    <div class="footer-content">
      <div class="footer-section">
        <h3>Resources</h3>
        <ul>
          <li><a href="https://github.com/NiKrause/orbitdb-storage-bridge" target="_blank" rel="noopener noreferrer">GitHub</a></li>
          <li><a href="https://github.com/NiKrause/orbitdb-storage-bridge#readme" target="_blank" rel="noopener noreferrer">Documentation</a></li>
          <li><a href="https://github.com/NiKrause/orbitdb-storage-bridge/issues" target="_blank" rel="noopener noreferrer">Issues</a></li>
        </ul>
      </div>
      <div class="footer-section">
        <h3>Learn More</h3>
        <ul>
          <li><a href="https://orbitdb.org/" target="_blank" rel="noopener noreferrer">OrbitDB</a></li>
          <li><a href="https://aleph.cloud/" target="_blank" rel="noopener noreferrer">Aleph</a></li>
          <li><a href="https://pinata.cloud/" target="_blank" rel="noopener noreferrer">Pinata</a></li>
          <li><a href="https://lighthouse.storage/" target="_blank" rel="noopener noreferrer">Lighthouse</a></li>
          <li><a href="https://docs.ipfs.tech/" target="_blank" rel="noopener noreferrer">IPFS</a></li>
        </ul>
      </div>
      <div class="footer-section">
        <h3>Community</h3>
        <ul>
          <li><a href="https://protocol.ai/" target="_blank" rel="noopener noreferrer">Protocol Labs</a></li>
          <li><a href="https://filecoin.io/" target="_blank" rel="noopener noreferrer">Filecoin</a></li>
          <li><a href="https://docs.libp2p.io/" target="_blank" rel="noopener noreferrer">libp2p</a></li>
        </ul>
      </div>
      <div class="footer-section footer-about">
        <h3>OrbitDB Storage Bridge</h3>
        <p>Bridging local-first peer-to-peer databases with decentralized storage: Aleph, Pinata and Lighthouse.</p>
        <p class="footer-license">MIT License</p>
      </div>
    </div>
    <div class="footer-bottom">
      <p>Real-time peer-to-peer database replication with decentralized backup/restore</p>
    </div>
  </footer>
</Content>
