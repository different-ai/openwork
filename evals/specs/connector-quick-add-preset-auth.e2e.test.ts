import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { API_KEY_PRESET_ID, connectorQuickAddPresetAuth } from "../worlds/connector-quick-add.ts";

// An admin who picks an API-key quick add must be asked for that key even when
// the hosted server also advertises OAuth metadata; the live probe still
// decides the auth type for a custom server URL.
const test = spec.world(connectorQuickAddPresetAuth, { timeout: 600_000 });

test("an API-key quick add keeps its key field while a custom OAuth-only server still switches to OAuth", async ({ world, user, probe, evidence }) => {
  // The connections page behind the dialog also mentions API keys, so every
  // field claim reads the dialog itself rather than the whole page.
  const DIALOG = '[data-testid="add-mcp-connection-dialog"]';
  const dialog = async () => {
    const [root, keyField, clientIdField, alert, enabledButtons] = await Promise.all([
      probe.dom(DIALOG),
      probe.dom(`${DIALOG} input[name="mcp-api-key"]`),
      probe.dom(`${DIALOG} input[name="mcp-oauth-client-id"]`),
      probe.dom(`${DIALOG} [role="alert"]`),
      probe.dom(`${DIALOG} button:not([disabled])`),
    ]);
    const text = root.elements[0]?.text;
    if (text === undefined) return null;
    return {
      text,
      alert: alert.elements.length > 0,
      keyField: keyField.elements.length > 0,
      clientIdField: clientIdField.elements.length > 0,
      credentialMode: text.includes("Whose account does the AI use?"),
      addEnabled: enabledButtons.elements.some(button => button.text === "Add connection"),
    };
  };

  await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?quickAdd=${API_KEY_PRESET_ID}`);
  await user.see({ testId: "add-mcp-connection-dialog" }, { timeoutMs: 90_000 });
  await user.see({ text: `Add ${world.presetName}` });
  await user.type({ placeholder: "sk-..." }, "synthetic-org-api-key");
  // Discovery must finish (the submit button only enables on a ready probe)
  // before the claim means anything: an unfinished probe never flips the form.
  const quickAdd = await probe.eventually(dialog, {
    within: 60_000,
    label: "requirements discovery finished for the quick add",
    until: state => state?.addEnabled === true,
  });
  if (!quickAdd) throw new Error("The quick-add dialog disappeared.");
  const quickAddOk = !quickAdd.alert && quickAdd.keyField && !quickAdd.clientIdField
    && !quickAdd.text.includes("OAuth app") && !quickAdd.credentialMode;
  expect(quickAddOk, JSON.stringify({ alert: quickAdd.alert, keyField: quickAdd.keyField, clientIdField: quickAdd.clientIdField, credentialMode: quickAdd.credentialMode })).toBe(true);
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "The API-key quick add still asks for the org key after the hosted server's OAuth challenge was discovered",
    `quickAdd=${API_KEY_PRESET_ID} against ${world.presetUrl}: Add connection enabled once a key was typed; key field present, no OAuth app, client ID, or credential-mode fields`,
    quickAddOk,
  );
  await user.click({ role: "button", label: "Cancel" });
  await user.notSee({ testId: "add-mcp-connection-dialog" });

  // Negative half: without a curated preset the probe still drives the form.
  // The admin first chooses API key by hand; discovering an OAuth server
  // must override that choice, and the server's own log witnesses the probe.
  await user.click({ role: "button", label: "Advanced setup" });
  await user.see({ testId: "add-mcp-connection-dialog" });
  await user.see({ text: "Add a custom MCP server" });
  await user.click({ role: "button", label: "API key" });
  const customBefore = await dialog();
  if (!customBefore) throw new Error("The custom server dialog disappeared.");
  expect(customBefore.keyField, "API key chosen by hand before discovery").toBe(true);
  await user.type({ placeholder: "https://mcp.example.com/mcp" }, world.oauthOnlyServerUrl);
  const custom = await probe.eventually(dialog, {
    within: 60_000,
    label: "requirements discovery switched the custom server to OAuth",
    until: state => state?.keyField === false && state?.credentialMode === true,
  });
  if (!custom) throw new Error("The custom server dialog disappeared.");
  const probedPaths = (await world.connector.requests()).map(request => request.path).filter(path => path.startsWith("/mcp") || path.includes("/.well-known/"));
  const customOk = !custom.alert && probedPaths.length > 0;
  expect(customOk, JSON.stringify({ alert: custom.alert, probedPaths })).toBe(true);
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "A custom OAuth server overrides a hand-picked API key auth type after Den probes it",
    `Den probed the synthetic server at ${JSON.stringify([...new Set(probedPaths)])}; the dialog dropped the API-key field and asked whose account the AI uses`,
    customOk,
  );
  await user.click({ role: "button", label: "Cancel" });
});
