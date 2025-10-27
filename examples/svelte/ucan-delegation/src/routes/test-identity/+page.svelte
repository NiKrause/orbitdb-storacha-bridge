<script>
  import { onMount } from "svelte";
  import {
    Button,
    Tile,
    InlineNotification,
    Loading,
    Grid,
    Row,
    Column,
  } from "carbon-components-svelte";
  import { identityService } from "../../lib/services/IdentityService.js";

  let testing = false;
  let testResults = [];
  let webAuthnStatus = null;

  function addResult(test, status, message, data = null) {
    testResults = [
      ...testResults,
      {
        test,
        status, // 'success', 'error', 'info'
        message,
        data,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  async function runTests() {
    testing = true;
    testResults = [];

    try {
      // Test 1: WebAuthn Support
      addResult("WebAuthn Support", "info", "Checking WebAuthn support...");
      webAuthnStatus = await identityService.initializeWebAuthnSupport();
      addResult(
        "WebAuthn Support",
        "success",
        `WebAuthn ${webAuthnStatus.supported ? "supported" : "not supported"}`,
        webAuthnStatus,
      );

      // Test 2: Mnemonic Identity
      addResult("Mnemonic Identity", "info", "Creating mnemonic identity...");
      const mnemonicResult =
        await identityService.createMnemonicIdentity("test-alice");
      addResult(
        "Mnemonic Identity",
        "success",
        `Created identity: ${mnemonicResult.identity.id.slice(0, 32)}...`,
        {
          id: mnemonicResult.identity.id,
          type: mnemonicResult.identity.type,
          seedPhrase: mnemonicResult.seedPhrase,
        },
      );

      // Test 3: WebAuthn Identity (if supported)
      if (webAuthnStatus.supported) {
        addResult(
          "WebAuthn Identity",
          "info",
          "Creating WebAuthn identity (will prompt for biometric)...",
        );
        const webAuthnResult =
          await identityService.createWebAuthnIdentity("test-bob");
        addResult(
          "WebAuthn Identity",
          "success",
          `Created WebAuthn identity: ${webAuthnResult.identity.id.slice(0, 32)}...`,
          {
            id: webAuthnResult.identity.id,
            type: webAuthnResult.identity.type,
            credentialId: webAuthnResult.webauthnCredential?.credentialId,
          },
        );
      } else {
        addResult(
          "WebAuthn Identity",
          "info",
          "Skipped - WebAuthn not supported in this browser",
        );
      }

      // Test 4: Utility Functions
      addResult("Utility Functions", "info", "Testing utility functions...");
      const testSeed = identityService.generateMasterSeed(
        "test mnemonic phrase",
        "password",
      );
      const seed32 = identityService.convertTo32BitSeed(testSeed);
      addResult(
        "Utility Functions",
        "success",
        "All utility functions working",
        {
          masterSeedLength: testSeed.length,
          seed32Length: seed32.length,
        },
      );

      addResult(
        "Complete",
        "success",
        "🎉 All Identity Service tests completed successfully!",
      );
    } catch (error) {
      addResult("Error", "error", `Test failed: ${error.message}`, {
        error: error.stack,
      });
    } finally {
      testing = false;
    }
  }

  function getStatusKind(status) {
    switch (status) {
      case "success":
        return "success";
      case "error":
        return "error";
      case "info":
        return "info";
      default:
        return "info";
    }
  }

  onMount(() => {
    console.log("🧪 Identity Service Test Component mounted");
    console.log('💡 Click "Run Tests" to test the extracted Identity Service');
  });
</script>

<svelte:head>
  <title>Identity Service Test</title>
</svelte:head>

<Grid>
  <Row>
    <Column>
      <div style="text-align: center; margin: 2rem 0;">
        <h1>🧪 Identity Service Test Page</h1>
        <p style="color: var(--cds-text-secondary);">
          Testing the extracted Identity Service before integration
        </p>
      </div>
    </Column>
  </Row>

  <Row>
    <Column lg={12} md={16} sm={16}>
      <Tile>
        <h3 style="margin-bottom: 1rem;">🧪 Identity Service Test</h3>

        <p style="margin-bottom: 1rem; color: var(--cds-text-secondary);">
          This component tests the extracted Identity Service to ensure it works
          correctly before integrating it into the main application.
        </p>

        <div style="margin-bottom: 1rem;">
          <Button on:click={runTests} disabled={testing}>
            {#if testing}
              <Loading withOverlay={false} small />
              Running Tests...
            {:else}
              Run Identity Service Tests
            {/if}
          </Button>
        </div>

        {#if webAuthnStatus}
          <InlineNotification
            kind={webAuthnStatus.supported ? "success" : "warning"}
            title="WebAuthn Status"
            subtitle={webAuthnStatus.message}
            style="margin-bottom: 1rem;"
          />
        {/if}

        {#if testResults.length > 0}
          <div style="margin-top: 1rem;">
            <h4 style="margin-bottom: 0.5rem;">Test Results:</h4>
            {#each testResults as result, i (result.timestamp)}
              <InlineNotification
                kind={getStatusKind(result.status)}
                title={result.test}
                subtitle={result.message}
                style="margin-bottom: 0.5rem;"
              >
                {#if result.data}
                  <details style="margin-top: 0.5rem;">
                    <summary style="cursor: pointer; font-size: 0.75rem;"
                      >Show Details</summary
                    >
                    <pre
                      style="font-size: 0.625rem; margin-top: 0.25rem; overflow-x: auto;">{JSON.stringify(
                        result.data,
                        null,
                        2,
                      )}</pre>
                  </details>
                {/if}
              </InlineNotification>
            {/each}
          </div>
        {/if}
      </Tile>
    </Column>
  </Row>
</Grid>

<style>
  details {
    font-size: 0.75rem;
  }

  pre {
    background: var(--cds-layer-accent);
    padding: 0.5rem;
    border-radius: 0.25rem;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
