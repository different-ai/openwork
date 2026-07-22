import { execSync } from "node:child_process";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-connections-capability.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-connections-capability");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const ORG_ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ORG_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const ORG_FILTER_INPUT = 'input[placeholder="Org name, slug, or id"]';
const NOTION_NAME = "Notion";
const WORKSPACE_PATH = "/tmp/openwork-org-connections-capability";

const state = {
  platformAdminToken: null,
  orgAdminToken: null,
  orgId: null,
  orgSlug: null,
  notionConnectionId: null,
};

export default {
  id: "org-connections-capability",
  title: "Platform admins flip the mcpConnections org capability from /admin; den-web nav and the desktop react uniformly",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Acme starts with org MCP connections off, so the dashboard has no member or admin Connections entry", {
            voiceover: vo[0],
            action: async () => {
              await ensurePlatformAdmin(ctx);
              await ensureOrgAdminContext(ctx);
              await deleteConnectionsNamed(ctx, NOTION_NAME);
              await setCapabilityViaAdminApi(ctx, { mcpConnections: false });
              await signInToDenWebWithOrg(ctx, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard");
              await waitForDashboardNav(ctx);
            },
            assert: async () => {
              const nav = await readDashboardNav(ctx);
              ctx.assert(nav.links.some((link) => link.label.includes("Dashboard")), "Dashboard nav item was missing.");
              ctx.assert(nav.links.some((link) => link.label.includes("Extensions")), "Extensions nav item was missing.");
              assertNoConnectionsNav(ctx, nav);

              const orgView = await fetchOrgCapabilities(ctx);
              ctx.assert(orgView.mcpConnections === false, "/v1/org reported mcpConnections on while the flag is off.");
              ctx.output("mcp-connections-start-dark", JSON.stringify({ capabilities: orgView, nav }, null, 2));
            },
            screenshot: {
              name: "dashboard-mcp-connections-off",
              requireText: ["Dashboard"],
              rejectText: ["Your Connections"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The desktop extensions view hides organization MCP cards while Acme's capability is off", {
          voiceover: vo[1],
          action: async () => {
            await ensureOrgAdminContext(ctx);
            await ensureDesktopSignedInAsOrgAdmin(ctx);
            await openDesktopExtensions(ctx);
            await clickDesktopRefreshIfAvailable(ctx);
            await waitForDesktopOrgCardsGone(ctx);
          },
          assert: async () => {
            await ctx.expectText("Extensions", { timeoutMs: 30_000 });
            await ctx.expectNoText("Available from your organization");
            await ctx.expectNoText("Managed by your organization");
            const usable = await fetchMcpConnections(ctx, "usable");
            ctx.assert(usable.length === 0, `Usable MCP connections were visible while off: ${JSON.stringify(usable)}`);
            ctx.output("desktop-usable-while-off", JSON.stringify({ connections: usable }, null, 2));
          },
          screenshot: {
            name: "desktop-extensions-no-org-cards",
            requireText: ["Extensions"],
            rejectText: ["Available from your organization"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("A platform admin enables Acme's MCP connections capability with the /admin checkbox", {
            voiceover: vo[2],
            action: async () => {
              await signInToDenWebWithoutOrg(ctx, PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD);
              await openAdminOrganizationsForAcme(ctx);
              const checked = await readAcmeMcpConnectionsCheckbox(ctx);
              if (checked !== true) {
                await clickAcmeMcpConnectionsCheckbox(ctx);
              }
              await waitForAcmeMcpConnectionsCheckbox(ctx, true);
            },
            assert: async () => {
              const checked = await readAcmeMcpConnectionsCheckbox(ctx);
              ctx.assert(checked === true, "MCP connections checkbox did not stay checked.");

              const admin = await fetchAdminCapabilities(ctx);
              ctx.assert(admin.mcpConnections === true, "Admin API did not report mcpConnections on after the toggle.");

              const orgView = await fetchOrgCapabilities(ctx);
              ctx.assert(orgView.mcpConnections === true, "/v1/org did not report mcpConnections on after the toggle.");
              ctx.output("mcp-connections-enabled", JSON.stringify({ admin, orgView }, null, 2));
            },
            screenshot: {
              name: "admin-acme-mcp-connections-on",
              requireText: ["Acme Robotics", "MCP connections"],
            },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("With the capability on, Acme can publish the Notion preset for the whole organization", {
            voiceover: vo[3],
            action: async () => {
              await signInToDenWebWithOrg(ctx, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard");
              await waitForDashboardNav(ctx);
              await ctx.waitFor("document.querySelector('nav')?.innerText.includes('Your Connections')", {
                timeoutMs: 30_000,
                label: "Your Connections nav visible",
              });
              await openAdminConnections(ctx);
              await ctx.waitForText("QUICK ADD", { timeoutMs: 30_000 });
              await clickPresetCard(ctx, NOTION_NAME);
              await ctx.waitForText("Add Notion", { timeoutMs: 20_000 });
              await assertNotionDialogPrefilled(ctx);
              await clickLastExactText(ctx, "Add connection", "button");
              await waitForManageableConnectionRow(ctx, NOTION_NAME);
            },
            assert: async () => {
              const nav = await readDashboardNav(ctx);
              ctx.assert(nav.links.some((link) => link.href.includes("/your-connections")), "Your Connections nav was not visible after enabling mcpConnections.");
              ctx.assert(nav.links.some((link) => link.href.includes("/mcp-connections")), "Admin Connections nav was not visible after enabling mcpConnections.");

              const manageable = await fetchMcpConnections(ctx, "manageable");
              const notion = manageable.find((connection) => connection.name === NOTION_NAME);
              ctx.assert(Boolean(notion), "Manageable MCP connections did not include Notion.");
              ctx.assert(notion.credentialMode === "per_member", `Notion credentialMode was ${notion.credentialMode}, expected per_member.`);
              state.notionConnectionId = notion.id;
              ctx.output("notion-published-manageable", JSON.stringify({ notion }, null, 2));
            },
            screenshot: {
              name: "notion-published-in-den-web",
              requireText: ["Notion"],
            },
          });
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("OpenWork Connect shows Acme's Notion org connection as available to connect", {
          voiceover: vo[4],
          action: async () => {
            await remountDesktopConnect(ctx);
            await waitForDesktopConnectOrgConnection(ctx, NOTION_NAME);
            await ctx.eval(`(() => {
              const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
                .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(NOTION_NAME)}));
              row?.scrollIntoView({ block: "center" });
              return Boolean(row);
            })()`);
            await new Promise((resolve) => setTimeout(resolve, 500));
          },
          assert: async () => {
            await ctx.expectText(NOTION_NAME, { timeoutMs: 30_000 });
            await ctx.expectText("NEEDS YOUR SIGN-IN", { timeoutMs: 30_000 });
            await ctx.expectText("Connect your account", { timeoutMs: 30_000 });

            const usable = await fetchMcpConnections(ctx, "usable");
            const notion = usable.find((connection) => connection.name === NOTION_NAME);
            ctx.assert(Boolean(notion), "Usable MCP connections did not include Notion after enabling the capability.");
            ctx.assert(notion.connectedForMe === false, "Notion should not be connected for Alex before member OAuth.");
            ctx.output("desktop-usable-notion", JSON.stringify({ notion }, null, 2));
          },
          screenshot: {
            name: "desktop-connect-shows-notion-org-connection",
            requireText: ["From your organization", "NEEDS YOUR SIGN-IN", "Notion", "Connect your account"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Turning the capability back off removes Notion from OpenWork Connect", {
          voiceover: vo[5],
          action: async () => {
            await withClient(ctx, ADMIN_CDP_URL, async () => {
              await signInToDenWebWithoutOrg(ctx, PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD);
              await openAdminOrganizationsForAcme(ctx);
              const checked = await readAcmeMcpConnectionsCheckbox(ctx);
              if (checked !== false) {
                await clickAcmeMcpConnectionsCheckbox(ctx);
              }
              await waitForAcmeMcpConnectionsCheckbox(ctx, false);
              await signInToDenWebWithOrg(ctx, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard");
              await waitForDashboardNav(ctx);
              await ctx.waitFor(`(() => {
                const nav = document.querySelector('nav');
                if (!nav) return false;
                const links = [...nav.querySelectorAll('a')];
                return !links.some((link) => (link.textContent ?? '').includes('Your Connections') || (link.getAttribute('href') ?? '').includes('/mcp-connections'));
              })()`, { timeoutMs: 30_000, label: "Connections nav removed" });
            });
            await remountDesktopConnect(ctx);
            await waitForDesktopConnectOrgConnectionGone(ctx, NOTION_NAME);
          },
          assert: async () => {
            const admin = await fetchAdminCapabilities(ctx);
            ctx.assert(admin.mcpConnections === false, "Admin API still reported mcpConnections on after turning it off.");

            const orgView = await fetchOrgCapabilities(ctx);
            ctx.assert(orgView.mcpConnections === false, "/v1/org still reported mcpConnections on after turning it off.");

            const visible = await desktopConnectOrgConnectionVisible(ctx, NOTION_NAME);
            ctx.assert(!visible, "Notion org connection row still rendered in OpenWork Connect after disabling the capability.");
            const usable = await fetchMcpConnections(ctx, "usable");
            ctx.assert(usable.length === 0, `Usable MCP connections were still visible after turning the capability off: ${JSON.stringify(usable)}`);
            ctx.output("mcp-connections-off-again", JSON.stringify({ admin, orgView, usable }, null, 2));
          },
          screenshot: {
            name: "desktop-connect-notion-off-again",
            requireText: ["Connect"],
            rejectText: [NOTION_NAME, "NEEDS YOUR SIGN-IN", "Something went wrong"],
          },
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
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withClient(ctx, cdpBaseUrl, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  ctx.client = client;
  try {
    return await fn();
  } finally {
    ctx.client = previous;
    try {
      client.close();
    } catch {
      // Socket already gone.
    }
  }
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) {
    return page;
  }

  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?about:blank`);
  }
  if (!response.ok) {
    throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  }
  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) {
    return created;
  }
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) {
    throw new Error(`No page target available at ${cdpBaseUrl}.`);
  }
  return nextPage;
}

async function denApiFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL || DEN_API_URL,
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

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Platform-admin provisioning requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function ensurePlatformAdmin(ctx) {
  if (state.platformAdminToken) {
    return state.platformAdminToken;
  }

  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Priya Platform", email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  });
  const signupAccepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
  ctx.assert(signupAccepted, `Platform admin sign-up failed: ${signup.response.status} ${signup.text.slice(0, 300)}`);
  markEmailVerified(ctx, PLATFORM_ADMIN_EMAIL);

  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Platform admin sign-in failed: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.platformAdminToken = signedIn.body.token;

  const probe = await denApiFetch("/v1/admin/overview", {
    method: "GET",
    headers: { authorization: `Bearer ${state.platformAdminToken}` },
  });
  ctx.assert(
    probe.response.ok,
    `${PLATFORM_ADMIN_EMAIL} is not a platform admin (overview probe ${probe.response.status}). Start den-api with DEN_BOOTSTRAP_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAIL} or insert the email into admin_allowlist.`,
  );
  return state.platformAdminToken;
}

async function ensureOrgAdminContext(ctx) {
  if (state.orgAdminToken && state.orgId && state.orgSlug) {
    return;
  }

  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ORG_ADMIN_EMAIL, password: ORG_ADMIN_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Org admin sign-in failed for ${ORG_ADMIN_EMAIL}: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.orgAdminToken = signedIn.body.token;

  const listed = await denApiFetch("/v1/me/orgs", {
    method: "GET",
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
  });
  ctx.assert(listed.response.ok, `Could not list ${ORG_ADMIN_EMAIL}'s organizations: ${listed.response.status} ${listed.text.slice(0, 300)}`);
  const orgs = listed.body?.orgs;
  ctx.assert(Array.isArray(orgs), "Current user organizations payload was missing orgs.");
  const acme = orgs.find((org) => org.name === "Acme Robotics") ?? orgs.find((org) => typeof org.slug === "string" && org.slug.includes("acme"));
  ctx.assert(isRecord(acme) && typeof acme.id === "string", `Could not find Acme Robotics in ${ORG_ADMIN_EMAIL}'s organizations.`);

  const active = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
    body: JSON.stringify({ organizationId: acme.id }),
  });
  ctx.assert(active.response.ok, `Could not switch ${ORG_ADMIN_EMAIL}'s active organization to Acme: ${active.response.status} ${active.text.slice(0, 300)}`);

  const org = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
  });
  ctx.assert(org.response.ok, `Could not load ${ORG_ADMIN_EMAIL}'s organization: ${org.response.status} ${org.text.slice(0, 300)}`);
  const organization = org.body?.organization;
  ctx.assert(typeof organization?.id === "string" && typeof organization?.slug === "string", "Organization payload was missing id/slug.");
  ctx.assert(organization.id === acme.id, `Active organization was ${organization.id}, expected Acme ${acme.id}.`);
  state.orgId = organization.id;
  state.orgSlug = organization.slug;
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

async function fetchAdminCapabilities(ctx) {
  const token = requireStateValue(state.platformAdminToken, "platform admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const result = await denApiFetch(`/v1/admin/organizations/${orgId}/capabilities`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `Admin capability fetch failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(isRecord(result.body?.capabilities), "Admin capability response was missing capabilities.");
  return result.body.capabilities;
}

async function fetchOrgCapabilities(ctx) {
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  await ensureOrgAdminActiveOrganization(ctx);
  const result = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `/v1/org fetch failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(isRecord(result.body?.capabilities), "/v1/org response was missing capabilities.");
  return result.body.capabilities;
}

async function fetchMcpConnections(ctx, scope) {
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  await ensureOrgAdminActiveOrganization(ctx);
  const result = await denApiFetch(`/v1/mcp-connections?scope=${scope}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `MCP connections fetch (${scope}) failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(Array.isArray(result.body?.connections), `MCP connections response (${scope}) was missing connections.`);
  return result.body.connections;
}

async function ensureOrgAdminActiveOrganization(ctx) {
  const token = requireStateValue(state.orgAdminToken, "org admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const active = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationId: orgId }),
  });
  ctx.assert(active.response.ok, `Could not switch org-admin API session to Acme: ${active.response.status} ${active.text.slice(0, 300)}`);
}

async function deleteConnectionsNamed(ctx, name) {
  const connections = await fetchMcpConnections(ctx, "manageable");
  for (const connection of connections) {
    if (connection.name !== name) {
      continue;
    }
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${requireStateValue(state.orgAdminToken, "org admin token")}` },
    });
    ctx.assert(removed.response.ok, `Could not remove leftover ${name} connection: ${removed.response.status} ${removed.text.slice(0, 300)}`);
  }
  state.notionConnectionId = null;
}

async function goToDenWeb(ctx, pathname) {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${pathname}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function signInToDenWebWithOrg(ctx, email, password) {
  await submitDenWebSignIn(ctx, email, password);
  await waitForDenWebSession(ctx, email);
  await setDenWebActiveOrganization(ctx);
  await goToDenWeb(ctx, "/dashboard");
  await waitForDashboardNav(ctx);
}

async function setDenWebActiveOrganization(ctx) {
  const orgId = requireStateValue(state.orgId, "organization id");
  const result = await ctx.eval(
    `fetch('/api/den/v1/me/active-organization', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ${JSON.stringify(orgId)} }),
    }).then(async (response) => ({ ok: response.ok, status: response.status, text: (await response.text()).slice(0, 300) }))`,
    { awaitPromise: true },
  );
  ctx.assert(result?.ok, `Could not switch den-web active organization to Acme: ${result?.status} ${result?.text ?? ""}`);
}

async function signInToDenWebWithoutOrg(ctx, email, password) {
  await submitDenWebSignIn(ctx, email, password);
  await waitForDenWebSession(ctx, email);
}

async function submitDenWebSignIn(ctx, email, password) {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/");
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "sign-in screen" });
  await clickExactText(ctx, "Sign in", "button, a");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  await ctx.fill('input[type="email"], input[name="email"]', email);
  await ctx.fill('input[type="password"]', password);
  await clickLastExactText(ctx, "Sign in", "button");
}

async function waitForDenWebSession(ctx, email) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    const sessionEmail = await ctx.eval(
      `fetch('/api/den/api/auth/get-session', { credentials: 'include', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => payload?.user?.email ?? "")
        .catch(() => "")`,
      { awaitPromise: true },
    );
    if (typeof sessionEmail === "string" && sessionEmail.toLowerCase() === email.toLowerCase()) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`den-web session for ${email} did not appear within 45s.`);
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  await ctx.client.send("Network.clearBrowserCookies", {});
}

async function clickExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
}

async function clickLastExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
}

async function clickOrganizationsTab(ctx) {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim().startsWith('Organizations ('));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: "organizations tab" });
}

