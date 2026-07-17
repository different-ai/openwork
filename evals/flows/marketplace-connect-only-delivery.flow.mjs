import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/marketplace-connect-only-delivery.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("marketplace-connect-only-delivery");

const FLOW_ID = "marketplace-connect-only-delivery";
const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL || DEN_API_URL);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const WORKSPACE_PATH = process.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() || "/tmp/openwork-marketplace-connect-only-delivery";
const RUN_TAG = Date.now();
const SEED_PREFIX = "marketplace-connect-only-delivery";
const MARKETPLACE_NAME = `${SEED_PREFIX}-${RUN_TAG}`;
const PLUGIN_NAME = `Connect Only Delivery ${RUN_TAG}`;
const SKILL_NAME = `connect-only-delivery-proof-${RUN_TAG}`;
const PROOF_PHRASE = `cloud-orbit-${RUN_TAG}`;

const state = {
  orgAdminToken: null,
  platformAdminToken: null,
  orgId: null,
  marketplace: null,
  marketplaceId: null,
  plugin: null,
  pluginId: null,
};

export default {
  id: FLOW_ID,
  title: "Organization marketplace plugins are delivered through OpenWork Connect only",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
    "OPENWORK_EVAL_WORKSPACE_PATH",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A newly published marketplace plugin appears in Connect as ready cloud content", {
          voiceover: vo[0],
          // "My organization publishes a plugin to its marketplace, and on my desktop it "
          action: async () => {
            await prepareSignedInDesktop(ctx);
            await navigateToSettingsTab(ctx, "connect");
            await waitForConnectOrganizationRow(ctx, PLUGIN_NAME);
            await scrollConnectGroup(ctx, "ready");
          },
          assert: async () => {
            const proof = await readConnectState(ctx, PLUGIN_NAME);
            const readyGroup = proof.groups.ready ?? "";
            ctx.assert(proof.pageText.includes("From your organization"), "Connect organization section missing.");
            ctx.assert(readyGroup.includes(PLUGIN_NAME), `Seeded plugin missing from Ready group: ${readyGroup}`);
            ctx.assert(readyGroup.includes("Ready"), `Ready chip missing from seeded plugin row: ${readyGroup}`);
            ctx.assert(!readyGroup.includes("Add") && !readyGroup.includes("Install"), `Connect row exposed an install action: ${readyGroup}`);
          },
          screenshot: { name: "frame-1-connect-ready", requireText: ["From your organization", "READY TO USE", PLUGIN_NAME] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The organization marketplace has no Den plugin Install or Update action", {
          voiceover: vo[1],
          // "The old install path is really gone: the organization marketplace shows ever"
          action: async () => {
            await navigateToSettingsTab(ctx, "cloud-marketplaces");
            await waitForMarketplacePlugin(ctx, PLUGIN_NAME);
          },
          assert: async () => {
            const proof = await readMarketplaceState(ctx, PLUGIN_NAME);
            ctx.assert(proof.pluginCardText.includes("Runs in cloud"), `Runs-in-cloud affordance missing: ${proof.pluginCardText}`);
            ctx.assert(proof.pageText.includes("Active · runs in cloud"), "Cloud-active label missing from marketplace page.");
            assertNoMarketplaceInstallButtons(ctx, proof);
          },
          screenshot: { name: "frame-2-marketplace-cloud-only", requireText: ["Extension Marketplace", PLUGIN_NAME, "Runs in cloud"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Extensions Legacy remains local and excludes Den organization plugin rows", {
          voiceover: vo[2],
          // "Extensions (Legacy) is purely local territory now: my MCPs, skills, and GitH"
          action: async () => {
            await dismissStaleDialogs(ctx);
            await navigateToSettingsTab(ctx, "extensions");
            await ctx.waitForText("My Extensions", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const proof = await readExtensionsLegacyState(ctx);
            ctx.assert(proof.pageText.includes("Add Custom App"), "Add Custom App affordance missing.");
            ctx.assert(proof.pageText.includes("From GitHub"), "From GitHub import affordance missing.");
            ctx.assert(!proof.pageText.includes(PLUGIN_NAME), "Seeded Den marketplace plugin leaked into My Extensions.");
            await ctx.clickText("Marketplace", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("Extension Marketplace", { timeoutMs: 30_000 });
            const marketplaceText = await ctx.eval("document.body.innerText");
            ctx.assert(!marketplaceText.includes(PLUGIN_NAME), "Seeded Den marketplace plugin leaked into Extensions Marketplace.");
            await ctx.clickText("My Extensions", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
          },
          screenshot: { name: "frame-3-extensions-local", requireText: ["My Extensions", "Add Custom App", "From GitHub"], rejectText: [PLUGIN_NAME] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("A real agent turn discovers and executes the seeded cloud capability", {
          voiceover: vo[3],
          // "When I ask the agent to use the capability, it discovers it with search and "
          action: async () => {
            await runSeededCapabilityAgentTurn(ctx);
          },
          assert: async () => {
            await ctx.waitForText("search capabilities", { timeoutMs: 90_000 });
            await ctx.waitForText("execute capability", { timeoutMs: 90_000 });
            await ctx.waitForText(PROOF_PHRASE, { timeoutMs: 90_000 });
          },
          screenshot: { name: "frame-4-agent-cloud-capability", requireText: ["search capabilities", "execute capability", PROOF_PHRASE] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("A legacy local import remains intact and is marked as a local copy", {
          voiceover: vo[4],
          // "And the plugin I imported back in the old days keeps working untouched — it "
          action: async () => {
            await seedLegacyLocalImport(ctx);
            await navigateToSettingsTab(ctx, "cloud-marketplaces");
            await waitForMarketplacePlugin(ctx, PLUGIN_NAME);
            await ctx.clickText(PLUGIN_NAME, { selector: "button", timeoutMs: 20_000 });
            await ctx.waitForText("Local copy installed — still works, runs from this machine.", { timeoutMs: 20_000 });
          },
          assert: async () => {
            const proof = await readMarketplaceState(ctx, PLUGIN_NAME);
            ctx.assert(proof.pageText.includes("Local copy installed"), "Local-copy badge missing from marketplace row.");
            ctx.assert(proof.pageText.includes("Local copy installed — still works, runs from this machine."), "Local-copy note missing from marketplace detail/page state.");
            await assertLegacyImportArtifacts(ctx);
          },
          screenshot: { name: "frame-5-local-copy", requireText: [PLUGIN_NAME, "Local copy installed"] },
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

async function denApiFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function signIn(email, password) {
  return denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Platform-admin provisioning requires OPENWORK_EVAL_MARK_VERIFIED_CMD with an {email} placeholder.",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function ensurePlatformAdmin(ctx) {
  if (state.platformAdminToken) return state.platformAdminToken;

  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Priya Platform", email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  });
  const signupAccepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
  ctx.assert(signupAccepted, `Platform admin sign-up failed: ${signup.response.status} ${signup.text.slice(0, 300)}`);
  markEmailVerified(ctx, PLATFORM_ADMIN_EMAIL);

  const signedIn = await signIn(PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD);
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Platform admin sign-in failed: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.platformAdminToken = signedIn.body.token;

  const probe = await denApiFetch("/v1/admin/overview", {
    headers: { authorization: `Bearer ${state.platformAdminToken}` },
  });
  ctx.assert(probe.response.ok, `${PLATFORM_ADMIN_EMAIL} is not a platform admin (overview probe ${probe.response.status}).`);
  return state.platformAdminToken;
}

async function ensureOrgAdminContext(ctx) {
  if (state.orgAdminToken && state.orgId) return;

  const signedIn = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Org admin sign-in failed for ${ADMIN_EMAIL}: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.orgAdminToken = signedIn.body.token;

  const listed = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
  });
  ctx.assert(listed.response.ok, `Could not list orgs: ${listed.response.status} ${listed.text.slice(0, 300)}`);
  const orgs = listed.body?.orgs;
  ctx.assert(Array.isArray(orgs), "Current user organizations payload was missing orgs.");
  const activeOrgId = typeof listed.body?.activeOrgId === "string" ? listed.body.activeOrgId : null;
  const activeOrg = orgs.find((org) => org.id === activeOrgId) ?? orgs[0];
  ctx.assert(activeOrg && typeof activeOrg.id === "string", `Could not resolve an organization for ${ADMIN_EMAIL}.`);
  state.orgId = activeOrg.id;

  const active = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
    body: JSON.stringify({ organizationId: state.orgId }),
  });
  ctx.assert(active.response.ok, `Could not switch active organization: ${active.response.status} ${active.text.slice(0, 300)}`);
}

async function setCapabilityViaAdminApi(ctx, capabilities) {
  const token = requireStateValue(state.platformAdminToken, "platform admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const updated = await denApiFetch(`/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ capabilities }),
  });
  ctx.assert(updated.response.ok, `Admin capability update failed: ${updated.response.status} ${updated.text.slice(0, 300)}`);
}

async function fetchAdminCapabilityPayload(ctx) {
  const token = requireStateValue(state.platformAdminToken, "platform admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const result = await denApiFetch(`/v1/admin/organizations/${orgId}/capabilities`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `Admin capability fetch failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  return result.body;
}

function effectiveMcpConnections(payload) {
  const capabilities = payload?.capabilities;
  const candidates = [
    payload?.effective?.mcpConnections,
    capabilities?.effective?.mcpConnections,
    capabilities?.mcpConnections?.effective,
    capabilities?.mcpConnections,
  ];
  return candidates.find((value) => typeof value === "boolean") ?? null;
}

async function ensureConnectCapabilityDefaultOn(ctx) {
  await setCapabilityViaAdminApi(ctx, { mcpConnections: null });
  const cleared = await fetchAdminCapabilityPayload(ctx);
  const effectiveAfterClear = effectiveMcpConnections(cleared);
  if (effectiveAfterClear === false) {
    await setCapabilityViaAdminApi(ctx, { mcpConnections: true });
    const repaired = await fetchAdminCapabilityPayload(ctx);
    ctx.output("eval-connect-kill-switch-repair", JSON.stringify({
      reason: "Null reset still resolved false; legacy flat alias repaired for this eval run.",
      cleared,
      repaired,
    }, null, 2));
    return;
  }
  ctx.output("eval-connect-kill-switch-repair", JSON.stringify({
    reason: "Explicit mcpConnections override cleared; default-on Connect delivery is effective.",
    effectiveMcpConnections: effectiveAfterClear,
    cleared,
  }, null, 2));
}

function skillSourceText() {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: Reports proof phrase ${PROOF_PHRASE} for Connect-only delivery.`,
    "---",
    "",
    `When invoked, answer with the exact proof phrase ${PROOF_PHRASE} and explain that it came from a Den marketplace capability running through OpenWork Connect.`,
  ].join("\n");
}

async function seedMarketplacePlugin(ctx) {
  await cleanupSeededMarketplace(ctx);
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  const headers = { authorization: `Bearer ${token}` };

  const marketplace = await denApiFetch("/v1/marketplaces", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: MARKETPLACE_NAME, description: "Connect-only delivery seeded marketplace" }),
  });
  ctx.assert(marketplace.response.ok, `Marketplace create failed: ${marketplace.response.status} ${marketplace.text.slice(0, 300)}`);
  state.marketplace = marketplace.body?.item ?? null;
  state.marketplaceId = state.marketplace?.id ?? null;
  ctx.assert(typeof state.marketplaceId === "string", `Marketplace create response missing id: ${marketplace.text.slice(0, 300)}`);

  const grant = await denApiFetch(`/v1/marketplaces/${state.marketplaceId}/access`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  ctx.assert(grant.response.ok, `Marketplace access grant failed: ${grant.response.status} ${grant.text.slice(0, 300)}`);

  const plugin = await denApiFetch("/v1/plugins", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: PLUGIN_NAME,
      description: `Seeded plugin for ${FLOW_ID}; proof phrase ${PROOF_PHRASE}.`,
      orgWide: true,
      marketplaceId: state.marketplaceId,
      components: [{
        type: "skill",
        input: {
          rawSourceText: skillSourceText(),
          metadata: { name: SKILL_NAME, description: `Reports proof phrase ${PROOF_PHRASE}.` },
        },
      }],
    }),
  });
  ctx.assert(plugin.response.ok, `Plugin create failed: ${plugin.response.status} ${plugin.text.slice(0, 300)}`);
  state.plugin = plugin.body?.item ?? null;
  state.pluginId = state.plugin?.id ?? null;
  ctx.assert(typeof state.pluginId === "string", `Plugin create response missing id: ${plugin.text.slice(0, 300)}`);
}

async function cleanupSeededMarketplace(ctx) {
  if (!state.orgAdminToken) return;
  const token = state.orgAdminToken;
  const headers = { authorization: `Bearer ${token}` };

  const marketplaces = await denApiFetch("/v1/marketplaces?limit=100", { headers });
  if (marketplaces.response.ok && Array.isArray(marketplaces.body?.items)) {
    for (const marketplace of marketplaces.body.items) {
      if (typeof marketplace.name !== "string" || !marketplace.name.startsWith(SEED_PREFIX)) continue;
      await cleanupMarketplacePlugins(ctx, marketplace.id, token);
      await denApiFetch(`/v1/marketplaces/${marketplace.id}/archive`, { method: "POST", headers });
    }
  }

  const plugins = await denApiFetch(`/v1/plugins?limit=100&q=${encodeURIComponent("Connect Only Delivery")}`, { headers });
  if (plugins.response.ok && Array.isArray(plugins.body?.items)) {
    for (const plugin of plugins.body.items) {
      if (typeof plugin.name !== "string" || !plugin.name.startsWith("Connect Only Delivery")) continue;
      await cleanupPlugin(ctx, plugin.id, token);
    }
  }

  state.marketplace = null;
  state.marketplaceId = null;
  state.plugin = null;
  state.pluginId = null;
}

async function cleanupMarketplacePlugins(ctx, marketplaceId, token) {
  if (typeof marketplaceId !== "string") return;
  const headers = { authorization: `Bearer ${token}` };
  const memberships = await denApiFetch(`/v1/marketplaces/${marketplaceId}/plugins`, { headers });
  if (!memberships.response.ok || !Array.isArray(memberships.body?.items)) return;
  for (const membership of memberships.body.items) {
    if (typeof membership.pluginId !== "string") continue;
    await denApiFetch(`/v1/marketplaces/${marketplaceId}/plugins/${membership.pluginId}`, { method: "DELETE", headers });
    await cleanupPlugin(ctx, membership.pluginId, token);
  }
}

async function cleanupPlugin(ctx, pluginId, token) {
  if (typeof pluginId !== "string") return;
  const headers = { authorization: `Bearer ${token}` };
  const memberships = await denApiFetch(`/v1/plugins/${pluginId}/config-objects`, { headers });
  if (memberships.response.ok && Array.isArray(memberships.body?.items)) {
    for (const membership of memberships.body.items) {
      if (typeof membership.configObjectId !== "string") continue;
      await denApiFetch(`/v1/plugins/${pluginId}/config-objects/${membership.configObjectId}`, { method: "DELETE", headers });
      await denApiFetch(`/v1/config-objects/${membership.configObjectId}/delete`, { method: "POST", headers });
    }
  }
  const archived = await denApiFetch(`/v1/plugins/${pluginId}/archive`, { method: "POST", headers });
  if (!archived.response.ok && archived.response.status !== 404) {
    ctx.log(`Plugin archive returned ${archived.response.status}: ${archived.text.slice(0, 200)}`);
  }
}

async function prepareSignedInDesktop(ctx) {
  await ensurePlatformAdmin(ctx);
  await ensureOrgAdminContext(ctx);
  await ensureConnectCapabilityDefaultOn(ctx);
  await seedMarketplacePlugin(ctx);
  await signDesktopIntoCloud(ctx);
  await clearDesktopConfigCache(ctx);
  await completeDesktopCloudOnboardingIfNeeded(ctx);
  await remountDesktop(ctx);
  await waitForCloudMcpSync(ctx);
}

async function signDesktopIntoCloud(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
  const bootstrap = { baseUrl: DEN_WEB_URL, apiBaseUrl: DEN_API_URL, requireSignin: false, handoff: null };
  const written = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) return { ok: false };
    await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(DEN_WEB_URL)});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(DEN_API_URL)});
    localStorage.removeItem('openwork.den.authToken');
    localStorage.removeItem('openwork.den.activeOrgId');
    localStorage.removeItem('openwork.den.activeOrgSlug');
    localStorage.removeItem('openwork.den.activeOrgName');
    localStorage.removeItem('openwork.den.mcp.sync');
    return { ok: true };
  })()`, { awaitPromise: true });
  ctx.assert(written?.ok, "Failed to write desktop bootstrap config.");
  await clearDesktopConfigCache(ctx);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after bootstrap reload" });
  await ctx.waitFor("(document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 60_000, label: "react root mounted after bootstrap reload" });

  const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { authorization: `Bearer ${requireStateValue(state.orgAdminToken, "org admin token")}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(handoff.response.ok, `Handoff create failed: ${handoff.response.status} ${handoff.text.slice(0, 300)}`);
  await ctx.waitFor(
    "Boolean(window.__openworkControl?.listActions().some((action) => action.id === 'auth.exchange-grant'))",
    { timeoutMs: 30_000, label: "auth.exchange-grant control action" },
  );
  await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_WEB_URL });
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "persisted den auth token",
  });
  await ctx.waitFor(`localStorage.getItem('openwork.den.activeOrgId') === ${JSON.stringify(requireStateValue(state.orgId, "organization id"))}`, {
    timeoutMs: 60_000,
    label: "active org resolved",
  });
}

async function clearDesktopConfigCache(ctx) {
  await ctx.eval(`(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('openwork.den.desktopConfig:')) localStorage.removeItem(key);
    }
    return true;
  })()`);
}

async function completeDesktopCloudOnboardingIfNeeded(ctx) {
  await dismissStaleDialogs(ctx);
  await ctx.clickText("Continue with organization", { timeoutMs: 5_000 }).catch(() => {});
  await ctx.clickText("Continue to workspace", { timeoutMs: 8_000 }).catch(() => {});
  const needsFolder = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))").catch(() => false);
  if (needsFolder) {
    await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
    await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const routeReady = await ctx.eval("window.location.hash.includes('/workspace/')");
    if (routeReady) return;
    await ctx.eval(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const modelSkip = buttons.find((candidate) => ['Skip and use the free model', 'Continue without OpenWork Models'].includes((candidate.textContent ?? '').trim()));
      if (modelSkip instanceof HTMLElement && !modelSkip.hasAttribute('disabled')) modelSkip.click();
      const surveySkip = buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Skip');
      if (surveySkip instanceof HTMLElement && !surveySkip.hasAttribute('disabled')) surveySkip.click();
      return true;
    })()`);
    await sleep(1_000);
  }
  if (needsFolder) {
    await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace open after onboarding" });
  }
}

async function remountDesktop(ctx) {
  await clearDesktopConfigCache(ctx);
  let remountReady = false;
  for (let attempt = 0; attempt < 3 && !remountReady; attempt += 1) {
    await ctx.eval("location.reload()");
    try {
      await ctx.waitFor("Boolean(window.__openworkControl) && (document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 45_000, label: `desktop alive after reload (attempt ${attempt + 1})` });
      remountReady = true;
    } catch {
      // Retry a blank renderer boot.
    }
  }
  ctx.assert(remountReady, "Desktop never became interactive after remount reloads.");
  await completeDesktopCloudOnboardingIfNeeded(ctx);
}

async function waitForCloudMcpSync(ctx) {
  await ctx.waitFor(
    "Boolean(localStorage.getItem('openwork.den.mcp.lastMaintenanceOutcome')) || (document.body?.innerText ?? '').includes('OpenWork Connect: Ready')",
    { timeoutMs: 180_000, label: "OpenWork Connect maintenance ready" },
  );
}

async function navigateToSettingsTab(ctx, tab) {
  await dismissStaleDialogs(ctx);
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? localStorage.getItem('openwork.react.activeWorkspace') ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, { timeoutMs: 30_000, label: `${tab} settings route` });
  try {
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 10_000, label: "settings surface mounted" });
  } catch {
    await ctx.eval("location.reload()");
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after settings recovery reload" });
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 60_000, label: "settings surface mounted after reload" });
  }
}

async function dismissStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    for (const button of document.querySelectorAll('[aria-label="Close"], [data-dialog-close]')) {
      if (button instanceof HTMLElement) button.click();
    }
    return true;
  })()`).catch(() => {});
  await sleep(150);
}

async function waitForConnectOrganizationRow(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="connect-organization-row"]')];
      return rows.some((row) => (row.innerText ?? '').includes(${JSON.stringify(name)}));
    })()`);
    if (found) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `Connect organization row did not render: ${name}`);
}

