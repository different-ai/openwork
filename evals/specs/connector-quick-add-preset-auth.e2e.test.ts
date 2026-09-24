import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { API_KEY_PRESET_ID, connectorQuickAddPresetAuth } from "../worlds/connector-quick-add.ts";

// An admin who picks an API-key catalog entry must be asked for that key even
// when the hosted server also advertises OAuth metadata; the live probe still
// decides how people sign in to a custom server address.
const test = spec.world(connectorQuickAddPresetAuth, { timeout: 600_000 });

test("an admin adding an API-key connector is asked for the key, while a custom OAuth-only server asks people to sign in", async ({ world, user, probe, step, evidence }) => {
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

  await step("given Den's own discovery says the API-key server wants OAuth", async () => {
    expect(world.discovered.kind).toBe("oauth");
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("the preset and the live probe disagree", `Den discovery for ${world.presetUrl}: kind=${world.discovered.kind}, registration=${world.discovered.registration}; preset ${API_KEY_PRESET_ID} is an API-key preset`, true);
  });

  await step("when the admin opens its old quick-add link, the setup page asks for the key", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?quickAdd=${API_KEY_PRESET_ID}`);
    await user.see({ role: "heading", label: `Add ${world.presetName}` }, { timeoutMs: 90_000 });
    const state = await probe.eventually(setupState, {
      within: 60_000, label: "step two asked for the key", until: (current) => current.keyField,
    });
    await user.notSee({ role: "button", label: `Sign in with ${world.presetName}` });
    const ok = state.keyField && !state.clientIdField;
    expect(ok, JSON.stringify(state)).toBe(true);
    evidence.recordAssertionEvidence(
      "the API-key connector still asks for the org key although discovery said OAuth",
      `quickAdd=${API_KEY_PRESET_ID} landed on the setup page; step two reads "${state.text}" with a key field, no client ID field, no sign-in button`,
      ok,
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