async function openAdminOrganizationsForAcme(ctx) {
  await goToDenWeb(ctx, "/admin");
  await ctx.waitForText("User backoffice", { timeoutMs: 45_000 });
  await clickOrganizationsTab(ctx);
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"admin-orgs-page\"]'))", {
    timeoutMs: 20_000,
    label: "admin organizations view",
  });
  await ctx.fill(ORG_FILTER_INPUT, "Acme");
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(acmeRowSelector())}))`, {
    timeoutMs: 20_000,
    label: "Acme organization row",
  });
  await scrollAcmeRowIntoView(ctx);
}

function acmeRowSelector() {
  const slug = requireStateValue(state.orgSlug, "organization slug");
  return `[data-testid="admin-org-row-${slug}"]`;
}

function acmeMcpConnectionsCheckboxSelector() {
  return `${acmeRowSelector()} [data-testid="admin-capability-mcpConnections"]`;
}

async function scrollAcmeRowIntoView(ctx) {
  await ctx.eval(`(() => {
    document.querySelector(${JSON.stringify(acmeRowSelector())})?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

async function readAcmeMcpConnectionsCheckbox(ctx) {
  return ctx.eval(`(() => {
    const checkbox = document.querySelector(${JSON.stringify(acmeMcpConnectionsCheckboxSelector())});
    return checkbox ? checkbox.checked : null;
  })()`);
}

async function clickAcmeMcpConnectionsCheckbox(ctx) {
  await ctx.waitFor(`(() => {
    const checkbox = document.querySelector(${JSON.stringify(acmeMcpConnectionsCheckboxSelector())});
    if (!checkbox || checkbox.disabled) {
      return false;
    }
    checkbox.scrollIntoView({ block: 'center' });
    checkbox.click();
    return true;
  })()`, { timeoutMs: 20_000, label: "toggle mcpConnections capability checkbox" });
}

async function waitForAcmeMcpConnectionsCheckbox(ctx, expected) {
  await ctx.waitFor(`(() => {
    const checkbox = document.querySelector(${JSON.stringify(acmeMcpConnectionsCheckboxSelector())});
    return Boolean(checkbox && checkbox.checked === ${expected ? "true" : "false"} && !checkbox.disabled);
  })()`, { timeoutMs: 20_000, label: `mcpConnections checkbox saved as ${expected ? "checked" : "unchecked"}` });
}

async function waitForDashboardNav(ctx) {
  await ctx.waitFor(`(() => {
    const navText = document.querySelector('nav')?.innerText ?? '';
    return navText.includes('Dashboard') && navText.includes('Extensions');
  })()`, { timeoutMs: 30_000, label: "dashboard sidebar nav" });
}

async function readDashboardNav(ctx) {
  return ctx.eval(`(() => {
    const nav = document.querySelector('nav');
    const links = [...(nav?.querySelectorAll('a') ?? [])].map((link) => ({
      label: (link.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      href: link.getAttribute('href') ?? '',
    }));
    return { text: nav?.innerText ?? '', links };
  })()`);
}

function assertNoConnectionsNav(ctx, nav) {
  ctx.assert(!nav.links.some((link) => link.label.includes("Your Connections") || link.href.includes("/your-connections")), "Your Connections nav was visible while mcpConnections was off.");
  ctx.assert(!nav.links.some((link) => link.href.includes("/mcp-connections")), "Admin Connections nav was visible while mcpConnections was off.");
}

async function openAdminConnections(ctx) {
  await ctx.waitFor(
    `(() => {
      if (window.location.pathname.includes('mcp-connections')) return true;
      const link = [...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href')?.includes('mcp-connections'));
      if (link) {
        link.click();
        return false;
      }
      const group = [...document.querySelectorAll('nav a, nav button')].find((el) => (el.textContent ?? '').trim().startsWith('Extensions'));
      group?.click();
      return false;
    })()`,
    { timeoutMs: 30_000, label: "MCP Connections nav link clicked" },
  );
  await ctx.waitFor("window.location.pathname.includes('mcp-connections')", {
    timeoutMs: 20_000,
    label: "MCP Connections route",
  });
}

async function clickPresetCard(ctx, name) {
  await ctx.waitFor(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => {
      const text = candidate.textContent ?? '';
      return !candidate.disabled && text.includes(${JSON.stringify(name)}) && text.includes('Tap to add');
    });
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: `${name} preset card` });
}

