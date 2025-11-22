<script>
  import { createEventDispatcher, onMount } from "svelte";
  // Import Carbon components and icons
  import {
    Tile,
    Tabs,
    Tab,
    TabContent,
    Button,
    TextInput,
    TextArea,
    PasswordInput,
    InlineNotification,
    Loading,
    Tag,
  } from "carbon-components-svelte";
  import {
    Cloud,
    Key,
    Email,
    Shuffle,
    CheckmarkFilled,
    Logout,
    Reset,
  } from "carbon-icons-svelte";
  import {
    initializeStorachaClient,
    initializeStorachaClientWithUCAN,
    initializeStorachaClientWithSeed,
    createStorachaAccount,
    listSpaces,
    createSpace,
    generateSeedPhrase,
    validateSeedPhrase,
  } from "./storacha-backup.js";

  const dispatch = createEventDispatcher();

  // Component props
  export let autoLogin = true;
  export let showTitle = true;
  export let compact = false;
  export let enableSeedAuth = true;
  export let enableEmailAuth = true;
  import { logger } from "./logger.js";

  // Authentication state
  let isAuthenticated = false;
  let client = null;
  let currentSpace = null;
  let spaces = [];
  let authMethod = null; // 'credentials', 'ucan', 'seed'

  // UI state
  let isLoading = false;
  let status = "";
  let error = null;
  let success = null;
  let activeTab = 0; // 0: credentials, 1: ucan, 2: seed, 3: email

  // Form data
  let email = "";
  let storachaKey = "";
  let storachaProof = "";
  let ucanToken = "";
  let recipientKey = "";
  let seedPhrase = "";
  let seedPassword = "password";
  let delegationToken = "";
  let newSpaceName = "";

  // LocalStorage keys
  const STORAGE_KEYS = {
    STORACHA_KEY: "storacha_key",
    STORACHA_PROOF: "storacha_proof",
    UCAN_TOKEN: "storacha_ucan_token",
    RECIPIENT_KEY: "storacha_recipient_key",
    SEED_PHRASE: "storacha_seed_phrase",
    SEED_PASSWORD: "storacha_seed_password",
    DELEGATION_TOKEN: "storacha_delegation_token",
    AUTH_METHOD: "storacha_auth_method",
    AUTO_LOGIN: "storacha_auto_login",
  };

  // Auto-hide messages
  function showMessage(message, type = "info", duration = 5000) {
    if (type === "error") {
      error = message;
      success = null;
    } else {
      success = message;
      error = null;
    }

    setTimeout(() => {
      error = null;
      success = null;
    }, duration);
  }

  // Save credentials to localStorage
  function saveCredentials(method, data) {
    try {
      localStorage.setItem(STORAGE_KEYS.AUTH_METHOD, method);
      localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN, "true");

      switch (method) {
        case "credentials":
          localStorage.setItem(STORAGE_KEYS.STORACHA_KEY, data.key);
          localStorage.setItem(STORAGE_KEYS.STORACHA_PROOF, data.proof);
          break;
        case "ucan":
          localStorage.setItem(STORAGE_KEYS.UCAN_TOKEN, data.ucanToken);
          localStorage.setItem(STORAGE_KEYS.RECIPIENT_KEY, data.recipientKey);
          break;
        case "seed":
          localStorage.setItem(STORAGE_KEYS.SEED_PHRASE, data.seedPhrase);
          localStorage.setItem(STORAGE_KEYS.SEED_PASSWORD, data.seedPassword);
          if (data.delegationToken) {
            localStorage.setItem(
              STORAGE_KEYS.DELEGATION_TOKEN,
              data.delegationToken,
            );
          }
          break;
      }
    } catch (err) {
      logger.warn("Failed to save credentials:", err);
    }
  }

  // Load credentials from localStorage
  function loadStoredCredentials() {
    try {
      const method = localStorage.getItem(STORAGE_KEYS.AUTH_METHOD);
      const autoLoginEnabled =
        localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN) === "true";

      if (!method || !autoLoginEnabled) return null;

      switch (method) {
        case "credentials": {
          const key = localStorage.getItem(STORAGE_KEYS.STORACHA_KEY);
          const proof = localStorage.getItem(STORAGE_KEYS.STORACHA_PROOF);
          if (key && proof) return { method, key, proof };
          break;
        }
        case "ucan": {
          const ucanToken = localStorage.getItem(STORAGE_KEYS.UCAN_TOKEN);
          const recipientKey = localStorage.getItem(STORAGE_KEYS.RECIPIENT_KEY);
          if (ucanToken && recipientKey)
            return { method, ucanToken, recipientKey };
          break;
        }
        case "seed": {
          const seedPhrase = localStorage.getItem(STORAGE_KEYS.SEED_PHRASE);
          const seedPassword = localStorage.getItem(STORAGE_KEYS.SEED_PASSWORD);
          const delegationToken = localStorage.getItem(
            STORAGE_KEYS.DELEGATION_TOKEN,
          );
          if (seedPhrase && seedPassword)
            return { method, seedPhrase, seedPassword, delegationToken };
          break;
        }
      }
    } catch (err) {
      logger.warn("Failed to load credentials:", err);
    }
    return null;
  }

  // Clear stored credentials
  function clearStoredCredentials() {
    try {
      Object.values(STORAGE_KEYS).forEach((key) => {
        localStorage.removeItem(key);
      });
    } catch (err) {
      logger.warn("Failed to clear credentials:", err);
    }
  }

  // Authentication methods
  async function authenticateWithCredentials() {
    if (!storachaKey.trim() || !storachaProof.trim()) {
      showMessage("Please provide both Storacha key and proof", "error");
      return;
    }

    isLoading = true;
    status = "Authenticating with credentials...";

    try {
      client = await initializeStorachaClient(
        storachaKey.trim(),
        storachaProof.trim(),
      );
      authMethod = "credentials";

      await loadSpaces();

      saveCredentials("credentials", {
        key: storachaKey.trim(),
        proof: storachaProof.trim(),
      });
      isAuthenticated = true;

      showMessage("Successfully authenticated with Storacha credentials!");
      dispatch("authenticated", { client, method: "credentials", spaces });
    } catch (err) {
      showMessage(`Authentication failed: ${err.message}`, "error");
    } finally {
      isLoading = false;
      status = "";
    }
  }

  async function authenticateWithUCAN() {
    if (!ucanToken.trim() || !recipientKey.trim()) {
      showMessage("Please provide both UCAN token and recipient key", "error");
      return;
    }

    isLoading = true;
    status = "Authenticating with UCAN...";

    try {
      client = await initializeStorachaClientWithUCAN(
        ucanToken.trim(),
        recipientKey.trim(),
      );
      authMethod = "ucan";

      await loadSpaces();

      saveCredentials("ucan", {
        ucanToken: ucanToken.trim(),
        recipientKey: recipientKey.trim(),
      });
      isAuthenticated = true;

      showMessage("Successfully authenticated with UCAN delegation!");
      dispatch("authenticated", { client, method: "ucan", spaces });
    } catch (err) {
      showMessage(`UCAN authentication failed: ${err.message}`, "error");
    } finally {
      isLoading = false;
      status = "";
    }
  }

  async function authenticateWithSeed() {
    if (!seedPhrase.trim()) {
      showMessage("Please provide a seed phrase", "error");
      return;
    }

    if (!validateSeedPhrase(seedPhrase.trim())) {
      showMessage("Invalid seed phrase format", "error");
      return;
    }

    isLoading = true;
    status = "Authenticating with seed phrase...";

    try {
      const result = await initializeStorachaClientWithSeed(
        seedPhrase.trim(),
        seedPassword.trim() || "password",
        delegationToken.trim() || null,
      );

      client = result.client;
      authMethod = "seed";

      await loadSpaces();

      saveCredentials("seed", {
        seedPhrase: seedPhrase.trim(),
        seedPassword: seedPassword.trim() || "password",
        delegationToken: delegationToken.trim(),
      });
      isAuthenticated = true;

      const message = delegationToken.trim()
        ? "Successfully authenticated with seed phrase and delegation!"
        : "Authenticated with seed phrase (limited functionality without delegation)";
      showMessage(message);
      dispatch("authenticated", {
        client,
        method: "seed",
        identity: result.identity,
        spaces,
      });
    } catch (err) {
      showMessage(`Seed authentication failed: ${err.message}`, "error");
    } finally {
      isLoading = false;
      status = "";
    }
  }

  async function createAccount() {
    if (!email.trim()) {
      showMessage("Please enter your email address", "error");
      return;
    }

    isLoading = true;
    status = "Creating account...";

    try {
      const result = await createStorachaAccount(email.trim());
      if (result.success) {
        showMessage(result.message);
      } else {
        showMessage(result.error, "error");
      }
    } catch (err) {
      showMessage(`Account creation failed: ${err.message}`, "error");
    } finally {
      isLoading = false;
      status = "";
    }
  }

  // Space management
  async function loadSpaces() {
    if (!client) return;

    try {
      spaces = await listSpaces(client);
      currentSpace = client.currentSpace();
    } catch (err) {
      logger.warn("Failed to load spaces:", err);
      spaces = [];
    }
  }

  async function createNewSpace() {
    if (!newSpaceName.trim()) {
      showMessage("Please enter a space name", "error");
      return;
    }

    isLoading = true;
    status = "Creating space...";

    try {
      const result = await createSpace(client, newSpaceName.trim());
      if (result.success) {
        showMessage(`Space "${newSpaceName}" created successfully!`);
        newSpaceName = "";
        await loadSpaces();
      } else {
        showMessage(result.error, "error");
      }
    } catch (err) {
      showMessage(`Failed to create space: ${err.message}`, "error");
    } finally {
      isLoading = false;
      status = "";
    }
  }

  async function selectSpace(space) {
    try {
      await client.setCurrentSpace(space.did);
      currentSpace = space;
      showMessage(`Switched to space: ${space.name}`);
      dispatch("spaceChanged", { space });
    } catch (err) {
      showMessage(`Failed to switch space: ${err.message}`, "error");
    }
  }

  // Logout
  function logout() {
    isAuthenticated = false;
    client = null;
    currentSpace = null;
    spaces = [];
    authMethod = null;
    clearStoredCredentials();
    clearForms();
    showMessage("Logged out successfully");
    dispatch("logout");
  }

  // Clear forms
  function clearForms() {
    email = "";
    storachaKey = "";
    storachaProof = "";
    ucanToken = "";
    recipientKey = "";
    seedPhrase = "";
    seedPassword = "password";
    delegationToken = "";
    newSpaceName = "";
  }

  // Helper function to get correct tab index based on enabled auth methods
  function getTabIndex(method) {
    const tabs = ['credentials', 'ucan'];
    if (enableSeedAuth) tabs.push('seed');
    if (enableEmailAuth) tabs.push('email');
    return tabs.indexOf(method);
  }

  // Utility functions
  function generateNewSeedPhrase() {
    seedPhrase = generateSeedPhrase();
    showMessage("New seed phrase generated!");
  }

  // Auto-login on mount
  onMount(async () => {
    if (!autoLogin) return;

    const stored = loadStoredCredentials();
    if (!stored) return;

    logger.info(`🔄 Auto-login with ${stored.method}...`);

    // Check if the stored method is enabled
    const tabIndex = getTabIndex(stored.method);
    if (tabIndex === -1) {
      logger.warn(`Stored auth method '${stored.method}' is disabled`);
      clearStoredCredentials();
      return;
    }

    // Set form values
    switch (stored.method) {
      case "credentials":
        storachaKey = stored.key;
        storachaProof = stored.proof;
        activeTab = tabIndex;
        await authenticateWithCredentials();
        break;
      case "ucan":
        ucanToken = stored.ucanToken;
        recipientKey = stored.recipientKey;
        activeTab = tabIndex;
        await authenticateWithUCAN();
        break;
      case "seed":
        if (!enableSeedAuth) {
          logger.warn("Seed auth is disabled");
          return;
        }
        seedPhrase = stored.seedPhrase;
        seedPassword = stored.seedPassword;
        delegationToken = stored.delegationToken || "";
        activeTab = tabIndex;
        await authenticateWithSeed();
        break;
    }
  });

  // Export authentication status for parent components
  export { isAuthenticated, client, currentSpace, spaces, authMethod };