async function waitForMarketplacePlugin(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`document.body.innerText.includes(${JSON.stringify(name)})`);
    if (found) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `Marketplace plugin did not render: ${name}`);
}

async function scrollConnectGroup(ctx, group) {
  await ctx.eval(`(() => {
    const group = document.querySelector('[data-connect-group=${JSON.stringify(group)}]');
    group?.scrollIntoView({ block: 'center' });
    return Boolean(group);
  })()`);
  await sleep(300);
}

async function readConnectState(ctx, name) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.innerText ?? entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const groups = {};
    for (const group of document.querySelectorAll('[data-connect-group]')) {
      groups[group.getAttribute('data-connect-group')] = compact(group);
    }
    const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
      .find((entry) => compact(entry).includes(${JSON.stringify(name)}));
    return {
      pageText: document.body.innerText,
      groups,
      rowText: compact(row),
      rowButtons: [...(row?.querySelectorAll('button') ?? [])].map(compact),
    };
  })()`);
}

async function readMarketplaceState(ctx, name) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.innerText ?? entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('button')];
    const pluginCard = buttons.find((button) => compact(button).includes(${JSON.stringify(name)}));
    return {
      pageText: document.body.innerText,
      buttonTexts: buttons.map(compact),
      pluginCardText: compact(pluginCard),
    };
  })()`);
}