async function assertNotionDialogPrefilled(ctx) {
  const prefilled = await ctx.eval(`(() => {
    const values = [...document.querySelectorAll('input')].map((input) => input.value);
    return values.includes('Notion') && values.includes('https://mcp.notion.com/mcp');
  })()`);
  ctx.assert(prefilled, "Notion add dialog did not open with the expected name and URL.");
}

async function waitForManageableConnectionRow(ctx, name) {
  await ctx.waitFor(`(() => {
    const body = document.body.innerText;
    return body.includes(${JSON.stringify(name)}) && body.includes('Individual accounts') && body.includes('Everyone in the org');
  })()`, { timeoutMs: 30_000, label: `${name} manageable connection row` });
}

async function ensureDesktopSignedInAsOrgAdmin(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API" });

  const current = await ctx.eval(`(() => ({
    token: (localStorage.getItem('openwork.den.authToken') ?? '').trim(),
    activeOrgId: (localStorage.getItem('openwork.den.activeOrgId') ?? '').trim(),
  }))()`);
  if (current.token) {
    const org = await denApiFetch("/v1/org", {
      method: "GET",
      headers: { authorization: `Bearer ${current.token}` },
    });
    if (org.response.ok && org.body?.organization?.id === state.orgId) {
      await completeDesktopCloudOnboardingIfNeeded(ctx);
      return;
    }
  }

  await clearDesktopDenSession(ctx);
  const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { authorization: `Bearer ${requireStateValue(state.orgAdminToken, "org admin token")}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(handoff.response.ok, `Desktop handoff create failed: ${handoff.response.status} ${handoff.text.slice(0, 300)}`);
  ctx.assert(typeof handoff.body?.openworkUrl === "string", "Desktop handoff response did not include openworkUrl.");

  await ctx.navigateHash("/settings/cloud-account");
  await ctx.waitFor("window.location.hash.includes('/settings/cloud-account')", { timeoutMs: 30_000, label: "cloud account settings" });
  await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
  await ctx.fill("#den-signin-link", handoff.body.openworkUrl);
  await ctx.clickText("Finish sign-in", { timeoutMs: 30_000 });
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "persisted den auth token",
  });
  await completeDesktopCloudOnboardingIfNeeded(ctx);
  await ctx.waitFor(`localStorage.getItem('openwork.den.activeOrgId') === ${JSON.stringify(requireStateValue(state.orgId, "organization id"))}`, {
    timeoutMs: 60_000,
    label: "Acme active org resolved",
  });
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

async function clearDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    localStorage.removeItem('openwork.den.authToken');
    localStorage.removeItem('openwork.den.activeOrgId');
    localStorage.removeItem('openwork.den.activeOrgSlug');
    localStorage.removeItem('openwork.den.activeOrgName');
    localStorage.removeItem('openwork.den.mcp.sync');
    return true;
  })()`);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API after sign-out reload" });
}

