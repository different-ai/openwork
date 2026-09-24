import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { OAUTH_PRESET_ID, connectorQuickAddPresetAuth } from "../worlds/connector-quick-add.ts";

// Public preset apps skip credential entry; custom servers still use discovery.
const test = spec.world(connectorQuickAddPresetAuth, { timeout: 600_000 });

test("Render uses OpenWork’s OAuth app without credential entry and a custom server still uses discovery", async ({ world, user, probe, step, evidence }) => {
  const methodCheck = '[data-testid="setup-check-sign-in-method"]';
  const setupState = async () => {
    const [check, keyField, clientIdField] = await Promise.all([
      probe.dom(methodCheck),
      probe.dom(`${methodCheck} input[name="connector-api-key"]`),
      probe.dom(`${methodCheck} input[name="connector-oauth-client-id"]`),
    ]);
    return {
      text: check.elements[0]?.text ?? "",
      keyField: keyField.elements.length > 0,
      clientIdField: clientIdField.elements.length > 0,
    };
  };

  await step("Render's authorization URL uses OpenWork's public client", async () => {
    expect(world.discovered.kind).toBe("oauth");
    const authorize = new URL(world.authorizeUrl);
    expect(authorize.origin).toBe("https://api.render.com");
    expect(authorize.searchParams.get("client_id")).toBe("openwork");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    evidence.recordAssertionEvidence("Render is preconfigured with OpenWork's public OAuth client", "The real Den connect/start returned Render's authorization URL with client_id=openwork and PKCE S256; no Render account was signed in.", true);
  });

  await step("the Render setup offers Sign in without an API key or OAuth app form", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?quickAdd=${OAUTH_PRESET_ID}`);
    await user.see({ role: "heading", label: "Add Render" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Sign in with Render" }, { timeoutMs: 60_000 });
    const state = await setupState();
    expect(state.keyField).toBe(false);
    expect(state.clientIdField).toBe(false);
    const connections = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const saved = isRecord(connections.body) ? records(connections.body.connections).find((entry) => entry.id === world.presetConnectionId) : undefined;
    expect(saved).toMatchObject({ authType: "oauth", oauthClientId: "openwork", oauthClientConfigured: true, connectedForMe: false });
    evidence.recordAssertionEvidence("Render needs no pasted credentials", "Step two offers personal sign-in with no key or client fields. Den saved the openwork client; the user is not connected before consent.", true);
    await user.screenshot();
  });

  await step("after: a custom OAuth-only server asks each person to sign in, and Den really probed it", async () => {
    const query = new URLSearchParams({ name: "Synthetic OAuth", url: world.oauthOnlyServerUrl });
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/new/custom?${query.toString()}`);
    await user.see({ role: "heading", label: "Add Synthetic OAuth" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Sign in with Synthetic OAuth" }, { timeoutMs: 60_000 });
    const state = await setupState();
    const probedPaths = (await world.connector.requests()).map((request) => request.path).filter((path) => path.startsWith("/mcp") || path.includes("/.well-known/"));
    const ok = !state.keyField && !state.clientIdField && probedPaths.length > 0;
    expect(ok, JSON.stringify({ state, probedPaths })).toBe(true);
    evidence.recordAssertionEvidence(
      "a custom OAuth server gets a sign-in step, not a key field",
      `Den probed ${JSON.stringify([...new Set(probedPaths)])}; step two reads "${state.text}"; no key or client ID field`,
      ok,
    );
    await user.screenshot();
  });
});
