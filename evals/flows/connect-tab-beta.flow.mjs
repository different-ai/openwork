import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connect-tab-beta";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL || DEN_API_URL);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const WORKSPACE_PATH = "/tmp/openwork-connect-tab-beta";
const RUN_TAG = Date.now();
const CONNECTION_NAME = `connect-tab-beta-${RUN_TAG}`;
const CONNECTION_URL = "https://connect-tab-beta.example.com/mcp";

const state = {
  orgAdminToken: null,
  platformAdminToken: null,
  orgId: null,
  connectionId: null,
};

export default {
  id: FLOW_ID,
  title: "Desktop Connect tab alpha shell shows pitch, active org MCP cards, and leaves Extensions local-only",
  kind: "user-facing",
  spec: "evals/voiceovers/connect-tab-beta.md",
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
        await ctx.prove("The Connect tab is visible in the Cloud settings group with an Alpha badge", {
          voiceover: vo[0],
          action: async () => {
            await prepareSignedInDesktopWithConnectOff(ctx);
            // Frame 1 proves the SIDEBAR (Connect entry + badge) from the
            // Account tab so its capture differs from frame 2's pitch view.
            await navigateToSettingsTab(ctx, "cloud-account");
          },
          assert: async () => {
            const nav = await readSettingsSidebar(ctx);
            ctx.assert(nav.text.includes("Cloud"), `Settings sidebar did not include Cloud: ${nav.text}`);
            ctx.assert(nav.connectButtonText.includes("Connect"), `Connect tab button missing: ${JSON.stringify(nav)}`);
            ctx.assert(nav.connectButtonText.includes("Alpha"), `Connect tab button missing Alpha badge: ${nav.connectButtonText}`);
            await ctx.expectHashIncludes("/settings/cloud-account");
          },
          screenshot: {
            name: "connect-tab-beta-sidebar",
            claim: "Settings shows Connect under Cloud and marks it Alpha.",
            requireText: ["Cloud", "Connect", "ALPHA"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("With the org capability off and zero usable connections, Connect shows the pitch state", {
          voiceover: vo[1],
          action: async () => {
            await navigateToSettingsTab(ctx, "connect");
            await ctx.waitForText("Connect is the new way OpenWork lets you share workflows with your team.", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => ({
              text: document.body.innerText,
              cardCount: document.querySelectorAll('[data-testid="connect-org-mcp-card"]').length,
            }))()`);
            ctx.assert(proof.text.includes("Ask your organization admin to enable Connect (alpha) to get started."), "Pitch body was missing.");
            ctx.assert(proof.text.includes("Manage in Den web"), "Pitch did not include the Den web link.");
            ctx.assert(proof.cardCount === 0, `Pitch rendered org connection cards: ${proof.cardCount}`);
            ctx.assert(!proof.text.includes("AVAILABLE APPS"), "Connect pitch leaked the local quick-connect grid.");
          },
          screenshot: {
            name: "connect-tab-beta-pitch",
            claim: "Signed in without Connect enabled shows a friendly admin pitch, not an error.",
            requireText: ["Connect is the new way OpenWork lets you share workflows with your team.", "Manage in Den web"],
            rejectText: [CONNECTION_NAME, "AVAILABLE APPS", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("After the org capability is enabled and a connection is published, Connect shows the active org card", {
          voiceover: vo[2],
          action: async () => {
            await setCapabilityViaAdminApi(ctx, { mcpConnections: true });
            await createPerMemberConnection(ctx);
            await clearDesktopConfigCache(ctx);
            await reloadUntilAlive(ctx, "desktop after capability flip");
            await completeDesktopCloudOnboardingIfNeeded(ctx);
            await navigateToSettingsTab(ctx, "connect");
            await waitForConnectConnectionCard(ctx, CONNECTION_NAME);
          },
          assert: async () => {
            const proof = await readConnectState(ctx, CONNECTION_NAME);
            ctx.assert(proof.statusText.includes("Connected to"), `Connect status row missing org status: ${JSON.stringify(proof)}`);
            ctx.assert(proof.cardText.includes(CONNECTION_NAME), `Connect row missing connection name: ${JSON.stringify(proof)}`);
            ctx.assert(proof.pageText.includes("NEEDS YOUR SIGN-IN"), `Per-member group missing: ${proof.pageText.slice(0, 300)}`);
            ctx.assert(proof.cardText.includes("Connect"), `Per-member Connect action missing: ${proof.cardText}`);
            ctx.assert(!proof.pageText.includes("AVAILABLE APPS"), "Connect active state leaked the local quick-connect grid.");
          },
          screenshot: {
            name: "connect-tab-beta-active-card",
            claim: "Connect active state shows the org status row and the alpha org MCP connection card.",
            requireText: ["Connected to", CONNECTION_NAME, "NEEDS YOUR SIGN-IN"],
            rejectText: ["AVAILABLE APPS", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Extensions keeps the old local sections but no longer renders org-connection cards", {
          voiceover: vo[3],
          action: async () => {
            await navigateToSettingsTab(ctx, "extensions");
            await ctx.waitForText("My Extensions", { timeoutMs: 30_000 });
            await assertNoOrgConnectionInExtensions(ctx, CONNECTION_NAME);
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => ({
              text: document.body.innerText,
              orgCardCount: [...document.querySelectorAll('button')].filter((button) => button.textContent.includes(${JSON.stringify(CONNECTION_NAME)})).length,
            }))()`);
            ctx.assert(proof.text.includes("My Extensions"), "Extensions local shell was missing My Extensions.");
            ctx.assert(proof.text.includes("AVAILABLE APPS"), "Extensions local quick-connect section was missing.");
            ctx.assert(proof.text.includes("One-click connect"), "Extensions quick-connect helper text was missing.");
            ctx.assert(proof.orgCardCount === 0, `Extensions rendered org connection cards: ${proof.orgCardCount}`);
            ctx.assert(!proof.text.includes("Available from your organization"), "Extensions rendered org connection description text.");
          },
          screenshot: {
            name: "connect-tab-beta-extensions-local-only",
            claim: "Extensions still shows local quick-connect content but no org MCP connection card.",
            requireText: ["My Extensions", "AVAILABLE APPS", "One-click connect"],
            rejectText: [CONNECTION_NAME, "Available from your organization", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await cleanupProofConnection(ctx);
        await setCapabilityViaAdminApi(ctx, { mcpConnections: false }).catch(() => undefined);
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
  // Use the signed-in admin's ACTIVE org (what the desktop session targets) —
  // seed org names vary across stack lifetimes, the active org does not.
  const activeOrgId = typeof listed.body?.activeOrgId === "string" ? listed.body.activeOrgId : null;
  const demoOrg = orgs.find((org) => org.id === activeOrgId) ?? orgs[0];
  ctx.assert(demoOrg && typeof demoOrg.id === "string", `Could not resolve an organization for ${ADMIN_EMAIL}.`);
  state.orgId = demoOrg.id;

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

async function cleanupProofConnection(ctx) {
  if (!state.orgAdminToken) return;
  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
  });
  if (!existing.response.ok) return;
  for (const connection of existing.body?.connections ?? []) {
    if (typeof connection.name !== "string" || !connection.name.startsWith("connect-tab-beta-")) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${state.orgAdminToken}` },
    });
    ctx.assert(removed.response.ok, `Could not remove leftover ${connection.name}: ${removed.response.status}`);
  }
  state.connectionId = null;
}

async function createPerMemberConnection(ctx) {
  await cleanupProofConnection(ctx);
  const created = await denApiFetch("/v1/mcp-connections", {
    method: "POST",
    headers: { authorization: `Bearer ${requireStateValue(state.orgAdminToken, "org admin token")}` },
    body: JSON.stringify({
      name: CONNECTION_NAME,
      url: CONNECTION_URL,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    }),
  });
  ctx.assert(created.response.ok, `Connection create failed: ${created.response.status} ${created.text.slice(0, 300)}`);
  state.connectionId = created.body?.id ?? created.body?.connection?.id ?? null;
  ctx.assert(Boolean(state.connectionId), `Connection create response did not include an id: ${created.text.slice(0, 300)}`);
}

async function prepareSignedInDesktopWithConnectOff(ctx) {
  await ensurePlatformAdmin(ctx);
  await ensureOrgAdminContext(ctx);
  await setCapabilityViaAdminApi(ctx, { mcpConnections: true });
  await cleanupProofConnection(ctx);
  await setCapabilityViaAdminApi(ctx, { mcpConnections: false });
  await signDesktopIntoCloud(ctx);
  await clearDesktopConfigCache(ctx);
  await completeDesktopCloudOnboardingIfNeeded(ctx);
}


async function reloadUntilAlive(ctx, label) {
  let alive = false;
  for (let attempt = 0; attempt < 3 && !alive; attempt += 1) {
    await ctx.eval("location.reload()");
    try {
      await ctx.waitFor("Boolean(window.__openworkControl) && (document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 45_000, label: `${label} (attempt ${attempt + 1})` });
      alive = true;
    } catch {
      // next attempt
    }
  }
  ctx.assert(alive, `Desktop never became interactive: ${label}`);
}

async function signDesktopIntoCloud(ctx) {
  try {
    await ctx.waitFor("Boolean(window.__openworkControl) && (document.getElementById('root')?.childElementCount ?? 0) > 0", { timeoutMs: 30_000, label: "desktop control API" });
  } catch {
    await reloadUntilAlive(ctx, "desktop initial boot");
  }
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
  await reloadUntilAlive(ctx, "desktop after bootstrap write");

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
    label: "Acme active org resolved",
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

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, { timeoutMs: 30_000, label: `${tab} settings route` });
  // The route can be live before React mounts the settings surface (fresh
  // reloads during sign-in). "Back to app" only exists on the settings shell.
  // Hash changes during early boot can leave the root empty — recover once.
  try {
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 10_000, label: "settings surface mounted" });
  } catch {
    await ctx.eval("location.reload()");
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after settings recovery reload" });
    await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", { timeoutMs: 60_000, label: "settings surface mounted (after recovery)" });
  }
}

async function readSettingsSidebar(ctx) {
  return ctx.eval(`(() => {
    // Several sidebars can be mounted at once (app session sidebar + settings
    // tabs sidebar). Anchor on the settings one: it is the only surface that
    // contains the "Back to app" affordance (fallback: the Cloud group).
    const candidates = [...document.querySelectorAll('[data-sidebar="sidebar"], aside, nav')];
    const sidebar = candidates.find((el) => (el.innerText ?? '').includes('Back to app'))
      ?? candidates.find((el) => (el.innerText ?? '').includes('Cloud'))
      ?? candidates[0];
    const buttons = [...(sidebar?.querySelectorAll('button') ?? [])].map((button) => (button.textContent ?? '').replace(/\\s+/g, ' ').trim());
    return {
      text: (sidebar?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      connectButtonText: buttons.find((text) => text.includes('Connect')) ?? '',
      buttons,
    };
  })()`);
}

async function waitForConnectConnectionCard(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
      .some((row) => (row.textContent ?? '').includes(${JSON.stringify(name)})))()`);
    if (found) return;
    await sleep(2_000);
  }
  ctx.assert(false, `Connect row did not render: ${name}`);
}

async function readConnectState(ctx, name) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const card = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
      .find((entry) => compact(entry).includes(${JSON.stringify(name)}));
    return {
      pageText: document.body.innerText,
      statusText: compact(document.querySelector('[data-testid="connect-org-status-row"]')),
      cardText: compact(card),
    };
  })()`);
}

async function assertNoOrgConnectionInExtensions(ctx, name) {
  const myText = await ctx.eval("document.body.innerText");
  ctx.assert(!myText.includes(name), "My Extensions rendered the org connection before checking Marketplace.");
  await ctx.clickText("Marketplace", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitFor(
    "(document.body?.innerText ?? '').includes('Extension Marketplace') || (document.body?.innerText ?? '').includes('installs on this machine')",
    { timeoutMs: 30_000, label: "marketplace pane heading" },
  );
  const marketplaceText = await ctx.eval("document.body.innerText");
  ctx.assert(!marketplaceText.includes(name), "Marketplace rendered the org connection.");
  ctx.assert(!marketplaceText.includes("Organization MCP Connections"), "Marketplace kept the org MCP filter option.");
  await ctx.clickText("My Extensions", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText("AVAILABLE APPS", { timeoutMs: 30_000 });
}
