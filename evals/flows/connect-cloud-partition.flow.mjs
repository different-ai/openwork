import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connect-cloud-partition";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL || DEN_API_URL);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const WORKSPACE_PATH = "/tmp/openwork-connect-cloud-partition";
const RUN_TAG = Date.now();
const SEED_PREFIX = "connect-cloud-partition";
const MARKETPLACE_NAME = `${SEED_PREFIX}-${RUN_TAG}`;
const READY_PLUGIN_NAME = `Partition Ready ${RUN_TAG}`;
const NEEDS_SETUP_PLUGIN_NAME = `Partition Needs Setup ${RUN_TAG}`;
const DESKTOP_PLUGIN_NAME = `Partition Desktop Only ${RUN_TAG}`;
const CONNECTION_NAME = `Partition Personal MCP ${RUN_TAG}`;
const CONNECTION_URL = `https://personal-${RUN_TAG}.example.test/mcp`;
const UNMATCHED_MCP_URL = `https://unmatched-${RUN_TAG}.example.test/mcp`;

const state = {
  orgAdminToken: null,
  platformAdminToken: null,
  orgId: null,
  marketplaceId: null,
  pluginIds: [],
  connectionId: null,
};

export default {
  id: FLOW_ID,
  title: "Connect partitions cloud-runnable organization capabilities from desktop marketplace installs",
  kind: "user-facing",
  spec: "evals/voiceovers/connect-cloud-partition.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Connect lists cloud-runnable marketplace content and excludes desktop-only plugins", {
          voiceover: vo[0],
          action: async () => {
            await prepareSignedInDesktopWithConnectOn(ctx);
            await navigateToSettingsTab(ctx, "connect");
            await waitForConnectText(ctx, READY_PLUGIN_NAME);
            await scrollConnectGroup(ctx, "ready");
          },
          assert: async () => {
            const proof = await readConnectPartitionState(ctx);
            ctx.assert(proof.pageText.includes("From your organization"), "Connect organization section missing.");
            ctx.assert((proof.groups.ready ?? "").includes(READY_PLUGIN_NAME), `Ready plugin missing from Ready to use: ${proof.groups.ready ?? ""}`);
            ctx.assert(!proof.pageText.includes(DESKTOP_PLUGIN_NAME), `Desktop-only plugin leaked into Connect: ${proof.pageText}`);
          },
          screenshot: {
            name: "connect-partition-ready-cloud-only",
            claim: "Connect shows ready cloud-runnable marketplace content and excludes desktop-only content.",
            requireText: ["From your organization", "READY TO USE", READY_PLUGIN_NAME],
            rejectText: [DESKTOP_PLUGIN_NAME, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Connect separates per-member team connections into Needs your sign-in", {
          voiceover: vo[1],
          action: async () => {
            await scrollConnectGroup(ctx, "needs_signin");
            await waitForConnectText(ctx, CONNECTION_NAME);
          },
          assert: async () => {
            const proof = await readConnectPartitionState(ctx);
            const needsSignin = proof.groups.needs_signin ?? "";
            ctx.assert(needsSignin.includes(CONNECTION_NAME), `Per-member connection missing: ${needsSignin}`);
            ctx.assert(needsSignin.includes("Connect"), `Connect action missing from sign-in row: ${needsSignin}`);
          },
          screenshot: {
            name: "connect-partition-needs-signin",
            claim: "Needs your sign-in contains the per-member connection and its Connect action.",
            requireText: ["NEEDS YOUR SIGN-IN", CONNECTION_NAME, "Connect"],
            rejectText: [DESKTOP_PLUGIN_NAME, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Admins see plugins whose MCP dependency still needs setup", {
          voiceover: vo[2],
          action: async () => {
            await scrollConnectGroup(ctx, "needs_admin_setup");
            await waitForConnectText(ctx, NEEDS_SETUP_PLUGIN_NAME);
          },
          assert: async () => {
            const proof = await readConnectPartitionState(ctx);
            const adminSetup = proof.groups.needs_admin_setup ?? "";
            ctx.assert(adminSetup.includes(NEEDS_SETUP_PLUGIN_NAME), `Needs-admin plugin missing: ${adminSetup}`);
            ctx.assert(adminSetup.includes("Set up connection"), `Setup affordance missing: ${adminSetup}`);
            ctx.assert(adminSetup.includes("unmatched"), `Unmatched dependency name/url missing: ${adminSetup}`);
          },
          screenshot: {
            name: "connect-partition-needs-admin-setup",
            claim: "Admins see the unmatched MCP plugin with the setup affordance.",
            requireText: ["NEEDS ADMIN SETUP", NEEDS_SETUP_PLUGIN_NAME, "Set up connection"],
            rejectText: [DESKTOP_PLUGIN_NAME, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Extensions Marketplace keeps organization marketplace plugins out of the legacy pane", {
          voiceover: vo[3],
          action: async () => {
            await openExtensionsMarketplace(ctx);
          },
          assert: async () => {
            const proof = await readExtensionsMarketplaceState(ctx, DESKTOP_PLUGIN_NAME);
            ctx.assert(proof.pageText.includes("Extension Marketplace"), "Extensions Marketplace heading missing.");
            ctx.assert(!proof.pageText.includes(READY_PLUGIN_NAME), `Ready cloud plugin leaked into Extensions marketplace: ${proof.pageText}`);
            ctx.assert(!proof.pageText.includes(NEEDS_SETUP_PLUGIN_NAME), `Needs-setup plugin leaked into Extensions marketplace: ${proof.pageText}`);
            ctx.assert(!proof.pageText.includes(DESKTOP_PLUGIN_NAME), `Desktop-only plugin leaked into Extensions marketplace: ${proof.pageText}`);
          },
          screenshot: {
            name: "connect-partition-extensions-no-den-plugins",
            claim: "Extensions Marketplace no longer renders organization marketplace plugins as local installs.",
            requireText: ["Extension Marketplace"],
            rejectText: [READY_PLUGIN_NAME, NEEDS_SETUP_PLUGIN_NAME, DESKTOP_PLUGIN_NAME, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await setCapabilityViaAdminApi(ctx, { mcpConnections: false }).catch(() => undefined);
        await cleanupSeededResources(ctx).catch((error) => {
          ctx.log(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
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
  ctx.assert(
    probe.response.ok,
    `${PLATFORM_ADMIN_EMAIL} is not a platform admin (overview probe ${probe.response.status}).`,
  );
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

function skillSourceText() {
  return [
    "---",
    `name: partition-ready-${RUN_TAG}`,
    "description: Ready cloud skill for the Connect partition proof.",
    "---",
    "",
    "When invoked, explain that this skill is ready through OpenWork Connect.",
  ].join("\n");
}

async function seedMarketplacePlugins(ctx) {
  await cleanupSeededResources(ctx);
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  const headers = { authorization: `Bearer ${token}` };

  const marketplace = await denApiFetch("/v1/marketplaces", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: MARKETPLACE_NAME, description: "Connect cloud partition seeded marketplace" }),
  });
  ctx.assert(marketplace.response.ok, `Marketplace create failed: ${marketplace.response.status} ${marketplace.text.slice(0, 300)}`);
  state.marketplaceId = marketplace.body?.item?.id ?? null;
  ctx.assert(typeof state.marketplaceId === "string", `Marketplace create response missing id: ${marketplace.text.slice(0, 300)}`);

  const grant = await denApiFetch(`/v1/marketplaces/${state.marketplaceId}/access`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  ctx.assert(grant.response.ok, `Marketplace access grant failed: ${grant.response.status} ${grant.text.slice(0, 300)}`);

  await createSeedPlugin(ctx, {
    name: READY_PLUGIN_NAME,
    description: "A cloud-ready skill-only plugin.",
    components: [{
      type: "skill",
      input: {
        rawSourceText: skillSourceText(),
        metadata: { name: `partition-ready-${RUN_TAG}`, description: "Ready cloud skill" },
      },
    }],
  });

  await createSeedPlugin(ctx, {
    name: NEEDS_SETUP_PLUGIN_NAME,
    description: "A plugin whose MCP dependency has no matching org connection.",
    components: [{
      type: "mcp",
      input: {
        rawSourceText: JSON.stringify({ mcpServers: { unmatched: { url: UNMATCHED_MCP_URL } } }),
        normalizedPayloadJson: { mcpServers: { unmatched: { url: UNMATCHED_MCP_URL } } },
        metadata: { name: "unmatched" },
      },
    }],
  });

  await createSeedPlugin(ctx, {
    name: DESKTOP_PLUGIN_NAME,
    description: "A desktop-only local tool plugin.",
    components: [{
      type: "tool",
      input: {
        rawSourceText: "export function run() { return 'desktop-only'; }",
        metadata: { name: "desktop-only-tool", description: "Installs on this machine" },
      },
    }],
  });

  const connection = await denApiFetch("/v1/mcp-connections", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: CONNECTION_NAME,
      url: CONNECTION_URL,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  ctx.assert(connection.response.ok, `MCP connection create failed: ${connection.response.status} ${connection.text.slice(0, 300)}`);
  state.connectionId = connection.body?.id ?? null;
  ctx.assert(typeof state.connectionId === "string", `MCP connection response missing id: ${connection.text.slice(0, 300)}`);
}

async function createSeedPlugin(ctx, input) {
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  const plugin = await denApiFetch("/v1/plugins", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      orgWide: true,
      marketplaceId: requireStateValue(state.marketplaceId, "marketplace id"),
      components: input.components,
    }),
  });
  ctx.assert(plugin.response.ok, `Plugin create failed for ${input.name}: ${plugin.response.status} ${plugin.text.slice(0, 300)}`);
  const pluginId = plugin.body?.item?.id ?? null;
  ctx.assert(typeof pluginId === "string", `Plugin create response missing id for ${input.name}: ${plugin.text.slice(0, 300)}`);
  state.pluginIds.push(pluginId);
}

async function cleanupSeededResources(ctx) {
  await cleanupSeededConnections(ctx);
  await cleanupSeededMarketplace(ctx);
}

async function cleanupSeededConnections(ctx) {
  if (!state.orgAdminToken) return;
  const token = state.orgAdminToken;
  const headers = { authorization: `Bearer ${token}` };
  const listed = await denApiFetch("/v1/mcp-connections?scope=manageable", { headers });
  if (listed.response.ok && Array.isArray(listed.body?.connections)) {
    for (const connection of listed.body.connections) {
      if (typeof connection.name !== "string" || !connection.name.startsWith("Partition Personal MCP")) continue;
      await denApiFetch(`/v1/mcp-connections/${connection.id}`, { method: "DELETE", headers });
    }
  }
  state.connectionId = null;
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

  const plugins = await denApiFetch(`/v1/plugins?limit=100&q=${encodeURIComponent("Partition")}`, { headers });
  if (plugins.response.ok && Array.isArray(plugins.body?.items)) {
    for (const plugin of plugins.body.items) {
      if (typeof plugin.name !== "string" || !plugin.name.startsWith("Partition")) continue;
      await cleanupPlugin(ctx, plugin.id, token);
    }
  }

  state.marketplaceId = null;
  state.pluginIds = [];
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

async function prepareSignedInDesktopWithConnectOn(ctx) {
  await ensurePlatformAdmin(ctx);
  await ensureOrgAdminContext(ctx);
  await setCapabilityViaAdminApi(ctx, { mcpConnections: true });
  await seedMarketplacePlugins(ctx);
  await signDesktopIntoCloud(ctx);
  await clearDesktopConfigCache(ctx);
  await completeDesktopCloudOnboardingIfNeeded(ctx);
  await remountDesktop(ctx);
}

async function signDesktopIntoCloud(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
  const bootstrap = { baseUrl: DEN_API_URL, apiBaseUrl: DEN_API_URL, requireSignin: false, handoff: null };
  const written = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) return { ok: false };
    await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(DEN_API_URL)});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(DEN_API_URL)});
    localStorage.removeItem('openwork.den.authToken');
    localStorage.removeItem('openwork.den.activeOrgId');
    localStorage.removeItem('openwork.den.activeOrgSlug');
    localStorage.removeItem('openwork.den.activeOrgName');
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
  await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_API_URL });
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
  await ctx.clickText("Continue with organization", { timeoutMs: 5_000 }).catch(() => {});
  await ctx.clickText("Continue to workspace", { timeoutMs: 8_000 }).catch(() => {});
  const needsFolder = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))").catch(() => false);
  if (needsFolder) {
    await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
    await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
    await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace open after folder selection" });
  }
  await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim() === 'Continue without OpenWork Models');
    button?.click();
    return true;
  })()`);
}

async function remountDesktop(ctx) {
  await clearDesktopConfigCache(ctx);
  // The renderer sometimes boots into a dead-blank state (empty root, no
  // control API) that only another reload clears. Retry with bounds.
  let remountReady = false;
  for (let attempt = 0; attempt < 3 && !remountReady; attempt += 1) {
    await ctx.eval("location.reload()");
    try {
      await ctx.waitFor("Boolean(window.__openworkControl) && (document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 45_000, label: `desktop alive after reload (attempt ${attempt + 1})` });
      remountReady = true;
    } catch {
      // fall through to the next reload attempt
    }
  }
  ctx.assert(remountReady, "Desktop never became interactive after remount reloads.");
  await ctx.waitFor("(document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 120_000, label: "react root mounted after reload" });
  await completeDesktopCloudOnboardingIfNeeded(ctx);
}

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, { timeoutMs: 30_000, label: `${tab} settings route` });
  try {
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 10_000, label: "settings surface mounted" });
  } catch {
    await ctx.eval("location.reload()");
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after settings recovery reload" });
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 60_000, label: "settings surface mounted (after recovery)" });
  }
}

async function openExtensionsMarketplace(ctx) {
  await navigateToSettingsTab(ctx, "extensions");
  await ctx.waitForText("My Extensions", { timeoutMs: 30_000 });
  await ctx.clickText("Marketplace", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("Extension Marketplace", { timeoutMs: 30_000 });
  await ctx.control("extensions.refresh-marketplace").catch(() => {});
}

async function waitForConnectText(ctx, text) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);
    if (found) return;
    // The marketplace store serves a cached snapshot after remounts — force a
    // refetch while polling.
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `Connect text did not render: ${text}`);
}

async function scrollConnectGroup(ctx, group) {
  await ctx.eval(`(() => {
    const group = document.querySelector('[data-connect-group=${JSON.stringify(group)}]');
    group?.scrollIntoView({ block: 'center' });
    return Boolean(group);
  })()`);
  await sleep(300);
}

async function readConnectPartitionState(ctx) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.innerText ?? entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const groups = {};
    for (const group of document.querySelectorAll('[data-connect-group]')) {
      groups[group.getAttribute('data-connect-group')] = compact(group);
    }
    return {
      pageText: document.body.innerText,
      groups,
    };
  })()`);
}

async function readExtensionsMarketplaceState(ctx, name) {
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