</script>

<Tile>
  <!-- Header -->
  {#if showTitle}
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;">
      <Cloud size={20} />
      <h3 style="font-size:1.125rem;font-weight:600;margin:0;">
        Storacha Authentication
      </h3>
    </div>
  {/if}

  <!-- Status Messages -->
  {#if error}
    <InlineNotification
      kind="error"
      title="Error"
      subtitle={error}
      style="margin-bottom:1rem;"
    />
  {/if}

  {#if success}
    <InlineNotification
      kind="success"
      title="Success"
      subtitle={success}
      style="margin-bottom:1rem;"
    />
  {/if}

  {#if isLoading && status}
    <InlineNotification
      kind="info"
      title="Processing"
      subtitle={status}
      style="margin-bottom:1rem;"
    >
      <Loading withOverlay={false} small />
    </InlineNotification>
  {/if}

  {#if !isAuthenticated}
    <!-- Authentication Tabs -->
    <Tabs bind:selected={activeTab}>
      <Tab>
        <div style="display:flex;align-items:center;gap:0.25rem;">
          <Key size={16} />
          Credentials
        </div>
      </Tab>
      <Tab>
        <div style="display:flex;align-items:center;gap:0.25rem;">🎫 UCAN</div>
      </Tab>
      {#if enableSeedAuth}
        <Tab>
          <div style="display:flex;align-items:center;gap:0.25rem;">
            <Shuffle size={16} />
            Seed
          </div>
        </Tab>
      {/if}
      {#if enableEmailAuth}
        <Tab>
          <div style="display:flex;align-items:center;gap:0.25rem;">
            <Email size={16} />
            Email
          </div>
        </Tab>
      {/if}

      <svelte:fragment slot="content">
        <TabContent>
          <!-- Credentials Tab -->
          <div style="margin-top:1rem;">
            <h4 style="font-weight:500;margin-bottom:1rem;">
              Storacha Key & Proof
            </h4>
            <div style="display:flex;flex-direction:column;gap:1rem;">
              <PasswordInput
                labelText="Private Key"
                placeholder="MgCZ9...your-storacha-private-key"
                bind:value={storachaKey}
                disabled={isLoading}
                tooltipAlignment="center"
                tooltipPosition="bottom"
              />
              <TextArea
                labelText="Proof (Delegation)"
                placeholder="uCAIS...your-storacha-proof"
                rows={3}
                bind:value={storachaProof}
                disabled={isLoading}
              />
              <Button
                on:click={authenticateWithCredentials}
                disabled={isLoading ||
                  !storachaKey.trim() ||
                  !storachaProof.trim()}
                style="width:100%;"
              >
                {isLoading ? "Authenticating..." : "Login with Credentials"}
              </Button>
            </div>
          </div>
        </TabContent>

        <TabContent>
          <!-- UCAN Tab -->
          <div style="margin-top:1rem;">
            <h4 style="font-weight:500;margin-bottom:1rem;">UCAN Delegation</h4>
            <div style="display:flex;flex-direction:column;gap:1rem;">
              <TextArea
                labelText="UCAN Token (Base64)"
                placeholder="eyJh...base64-encoded-ucan-token"
                rows={3}
                bind:value={ucanToken}
                disabled={isLoading}
              />
              <TextArea
                labelText="Recipient Key (JSON)"
                placeholder="did key as json"
                rows={3}
                bind:value={recipientKey}
                disabled={isLoading}
              />
              <Button
                kind="secondary"
                on:click={authenticateWithUCAN}
                disabled={isLoading ||
                  !ucanToken.trim() ||
                  !recipientKey.trim()}
                style="width:100%;"
              >
                {isLoading ? "Authenticating..." : "Login with UCAN"}
              </Button>
            </div>
          </div>
        </TabContent>

        {#if enableSeedAuth}
          <TabContent>
            <!-- Seed Tab -->
            <div style="margin-top:1rem;">
              <h4 style="font-weight:500;margin-bottom:1rem;">Seed Phrase</h4>
              <div style="display:flex;flex-direction:column;gap:1rem;">
                <div style="display:flex;flex-direction:column;gap:0.5rem;">
                  <div
                    style="display:flex;justify-content:space-between;align-items:center;"
                  >
                    <span style="font-size:0.875rem;font-weight:500;"
                      >Seed Phrase (12-24 words)</span
                    >
                    <Button
                      kind="ghost"
                      size="sm"
                      icon={Reset}
                      on:click={generateNewSeedPhrase}
                      disabled={isLoading}
                    >
                      Generate
                    </Button>
                  </div>
                  <TextArea
                    placeholder="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
                    rows={2}
                    bind:value={seedPhrase}
                    disabled={isLoading}
                  />
                </div>
                <PasswordInput
                  labelText="Password (optional)"
                  placeholder="password"
                  bind:value={seedPassword}
                  disabled={isLoading}
                />
                <div style="display:flex;flex-direction:column;gap:0.5rem;">
                  <TextArea
                    labelText="Delegation Token (optional)"
                    placeholder="eyJh...base64-encoded-delegation-token"
                    rows={2}
                    bind:value={delegationToken}
                    disabled={isLoading}
                  />
                  <p
                    style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;"
                  >
                    Without delegation, you can only create identities but not
                    upload to Storacha
                  </p>
                </div>
                <Button
                  kind="tertiary"
                  on:click={authenticateWithSeed}
                  disabled={isLoading || !seedPhrase.trim()}
                  style="width:100%;"
                >
                  {isLoading ? "Authenticating..." : "Login with Seed"}
                </Button>
              </div>
            </div>
          </TabContent>
        {/if}

        {#if enableEmailAuth}
          <TabContent>
            <!-- Email Tab -->
            <div style="margin-top:1rem;">
              <h4 style="font-weight:500;margin-bottom:1rem;">Create Account</h4>
              <div style="display:flex;flex-direction:column;gap:1rem;">
                <TextInput
                  labelText="Email Address"
                  placeholder="Enter your email address"
                  bind:value={email}
                  disabled={isLoading}
                />
                <Button
                  kind="primary"
                  on:click={createAccount}
                  disabled={isLoading || !email.trim()}
                  style="width:100%;"
                >
                  {isLoading ? "Creating..." : "Create Account"}
                </Button>
                <p
                  style="font-size:0.75rem;color:var(--cds-text-secondary);margin:0;"
                >
                  This will guide you through manual account creation at
                  web3.storage
                </p>
              </div>
            </div>
          </TabContent>
        {/if}
      </svelte:fragment>
    </Tabs>
  {:else}
    <!-- Authenticated State -->
    <div
      style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;"
    >
      <div style="display:flex;align-items:center;gap:0.5rem;">
        <Tag type="green">
          <CheckmarkFilled size={16} slot="icon" />
          Connected via {authMethod}
        </Tag>
        {#if currentSpace}
          <Tag type="outline">
            Space: {currentSpace.name ||
              currentSpace.did?.slice(-8) ||
              "Unknown"}
          </Tag>
        {/if}
      </div>

      <Button
        kind="ghost"
        iconDescription="Logout"
        icon={Logout}
        on:click={logout}
        size="sm"
      >
        Logout
      </Button>
    </div>

    <!-- Space Management -->
    {#if !compact}
      <div
        style="border-top:1px solid var(--cds-border-subtle);padding-top:1rem;"
      >
        <h4 style="margin:0 0 0.75rem 0;font-size:0.875rem;font-weight:600;">
          Spaces ({spaces.length})
        </h4>

        <!-- Create New Space -->
        <div
          style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem;"
        >
          <TextInput
            labelText="New space name"
            placeholder="New space name"
            bind:value={newSpaceName}
            style="flex:1;"
          />
          <Button
            kind="primary"
            on:click={createNewSpace}
            disabled={isLoading || !newSpaceName.trim()}
            size="sm"
          >
            Add
          </Button>
        </div>

        <!-- Spaces List -->
        {#if spaces.length === 0}
          <InlineNotification
            kind="info"
            title="No spaces"
            subtitle="No spaces found"
          />
        {:else}
          <div
            style="max-height:10rem;overflow:auto;display:flex;flex-direction:column;gap:0.5rem;"
          >
            {#each spaces as space (space.did)}
              <div
                style="display:flex;align-items:center;justify-content:space-between;border:1px solid var(--cds-border-subtle);padding:0.5rem;border-radius:0.25rem;background:var(--cds-layer);"
              >
                <div>
                  <div style="font-size:0.9rem;font-weight:500;">
                    {space.name || "Unnamed Space"}
                  </div>
                  <div
                    style="font-family:monospace;font-size:0.75rem;color:var(--cds-text-secondary);"
                  >
                    {space.did.slice(0, 20)}...
                  </div>
                </div>
                {#if currentSpace?.did !== space.did}
                  <Button
                    kind="ghost"
                    size="sm"
                    on:click={() => selectSpace(space)}>Select</Button
                  >
                {:else}
                  <Tag type="green">Current</Tag>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</Tile>
