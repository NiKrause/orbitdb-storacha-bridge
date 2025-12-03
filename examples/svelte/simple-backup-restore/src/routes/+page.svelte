<script>
  import StorachaTestWithWebAuthn from "$lib/StorachaTestWithWebAuthn.svelte"
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
  <title>OrbitDB Storacha Backup Restore Test</title>
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

<Content style="padding: 0;">
  <!-- Hero Section -->
  <div class="hero-section">
    <div class="hero-content">
      <!-- Animated Logo -->
      <div class="logo-container">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="140"
          height="140"
          viewBox="0 0 32 32"
          class="main-logo"
        >
          <defs>
            <linearGradient id="orbitGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#667EEA;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#764BA2;stop-opacity:1" />
            </linearGradient>
            <linearGradient id="storageGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#06B6D4;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#3B82F6;stop-opacity:1" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          
          <!-- Outer ring with gradient -->
          <circle cx="16" cy="16" r="14" fill="none" stroke="url(#orbitGradient)" stroke-width="0.5" opacity="0.3"/>
          
          <!-- Main orbital paths -->
          <g class="orbit-animation" style="transform-origin: 16px 16px;">
            <ellipse cx="16" cy="16" rx="12" ry="7" fill="none" stroke="url(#orbitGradient)" stroke-width="1" opacity="0.6" stroke-dasharray="2,1"/>
            <ellipse cx="16" cy="16" rx="7" ry="12" fill="none" stroke="url(#orbitGradient)" stroke-width="1" opacity="0.6" stroke-dasharray="2,1"/>
            
            <!-- Orbiting nodes -->
            <circle cx="28" cy="16" r="2" fill="url(#storageGradient)" filter="url(#glow)">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" repeatCount="indefinite"/>
            </circle>
            <circle cx="4" cy="16" r="2" fill="url(#storageGradient)" filter="url(#glow)">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="0.75s" repeatCount="indefinite"/>
            </circle>
            <circle cx="16" cy="4" r="2" fill="url(#storageGradient)" filter="url(#glow)">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="1.5s" repeatCount="indefinite"/>
            </circle>
            <circle cx="16" cy="28" r="2" fill="url(#storageGradient)" filter="url(#glow)">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" begin="2.25s" repeatCount="indefinite"/>
            </circle>
          </g>
          
          <!-- Central core -->
          <circle cx="16" cy="16" r="5" fill="url(#storageGradient)" filter="url(#glow)"/>
          <circle cx="16" cy="16" r="3" fill="var(--cds-background)" opacity="0.8"/>
        </svg>
      </div>

      <!-- Title and Description -->
      <h1 class="hero-title">
        <span class="gradient-text">OrbitDB</span>
        <span class="connector">×</span>
        <span class="gradient-text-alt">Storacha</span>
      </h1>
      
      <p class="hero-subtitle">
        Bridging distributed databases with decentralized storage
      </p>
      
      <p class="hero-description">
        Seamlessly backup and restore your OrbitDB databases to Filecoin's permanent storage network
        through Storacha's powerful infrastructure
      </p>

      <!-- Feature Pills -->
      <div class="feature-pills">
        <span class="pill">🔐 Identity Preservation</span>
        <span class="pill">🌐 P2P Replication</span>
        <span class="pill">💾 CAR Archives</span>
        <span class="pill">🔑 UCAN Auth</span>
        <span class="pill">⚡ WebAuthn</span>
      </div>

      <!-- Technology Stack with better styling -->
      <div class="tech-stack">
        <a href="https://orbitdb.org/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/orbitdb.png" alt="OrbitDB" />
          <span>OrbitDB</span>
        </a>
        <a href="https://docs.storacha.network/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/storacha-logo.jpeg" alt="Storacha" style="border-radius:4px;" />
          <span>Storacha</span>
        </a>
        <a href="https://helia.io/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/helia.svg" alt="Helia" />
          <span>Helia</span>
        </a>
        <a href="https://docs.ipfs.tech/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/ipfs.png" alt="IPFS" />
          <span>IPFS</span>
        </a>
        <a href="https://docs.libp2p.io/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/libp2p.png" alt="libp2p" />
          <span>libp2p</span>
        </a>
        <a href="https://docs.filecoin.io/" target="_blank" rel="noopener noreferrer" class="tech-item">
          <img src="/filecoin.svg" alt="Filecoin" />
          <span>Filecoin</span>
        </a>
      </div>
    </div>
  </div>

  <!-- Main Content Area -->
  <div class="main-content">
    <div class="content-card">
    <StorachaTestWithWebAuthn />
    </div>
  </div>

  <!-- Footer Section -->
  <footer class="footer-section">
    <div class="footer-content">
      <div class="footer-logo">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 32 32">
          <defs>
            <linearGradient id="footerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#667EEA;stop-opacity:0.6" />
              <stop offset="100%" style="stop-color:#764BA2;stop-opacity:0.6" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="14" fill="none" stroke="url(#footerGradient)" stroke-width="1" opacity="0.5"/>
          <circle cx="16" cy="16" r="3" fill="url(#footerGradient)"/>
        </svg>
      </div>
      <p class="footer-text">OrbitDB Storacha Bridge</p>
      <p class="footer-subtext">Bridging distributed databases with decentralized storage</p>
      <div class="footer-links">
        <a href="https://github.com/NiKrause/orbitdb-storacha-bridge" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="separator">•</span>
        <a href="https://docs.storacha.network/" target="_blank" rel="noopener noreferrer">Storacha Docs</a>
        <span class="separator">•</span>
        <a href="https://orbitdb.org/" target="_blank" rel="noopener noreferrer">OrbitDB</a>
    </div>
  </div>
  </footer>
</Content>