function assertNoMarketplaceInstallButtons(ctx, proof) {
  const forbidden = proof.buttonTexts.filter((text) => ["Add", "Install", "Update"].includes(text));
  ctx.assert(forbidden.length === 0, `Removed marketplace install/update buttons rendered: ${JSON.stringify(forbidden)}`);
}

async function readExtensionsLegacyState(ctx) {
  return ctx.eval(`(() => ({ pageText: document.body.innerText }))()`);
}

async function runSeededCapabilityAgentTurn(ctx) {
  await navigateToSession(ctx);
  await ctx.waitFor(
    "Boolean(window.__openworkControl?.listActions().find((action) => action.id === 'session.create_task' && !action.disabled))",
    { timeoutMs: 20_000, label: "session.create_task available" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      return /ses_[A-Za-z0-9]+/.test(route);
    })()`,
    { timeoutMs: 30_000, label: "new session active" },
  );

  const prompt = `Use the OpenWork Cloud Control capability named ${SKILL_NAME}. Search for it first, execute the matched capability, and tell me the exact proof phrase.`;
  const pasted = await ctx.eval(`(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "composer not found" };
    editor.focus();
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(prompt)});
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    return { ok: true };
  })()`);
  ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);

  await ctx.waitFor(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((entry) => /run task|send|run/i.test((entry.textContent || '').trim()) && !entry.disabled);
    if (button) { button.click(); return true; }
    return false;
  })()`, { timeoutMs: 10_000, label: "submit button enabled" });
}

