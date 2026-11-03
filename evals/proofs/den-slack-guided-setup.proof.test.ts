import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denSlackGuidedSetup } from "../worlds/den-slack-guided-setup.ts";

const test = spec.world(denSlackGuidedSetup, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const CLIENT_ID = "1111111111.2222222222";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

test("an admin sets up Slack from one guided checklist: an explicit access choice, a prefilled Slack app, the MCP switch, credentials, then a test sign-in", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const observed = probe.on(world.web);
  const STATUSES = ["waiting", "running", "current", "done", "failed", "blocked"];
  const status = async (id: string) => {
    for (const value of STATUSES) {
      if ((await observed.dom(`[data-testid="setup-check-${id}"][data-status="${value}"]`)).elements.length > 0) return value;
    }
    return null;
  };
  const linkHas = async (fragment: string) => (await observed.dom(`a[data-testid="slack-setup-create-app"][href*="${fragment.replaceAll('"', '\\"')}"]`)).elements.length === 1;

  let callbackUrl = "";
  let presetScopes: string[] = [];
  let defaultScopes: string[] = [];

  await step("by default nothing is chosen for the admin and the Slack app link stays locked", async () => {
    const slack = (await world.presets()).find((preset) => preset.presetId === "slack");
    callbackUrl = typeof slack?.oauthCallbackUrl === "string" ? slack.oauthCallbackUrl : "";
    defaultScopes = stringArray(slack?.defaultOAuthScopes);
    presetScopes = [...new Set([...defaultScopes, ...stringArray(slack?.optionalOAuthScopes)])];
    await admin.navigate(world.url("/dashboard/mcp-connections/new/slack"));
    await admin.see({ testId: "slack-setup-scope-choice" }, { timeoutMs: 90_000 });
    await admin.see({ text: "Choose what OpenWork can do in Slack" });
    const selected = (await observed.dom('[data-testid="slack-setup-scope-choice"] input:checked')).elements.length;
    const link = (await observed.dom('[data-testid="slack-setup-create-app"]')).elements.length;
    const fields = (await observed.dom('[data-testid="setup-oauth-app"]')).elements.length;
    const states = { access: await status("slack-access"), app: await status("slack-app"), credentials: await status("sign-in-method"), signIn: await status("sign-in") };
    const ok = selected === 0 && link === 0 && fields === 0 && states.access === "current" && states.app === "waiting" && states.credentials === "waiting" && states.signIn === "waiting";
    evidence.recordAssertionEvidence(
      "No access level is preselected, and no app link, credential fields or sign-in exist before the choice",
      `options selected=${selected}; Create app link=${link}; credential fields=${fields}; access=${states.access}; create app=${states.app}; client ID=${states.credentials}; sign in=${states.signIn}`,
      ok,
    );
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin explicitly chooses Read and act; Create app in Slack is prefilled with this Den's redirect URL and all 30 scopes", async () => {
    await admin.click({ testId: "slack-setup-scope-read_and_act" });
    await admin.see({ role: "link", label: "Create app in Slack" });
    const opensSlack = (await observed.dom('a[data-testid="slack-setup-create-app"][href^="https://api.slack.com/apps?new_app=1&manifest_json="]')).elements.length === 1;
    const hasRedirect = callbackUrl.endsWith("/v1/mcp-connections/oauth/callback") && await linkHas(encodeURIComponent(JSON.stringify([callbackUrl])));
    const scopesIncluded = (await Promise.all(presetScopes.map((scope) => linkHas(encodeURIComponent(`"${scope}"`))))).filter(Boolean).length;
    const mcpOn = await linkHas(encodeURIComponent('"is_mcp_enabled":true'));
    const botPieces = await linkHas("bot");
    const ok = opensSlack && hasRedirect && defaultScopes.length === 11 && presetScopes.length === 30 && scopesIncluded === presetScopes.length && mcpOn && !botPieces;
    evidence.recordAssertionEvidence(
      "After the explicit choice, the Slack link opens Create an app with this Den's redirect URL, all 30 user scopes and MCP on",
      `opens api.slack.com/apps?new_app=1 with a manifest=${opensSlack}; redirect URL=${callbackUrl} (in manifest: ${hasRedirect}); user scopes in manifest=${scopesIncluded}/${presetScopes.length} (default ${defaultScopes.length} + opt-in ${presetScopes.length - defaultScopes.length}); MCP on=${mcpOn}; bot pieces=${botPieces}`,
      ok,
    );
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("before: Agents › MCP is not checked yet and sign-in waits for it", async () => {
    await admin.see({ text: "Turn on Agents › MCP" });
    await admin.see({ text: "Not checked yet." });
    const states = { app: await status("slack-app"), mcp: await status("slack-mcp"), credentials: await status("sign-in-method"), signIn: await status("sign-in") };
    const ok = (await status("slack-access")) === "done" && states.app === "current" && states.mcp === "current" && states.credentials === "current" && states.signIn === "waiting";
    evidence.recordAssertionEvidence("Nothing Den can't see is shown as done", `create app=${states.app}; MCP=${states.mcp}; client ID=${states.credentials}; sign in=${states.signIn}; Slack contacted=${world.discoveries() > 0 ? "fixture only" : "no"}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin pastes the client ID and secret; the connection asks Slack for exactly the scopes in the app manifest", async () => {
    await admin.type({ placeholder: "Client ID" }, CLIENT_ID);
    await admin.type({ label: "Client secret" }, "synthetic-slack-client-secret");
    await admin.click({ role: "button", label: "Save changes" });
    await admin.see({ text: "Client ID and secret added" }, { timeoutMs: 30_000 });
    const saved = await probe.eventually(() => world.slackConnection(), { within: 20_000, label: "Slack connection saved", until: (row) => row?.oauthClientId === CLIENT_ID });
    const requested = stringArray(saved?.requestedScopes);
    const signIn = await status("sign-in");
    const missing = presetScopes.filter((scope) => !requested.includes(scope));
    const extra = requested.filter((scope) => !presetScopes.includes(scope));
    const ok = saved?.oauthClientHasSecret === true && requested.length === 30 && missing.length === 0 && extra.length === 0 && signIn === "waiting";
    evidence.recordAssertionEvidence(
      "The OAuth app is saved and requests the same 30 scopes as the Slack app manifest",
      `client ID saved=${saved?.oauthClientId === CLIENT_ID}; secret saved=${String(saved?.oauthClientHasSecret)}; requested=${requested.length} (manifest ${presetScopes.length}); missing from request=${missing.join(",") || "none"}; not in manifest=${extra.join(",") || "none"}; sign in=${signIn}`,
      ok,
    );
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: confirming MCP is on unlocks Sign in with Slack, still marked not checked yet", async () => {
    await admin.click({ testId: "slack-setup-confirm-mcp" });
    await admin.see({ role: "button", label: "Sign in with Slack" });
    await admin.see({ text: "Not checked yet. Signing in checks it." });
    const states = { mcp: await status("slack-mcp"), signIn: await status("sign-in") };
    const ok = states.mcp === "done" && states.signIn === "current";
    evidence.recordAssertionEvidence("Sign-in is the next step once the admin confirms the MCP switch", `MCP=${states.mcp} (not checked yet); sign in=${states.signIn}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });
});
