<script>
  /**
   * Where the backups go: one of the library's storage backends.
   *
   * Aleph needs no account and nothing to paste, so it is the default. Pinata
   * and Lighthouse take a key, which stays in this component's memory — it is
   * never written to storage — and is sent from the browser. That is fine for
   * trying the demo with a key you can revoke, and not how a real application
   * should hold one.
   */
  import { createEventDispatcher } from "svelte";
  import {
    Tile,
    Button,
    RadioButtonGroup,
    RadioButton,
    TextInput,
    PasswordInput,
    InlineNotification,
    Tag,
  } from "carbon-components-svelte";
  import { CloudUpload, Reset } from "carbon-icons-svelte";
  import { createAlephBackend } from "orbitdb-storage-bridge/backends/aleph";
  import { createPinataBackend } from "orbitdb-storage-bridge/backends/pinata";
  import { createLighthouseBackend } from "orbitdb-storage-bridge/backends/lighthouse";
  import { logger } from "./logger.js";

  const dispatch = createEventDispatcher();

  const LABELS = { aleph: "Aleph", pinata: "Pinata", lighthouse: "Lighthouse" };

  let service = "aleph";
  let pinataJwt = "";
  let pinataGateway = "";
  let lighthouseApiKey = "";

  let backend = null;
  let label = "";
  let error = null;

  $: missingKey =
    (service === "pinata" && !pinataJwt.trim()) ||
    (service === "lighthouse" && !lighthouseApiKey.trim());

  function useStorage() {
    error = null;
    try {
      if (service === "aleph") {
        backend = createAlephBackend();
      } else if (service === "pinata") {
        backend = createPinataBackend({
          jwt: pinataJwt.trim(),
          gateway: pinataGateway.trim() || undefined,
        });
      } else {
        backend = createLighthouseBackend({ apiKey: lighthouseApiKey.trim() });
      }
      label = LABELS[service];
      logger.info(`Backups go to ${label}`, backend.capabilities);
      dispatch("configured", { backend, label, service });
    } catch (e) {
      backend = null;
      error = e.message;
    }
  }

  function changeStorage() {
    backend = null;
    label = "";
    error = null;
    dispatch("cleared");
  }
</script>

<Tile style="margin-bottom: 1rem;">
  <h4 style="margin-bottom: 0.75rem;">Storage for backups</h4>

  {#if backend}
    <p style="margin-bottom: 0.75rem;">
      Backups go to <strong data-testid="storage-label">{label}</strong>
      {#if service === "aleph"}
        <Tag type="green" size="sm">no account</Tag>
      {:else}
        <Tag type="warm-gray" size="sm">key in this tab only</Tag>
      {/if}
    </p>
    {#if service === "aleph"}
      <p style="margin-bottom: 0.75rem; font-size: 0.875rem;">
        Aleph takes the upload without a key. Keeping it is a wallet-signed STORE
        message, which this demo does not send — so treat the backup as short-lived.
      </p>
    {/if}
    <Button kind="tertiary" size="small" icon={Reset} on:click={changeStorage}>
      Change storage
    </Button>
  {:else}
    <RadioButtonGroup legendText="Service" bind:selected={service}>
      <RadioButton labelText="Aleph — no account, nothing to paste" value="aleph" />
      <RadioButton labelText="Pinata — needs a JWT" value="pinata" />
      <RadioButton labelText="Lighthouse — needs an API key" value="lighthouse" />
    </RadioButtonGroup>

    {#if service === "pinata"}
      <div style="margin-top: 1rem;">
        <PasswordInput labelText="Pinata JWT" bind:value={pinataJwt} />
        <TextInput
          labelText="Dedicated gateway (optional)"
          helperText="From the same Pinata account as the JWT, e.g. name.mypinata.cloud"
          bind:value={pinataGateway}
        />
      </div>
    {:else if service === "lighthouse"}
      <div style="margin-top: 1rem;">
        <PasswordInput labelText="Lighthouse API key" bind:value={lighthouseApiKey} />
      </div>
    {/if}

    {#if service !== "aleph"}
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="Test keys only"
        subtitle="The key stays in this tab's memory and is sent from the browser. Use one you can revoke."
      />
    {/if}

    {#if error}
      <InlineNotification kind="error" lowContrast hideCloseButton title="Storage not set up" subtitle={error} />
    {/if}

    <div style="margin-top: 1rem;">
      <Button icon={CloudUpload} on:click={useStorage} disabled={missingKey}>
        Use {LABELS[service]}
      </Button>
    </div>
  {/if}
</Tile>