async function navigateToSession(ctx) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? localStorage.getItem('openwork.react.activeWorkspace') ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/session` : "/session");
  await ctx.waitFor("window.location.hash.includes('/session')", { timeoutMs: 30_000, label: "session route" });
}

async function seedLegacyLocalImport(ctx) {
  const pluginId = requireStateValue(state.pluginId, "plugin id");
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  const resolvedResponse = await denApiFetch(`/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(resolvedResponse.response.ok, `Plugin resolved fetch failed: ${resolvedResponse.response.status} ${resolvedResponse.text.slice(0, 300)}`);
  const resolved = { plugin: state.plugin, memberships: resolvedResponse.body?.items ?? [] };

  // Eval-only seeding: call the still-alive local OpenWork server cloud-plugin
  // install route directly to simulate a pre-D2 legacy import. No UI path should
  // call this route for Den marketplace plugins anymore.
  const result = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) return { ok: false, reason: "Electron bridge unavailable" };
    const info = await bridge("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken || info?.clientToken || "").trim();
    const workspaceId = (location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || localStorage.getItem("openwork.react.activeWorkspace") || "";
    if (!baseUrl || !token || !workspaceId) return { ok: false, reason: "Missing OpenWork server connection" };
    const response = await fetch(baseUrl + "/workspace/" + encodeURIComponent(workspaceId) + "/cloud-plugins", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        marketplaceId: ${JSON.stringify(state.marketplaceId)},
        marketplace: ${JSON.stringify(state.marketplace)},
        resolved: ${JSON.stringify(resolved)},
      }),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body, text };
  })()`, { awaitPromise: true });
  ctx.assert(result?.ok, `Legacy local import seeding failed: ${result?.status ?? "n/a"} ${String(result?.text ?? result?.reason ?? "").slice(0, 300)}`);
  await ctx.control("extensions.refresh-marketplace").catch(() => {});
}

async function workspaceServerJson(ctx, path) {
  return ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) throw new Error("Electron bridge unavailable");
    const info = await bridge("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken || info?.clientToken || "").trim();
    const workspaceId = (location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || localStorage.getItem("openwork.react.activeWorkspace") || "";
    if (!baseUrl || !token || !workspaceId) throw new Error("Missing OpenWork server connection");
    const response = await fetch(baseUrl + "/workspace/" + encodeURIComponent(workspaceId) + ${JSON.stringify(path)}, {
      headers: { authorization: "Bearer " + token },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!response.ok) throw new Error(${JSON.stringify(path)} + " -> " + response.status + " " + text.slice(0, 200));
    return body;
  })()`, { awaitPromise: true });
}

async function assertLegacyImportArtifacts(ctx) {
  await ctx.waitFor(
    `(async () => {
      const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
      if (!bridge) return false;
      const info = await bridge("openworkServerInfo");
      const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
      const token = String(info?.ownerToken || info?.clientToken || "").trim();
      const workspaceId = (location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || localStorage.getItem("openwork.react.activeWorkspace") || "";
      if (!baseUrl || !token || !workspaceId) return false;
      const response = await fetch(baseUrl + "/workspace/" + encodeURIComponent(workspaceId) + "/skills", {
        headers: { authorization: "Bearer " + token },
      });
      if (!response.ok) return false;
      const body = await response.json();
      return Array.isArray(body.items) && body.items.some((item) => item.name === ${JSON.stringify(SKILL_NAME)});
    })()`,
    { timeoutMs: 45_000, label: `legacy imported skill ${SKILL_NAME}` },
  );
  const imports = await workspaceServerJson(ctx, "/cloud-plugins");
  ctx.assert(Boolean(imports.plugins?.[requireStateValue(state.pluginId, "plugin id")]), "Imported cloud plugin record missing after legacy seed.");
}
