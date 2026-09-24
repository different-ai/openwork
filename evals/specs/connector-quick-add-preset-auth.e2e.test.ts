import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  DEPLOYMENT_CLIENT_ID,
  OAUTH_APP_PRESET_ID,
  PRE_REGISTERED_PRESET_ID,
  connectorQuickAddPresetAuth,
} from "../worlds/connector-quick-add.ts";

// A provider that registers OpenWork by hand hands back one client id for the
// whole deployment. The admin adding that provider should get plain OAuth
// sign-in, not a form asking for credentials the deployment already holds;
// a provider the deployment holds nothing for still asks, and a custom server
// is still classified by the live probe.
const test = spec.world(connectorQuickAddPresetAuth, { timeout: 600_000 });

test("an admin adds a provider whose OAuth client OpenWork already holds without being asked for an OAuth app, while other providers still are", async ({ world, user, probe, step, evidence }) => {
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
  const openQuickAdd = async (presetId: string, presetName: string) => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?quickAdd=${presetId}`);
    await user.see({ role: "heading", label: `Add ${presetName}` }, { timeoutMs: 90_000 });
  };

  await step(`given Den's own discovery says ${world.presetName} only accepts a pre-registered OAuth client`, async () => {
    expect(world.discovered).toEqual({ kind: "oauth", registration: "pre_registered" });
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence(
      "the provider refuses automatic registration",
      `Den discovery for ${world.presetUrl}: kind=${world.discovered.kind}, registration=${world.discovered.registration}; the deployment supplies client ${DEPLOYMENT_CLIENT_ID} for it`,
      true,
    );
  });

  await step(`before: a provider OpenWork holds no client for (${world.oauthAppPresetName}) still asks the admin for an OAuth app`, async () => {
    await openQuickAdd(OAUTH_APP_PRESET_ID, world.oauthAppPresetName);
    const state = await probe.eventually(setupState, {
      within: 60_000, label: "step two asked for the OAuth app", until: (current) => current.clientIdField,
    });
    await user.notSee({ role: "button", label: `Sign in with ${world.oauthAppPresetName}` });
    const asksForApp = state.clientIdField && !state.keyField;
    expect(asksForApp, JSON.stringify(state)).toBe(true);
    evidence.recordAssertionEvidence(
      `adding ${world.oauthAppPresetName} still shows the client ID field`,
      `quickAdd=${OAUTH_APP_PRESET_ID}: step two reads "${state.text}" with a client ID field and no sign-in button`,
      asksForApp,
    );
    await user.screenshot();
  });

  await step(`after: ${world.presetName} offers plain OAuth sign-in with the client OpenWork already holds`, async () => {
    await openQuickAdd(PRE_REGISTERED_PRESET_ID, world.presetName);
    await user.see({ role: "button", label: `Sign in with ${world.presetName}` }, { timeoutMs: 60_000 });
    const state = await setupState();
    const plainSignIn = !state.keyField && !state.clientIdField;
    expect(plainSignIn, JSON.stringify(state)).toBe(true);
    evidence.recordAssertionEvidence(
      `adding ${world.presetName} asks only for sign-in`,
      `quickAdd=${PRE_REGISTERED_PRESET_ID}: step two reads "${state.text}" with a sign-in button, no API key field and no client ID field`,
      plainSignIn,
    );
    await user.screenshot();
  });

  await step(`after: signing in to ${world.presetName} saves a connection that already carries the deployment's client`, async () => {
    // Sign-in saves the connection before it opens the provider's page; the
    // provider page itself is a third party and is not part of this claim.
    await user.click({ role: "button", label: `Sign in with ${world.presetName}` });
    const created = await probe.eventually(async () => {
      const listed = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
      const connections = typeof listed.body === "object" && listed.body !== null && "connections" in listed.body && Array.isArray(listed.body.connections)
        ? listed.body.connections
        : [];
      return connections.find((entry): entry is Record<string, unknown> => (
        typeof entry === "object" && entry !== null && "url" in entry && entry.url === world.presetUrl
      )) ?? null;
    }, { within: 60_000, label: `the ${world.presetName} connection was saved`, until: (current) => current !== null });
    if (!created) throw new Error(`No ${world.presetName} connection was created.`);
    const carriesClient = created.oauthClientId === DEPLOYMENT_CLIENT_ID
      && created.oauthClientConfigured === true
      && created.oauthClientRequired === false
      && created.oauthRegistrationSource === "pre-registered";
    expect(carriesClient, JSON.stringify({
      oauthClientId: created.oauthClientId,
      oauthClientConfigured: created.oauthClientConfigured,
      oauthClientRequired: created.oauthClientRequired,
      oauthRegistrationSource: created.oauthRegistrationSource,
    })).toBe(true);
    evidence.recordAssertionEvidence(
      `the new ${world.presetName} connection uses the deployment's client, with no admin setup outstanding`,
      `Manageable connection for ${world.presetUrl}: oauthClientId=${String(created.oauthClientId)}, registration=${String(created.oauthRegistrationSource)}, oauthClientRequired=${String(created.oauthClientRequired)}`,
      carriesClient,
    );
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