async function closeDesktopDialogs(ctx) {
  await ctx.eval(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function openDesktopExtensions(ctx) {
  await closeDesktopDialogs(ctx);
  await ctx.navigateHash("/settings/extensions");
  await ctx.waitFor("window.location.hash.includes('/settings/extensions')", { timeoutMs: 30_000, label: "desktop extensions route" });
  await ctx.waitFor(
    "document.body.innerText.includes('My Extensions') && document.body.innerText.includes('Refresh')",
    { timeoutMs: 60_000, label: "desktop extensions view" },
  );
}

async function openDesktopConnect(ctx) {
  await closeDesktopDialogs(ctx);
  await ctx.navigateHash("/settings/connect");
  await ctx.waitFor("window.location.hash.includes('/settings/connect')", { timeoutMs: 30_000, label: "desktop connect route" });
  await ctx.waitFor("document.body.innerText.includes('Connect')", { timeoutMs: 60_000, label: "desktop connect view" });
}

async function remountDesktopConnect(ctx) {
  await closeDesktopDialogs(ctx);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API after reload" });
  await completeDesktopCloudOnboardingIfNeeded(ctx);
  await openDesktopConnect(ctx);
}

async function clickDesktopRefreshIfAvailable(ctx) {
  const clicked = await ctx.eval(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((button) => (button.textContent ?? '').trim() === 'Refresh' && !button.disabled);
    const button = buttons[buttons.length - 1];
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked) {
    await sleep(500);
  }
}

async function waitForDesktopOrgCardsGone(ctx) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const gone = await ctx.eval(`(() => {
      const text = document.body.innerText;
      return text.includes('My Extensions') && !text.includes('Available from your organization') && !text.includes('Managed by your organization');
    })()`);
    if (gone) {
      return;
    }
    await clickDesktopRefreshIfAvailable(ctx);
    await sleep(1_000);
  }
  ctx.assert(false, "Organization MCP cards did not disappear from desktop extensions.");
}

async function desktopConnectOrgConnectionVisible(ctx, name) {
  return ctx.eval(`(() => {
    return [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
      .some((row) => (row.textContent ?? '').includes(${JSON.stringify(name)}));
  })()`);
}

async function waitForDesktopConnectOrgConnection(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await desktopConnectOrgConnectionVisible(ctx, name)) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `${name} org MCP connection did not render in OpenWork Connect.`);
}

async function waitForDesktopConnectOrgConnectionGone(ctx, name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await desktopConnectOrgConnectionVisible(ctx, name))) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(1_000);
  }
  ctx.assert(false, `${name} org MCP connection did not disappear from OpenWork Connect.`);
}
