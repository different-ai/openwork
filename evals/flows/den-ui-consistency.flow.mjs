import { execFileSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-ui-consistency";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = "riley.ui-consistency@acme.test";
const MEMBER_PASSWORD = "OpenWorkDemo123!";
const CATALOG_PREFIX = "UI Catalog";
const CATALOG_SIZE = 24;
const REAUTH_PLUGIN_NAME = `Security proof ${Date.now()}`;

const state = {
  adminToken: "",
  memberToken: "",
  organizationId: "",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

async function denFetch(path, options = {}) {
  const authPath = path.startsWith("/api/auth/");
  const response = await fetch(`${authPath ? DEN_WEB_URL : DEN_API_URL}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      origin: DEN_WEB_URL,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function signInApi(email, password) {
  const result = await denFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return result.response.ok && typeof result.body?.token === "string" ? result.body.token : "";
}

function markVerified(ctx, email) {
  runMysql(`UPDATE user SET email_verified = 1 WHERE email = '${email.replaceAll("'", "''")}';`);
  witness(ctx, true, "The eval marks the newly created member email as verified", { email });
}

async function ensureAccount(ctx, { email, name, password }) {
  let token = await signInApi(email, password);
  if (!token) {
    const signUp = await denFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, name, password }),
    });
    witness(ctx, signUp.response.ok || [400, 409, 422].includes(signUp.response.status), `${name}'s account exists or was created`, {
      status: signUp.response.status,
      body: signUp.body,
    });
    markVerified(ctx, email);
    token = await signInApi(email, password);
  }
  witness(ctx, token.length > 0, `${name} can sign in through Den`, { email });
  return token;
}

async function ensureSetup(ctx) {
  if (state.adminToken && state.memberToken && state.organizationId) return;

  state.adminToken = await ensureAccount(ctx, {
    email: ADMIN_EMAIL,
    name: "Alex Chen",
    password: ADMIN_PASSWORD,
  });
  const org = await denFetch("/v1/org", { headers: authHeaders(state.adminToken) });
  witness(ctx, org.response.ok && typeof org.body?.organization?.id === "string", "Alex can load the active workspace", {
    status: org.response.status,
    organization: org.body?.organization,
  });
  state.organizationId = org.body.organization.id;

  state.memberToken = await ensureAccount(ctx, {
    email: MEMBER_EMAIL,
    name: "Riley Member",
    password: MEMBER_PASSWORD,
  });
  let memberOrgs = await denFetch("/v1/me/orgs", { headers: authHeaders(state.memberToken) });
  const alreadyMember = () => Array.isArray(memberOrgs.body?.orgs)
    && memberOrgs.body.orgs.some((entry) => entry?.id === state.organizationId);
  if (!alreadyMember()) {
    const invite = await denFetch("/v1/invitations", {
      method: "POST",
      headers: authHeaders(state.adminToken),
      body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
    });
    witness(ctx, invite.response.ok, "Alex can invite Riley to the active workspace", {
      status: invite.response.status,
      body: invite.body,
    });
    const accept = await denFetch("/v1/orgs/invitations/accept", {
      method: "POST",
      headers: authHeaders(state.memberToken),
      body: JSON.stringify({ id: invite.body.inviteToken }),
    });
    witness(ctx, accept.response.ok && accept.body?.accepted === true, "Riley can accept the workspace invitation", {
      status: accept.response.status,
      body: accept.body,
    });
    memberOrgs = await denFetch("/v1/me/orgs", { headers: authHeaders(state.memberToken) });
  }
  witness(ctx, alreadyMember(), "Riley is an ordinary member of Alex's workspace", memberOrgs.body?.orgs);

  await enableInstallLinks();
  await ensureLargeCatalog(ctx);
}

async function ensureLargeCatalog(ctx) {
  const marketplaces = await denFetch("/v1/marketplaces?limit=50", { headers: authHeaders(state.adminToken) });
  witness(ctx, marketplaces.response.ok, "The workspace marketplace catalog is available", {
    status: marketplaces.response.status,
    body: marketplaces.body,
  });
  let marketplaceId = marketplaces.body?.items?.[0]?.id ?? marketplaces.body?.marketplaces?.[0]?.id ?? "";
  if (!marketplaceId) {
    const created = await denFetch("/v1/marketplaces", {
      method: "POST",
      headers: authHeaders(state.adminToken),
      body: JSON.stringify({ name: "UI Consistency", description: "A seeded catalog for the Den UI proof." }),
    });
    witness(ctx, created.response.ok && typeof created.body?.item?.id === "string", "The proof marketplace is available", created.body);
    marketplaceId = created.body.item.id;
  }

  const existing = await denFetch(`/v1/plugins?limit=50&q=${encodeURIComponent(CATALOG_PREFIX)}`, {
    headers: authHeaders(state.adminToken),
  });
  witness(ctx, existing.response.ok, "The plugin catalog can be queried", { status: existing.response.status });
  const existingNames = new Set((existing.body?.items ?? existing.body?.plugins ?? []).map((item) => item.name));
  for (let index = 1; index <= CATALOG_SIZE; index += 1) {
    const name = `${CATALOG_PREFIX} ${String(index).padStart(2, "0")}`;
    if (existingNames.has(name)) continue;
    const created = await denFetch("/v1/plugins", {
      method: "POST",
      headers: authHeaders(state.adminToken),
      body: JSON.stringify({
        name,
        description: `Lightweight catalog card ${index} for browser rendering validation.`,
        orgWide: true,
        marketplaceId,
      }),
    });
    witness(ctx, created.response.ok, `Catalog plugin ${index} is seeded`, { status: created.response.status, body: created.body });
  }
}

function mysqlContainer() {
  return process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() || "openwork-web-local-mysql";
}

function runMysql(sql) {
  execFileSync("docker", [
    "exec",
    mysqlContainer(),
    "mysql",
    "-uroot",
    "-ppassword",
    "openwork_den",
    "-e",
    sql,
  ], { stdio: "ignore" });
}

async function enableInstallLinks() {
  runMysql(`
    UPDATE organization
    SET metadata = JSON_SET(
      COALESCE(metadata, JSON_OBJECT()),
      '$.capabilities.installLinks',
      JSON_EXTRACT('true', '$')
    );
  `);
}

async function stageStaleSession(ctx) {
  runMysql("UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR);");
  if (!ctx.client?.send) return;
  const result = await ctx.client.send("Network.getAllCookies", {});
  for (const cookie of result.cookies.filter((entry) => entry.name.includes("session_data"))) {
    await ctx.client.send("Network.deleteCookies", {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
    });
  }
}

async function navigateTo(ctx, path) {
  const url = new URL(path, DEN_WEB_URL).toString();
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
}

async function clearSession(ctx) {
  await navigateTo(ctx, "/");
  await ctx.eval(`fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  }).catch(() => null).then(() => {
    localStorage.clear();
    sessionStorage.clear();
    return true;
  })`, { awaitPromise: true });
  if (ctx.client?.send) await ctx.client.send("Network.clearBrowserCookies", {});
}

async function clickExact(ctx, text, selector = "button, a") {
  await ctx.waitFor(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !entry.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click ${text}` });
}

async function uiSignIn(ctx, email, password) {
  await clearSession(ctx);
  await navigateTo(ctx, "/");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"]'))", { timeoutMs: 30_000, label: "email-first sign in" });
  await ctx.fill('input[type="email"]', email);
  await clickExact(ctx, "Next", "button");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "password sign in step" });
  await ctx.fill('input[type="password"]', password);
  await clickExact(ctx, "Sign in", "button");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign in" });
  await ctx.waitFor("Boolean(document.querySelector('nav'))", { timeoutMs: 30_000, label: "Den dashboard navigation" });
  await sleep(700);
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) return;
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

export default {
  id: FLOW_ID,
  title: "Den stays responsive and coherent across catalogs, member access, settings, security, and Stripe",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
  ],
  steps: [
    {
      name: "Focused dashboard",
      run: async (ctx) => {
        await ctx.prove("The dashboard keeps the workspace download while removing the extensions promotion", {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            await ensureSetup(ctx);
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await navigateTo(ctx, "/dashboard");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"organization-download-card\"]'))", {
              timeoutMs: 30_000,
              label: "organization download card",
            });
          },
          assert: async () => {
            await ctx.expectNoText("Download the app to unlock extensions");
            const actual = await ctx.eval(`(() => ({
              downloadCard: Boolean(document.querySelector('[data-testid="organization-download-card"]')),
              downloadButton: Boolean(document.querySelector('[data-testid="organization-download-button"]')),
              promotion: document.body.innerText.includes('Download the app to unlock extensions'),
            }))()`);
            witness(ctx, actual.downloadCard && actual.downloadButton && !actual.promotion, "Only the useful workspace download remains", actual);
          },
          screenshot: {
            name: "focused-dashboard",
            requireText: ["Dashboard", "Download OpenWork", "Download for this workspace"],
            rejectText: ["Download the app to unlock extensions"],
            hashIncludes: "/dashboard",
          },
        });
      },
    },
    {
      name: "Large static catalogs",
      run: async (ctx) => {
        await ctx.prove("Large plugin and marketplace lists keep distinctive artwork without per-card canvases", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, "/dashboard/plugins");
            await ctx.waitFor(`document.querySelectorAll('[data-static-paper-gradient]').length >= ${CATALOG_SIZE}`, {
              timeoutMs: 45_000,
              label: "large static plugin catalog",
            });
            await ctx.eval(`(() => {
              const cards = [...document.querySelectorAll('[data-static-paper-gradient]')];
              cards.at(-1)?.scrollIntoView({ block: 'center' });
              return cards.length;
            })()`);
            await ctx.screenshot("large-plugin-catalog", {
              claim: "The large plugin list renders lightweight distinctive artwork.",
              voiceover: vo[1],
              requireText: ["Plugins", CATALOG_PREFIX],
              rejectText: ["Something went wrong"],
              hashIncludes: "/dashboard/plugins",
            });
            await navigateTo(ctx, "/dashboard/marketplaces");
            await ctx.waitFor("document.body.innerText.includes('Marketplaces')", { timeoutMs: 30_000, label: "marketplaces catalog" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const artwork = [...document.querySelectorAll('[data-static-paper-gradient]')];
              return {
                artworkCount: artwork.length,
                canvasDescendants: artwork.reduce((count, node) => count + node.querySelectorAll('canvas').length, 0),
                pageCanvases: document.querySelectorAll('canvas').length,
              };
            })()`);
            witness(ctx, actual.artworkCount >= 1, "Marketplace cards use the shared static artwork", actual);
            witness(ctx, actual.canvasDescendants === 0, "Repeated catalog artwork creates zero canvas or WebGL descendants", actual);
          },
          screenshot: {
            name: "static-marketplace-catalog",
            requireText: ["Marketplaces"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/dashboard/marketplaces",
          },
        });
      },
    },
    {
      name: "Invited member home",
      run: async (ctx) => {
        await ctx.prove("An ordinary member gets a compact resource dashboard with no admin controls", {
          voiceover: vo[2],
          action: async () => {
            await uiSignIn(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
            await navigateTo(ctx, "/dashboard");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"member-dashboard\"]'))", {
              timeoutMs: 30_000,
              label: "member dashboard",
            });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              dashboard: Boolean(document.querySelector('[data-testid="member-dashboard"]')),
              overview: Boolean(document.querySelector('[data-testid="member-resource-overview"]')),
              cards: document.querySelectorAll('[data-testid="member-resource-card"]').length,
              download: Boolean(document.querySelector('[data-testid="organization-download-card"]')),
              adminCreatePlugin: [...document.querySelectorAll('button, a')].some((entry) => entry.textContent?.trim() === 'Create plugin'),
            }))()`);
            witness(ctx, actual.dashboard && actual.overview && actual.cards >= 3, "Riley sees compact member-scoped resource cards", actual);
            witness(ctx, actual.download && !actual.adminCreatePlugin, "The member retains the download action without admin creation controls", actual);
          },
          screenshot: {
            name: "compact-member-dashboard",
            requireText: ["Your workspace", "OpenWork Models", "Marketplaces", "Plugins"],
            rejectText: ["Create plugin", "Something went wrong"],
            hashIncludes: "/dashboard",
          },
        });
      },
    },
    {
      name: "Dashboard action geometry",
      run: async (ctx) => {
        await ctx.prove("Dashboard actions are rounded rectangles while labels and status tokens remain pills", {
          voiceover: vo[3],
          action: async () => {
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await navigateTo(ctx, "/dashboard/plugins");
            await ctx.waitFor("document.body.innerText.includes('Create plugin')", { timeoutMs: 30_000, label: "plugin actions" });
            await ctx.eval(`(() => {
              const badge = [...document.querySelectorAll('span')].find((entry) => entry.textContent?.trim() === 'Preview');
              badge?.scrollIntoView({ block: 'start' });
              window.scrollTo(0, 0);
              const main = document.querySelector('main');
              if (main) main.scrollTop = 0;
              return Boolean(badge);
            })()`);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const action = [...document.querySelectorAll('a, button')].find((entry) => entry.textContent?.trim() === 'Create plugin');
              const badge = [...document.querySelectorAll('span')].find((entry) => entry.textContent?.trim() === 'Preview');
              const actionStyle = action ? getComputedStyle(action) : null;
              const badgeStyle = badge ? getComputedStyle(badge) : null;
              return {
                actionRadius: actionStyle ? Number.parseFloat(actionStyle.borderTopLeftRadius) : null,
                actionHeight: action?.getBoundingClientRect().height ?? null,
                badgeRadius: badgeStyle ? Number.parseFloat(badgeStyle.borderTopLeftRadius) : null,
                badgeHeight: badge?.getBoundingClientRect().height ?? null,
              };
            })()`);
            witness(ctx, actual.actionRadius !== null && actual.actionRadius <= 12, "The primary dashboard action has softly rectangular corners", actual);
            witness(ctx, actual.badgeRadius !== null && actual.badgeHeight !== null && actual.badgeRadius >= actual.badgeHeight / 2, "The Preview status remains a pill", actual);
          },
          screenshot: {
            name: "dashboard-action-geometry",
            requireText: ["Plugins", "Create plugin"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/dashboard/plugins",
          },
        });
      },
    },
    {
      name: "General settings stay focused",
      run: async (ctx) => {
        await ctx.prove("General settings has its own focused route with no brand controls", {
          voiceover: vo[4],
          action: async () => {
            await navigateTo(ctx, "/dashboard/org-settings");
            await ctx.waitFor("document.body.innerText.includes('Organization Identity')", { timeoutMs: 30_000, label: "general settings" });
          },
          assert: async () => {
            await ctx.expectText("Organization Identity");
            await ctx.expectNoText("Brand Appearance");
            const actual = await ctx.eval(`({
              path: location.pathname,
              brandFields: document.querySelectorAll('[data-testid^="brand-"]').length,
            })`);
            witness(ctx, actual.path === "/dashboard/org-settings" && actual.brandFields === 0, "General has no embedded brand appearance form", actual);
          },
          screenshot: {
            name: "focused-general-settings",
            requireText: ["General", "Organization Identity", "Allowed email domains"],
            rejectText: ["Brand Appearance"],
            hashIncludes: "/dashboard/org-settings",
          },
        });
      },
    },
    {
      name: "Brand appearance destination",
      run: async (ctx) => {
        await ctx.prove("Brand appearance owns workspace identity previews and saving on a separate route", {
          voiceover: vo[5],
          action: async () => {
            await navigateTo(ctx, "/dashboard/brand-appearance");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"brand-appearance-screen\"]'))", {
              timeoutMs: 30_000,
              label: "brand appearance screen",
            });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              path: location.pathname,
              screen: Boolean(document.querySelector('[data-testid="brand-appearance-screen"]')),
              logo: Boolean(document.querySelector('[data-testid="brand-logo-asset-field"]')),
              icon: Boolean(document.querySelector('[data-testid="brand-icon-asset-field"]')),
              save: [...document.querySelectorAll('button')].some((entry) => /save/i.test(entry.textContent ?? '')),
            }))()`);
            witness(ctx, actual.path === "/dashboard/brand-appearance" && actual.screen && actual.logo && actual.icon && actual.save, "Brand controls and their save action live on the dedicated route", actual);
          },
          screenshot: {
            name: "brand-appearance-route",
            requireText: ["Brand appearance", "Wordmark", "Square app icon", "Accent color"],
            rejectText: ["Allowed email domains", "Something went wrong"],
            hashIncludes: "/dashboard/brand-appearance",
          },
        });
      },
    },
    {
      name: "Protected action completes after verification",
      run: async (ctx) => {
        await ctx.prove("A calm security dialog explains fresh sign-in and then completes the queued action", {
          voiceover: vo[6],
          action: async () => {
            await stageStaleSession(ctx);
            await navigateTo(ctx, "/dashboard/plugins/new");
            await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"e.g. Sales call prep\"]'))", {
              timeoutMs: 30_000,
              label: "protected plugin creation action",
            });
            await ctx.fill('input[placeholder="e.g. Sales call prep"]', REAUTH_PLUGIN_NAME);
            await clickExact(ctx, "Skill", "button");
            await ctx.fill('input[placeholder="Name (e.g. Prep a sales call)"]', "Confirm workspace identity");
            await ctx.fill('textarea[placeholder="Write the instructions the agent should follow, in plain markdown..."]', "Confirm the current workspace identity before continuing.");
            await clickExact(ctx, "Create plugin", "button");
            await ctx.waitFor("Boolean(document.querySelector('[role=\"dialog\"][data-reauth-nonce]'))", {
              timeoutMs: 30_000,
              label: "security dialog",
            });
            await ctx.screenshot("fresh-signin-security-dialog", {
              claim: "The protected action opens a calm, contextual fresh-sign-in dialog.",
              voiceover: vo[6],
              requireText: ["For security, confirm it's you before changing workspace settings.", "SIGNING IN AS", "Verify password"],
              rejectText: ["Redirecting to your dashboard"],
              hashIncludes: "/dashboard/plugins/new",
            });
            await ctx.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
            await clickExact(ctx, "Verify password", "button");
            await ctx.waitFor(`(() => {
              return !document.querySelector('[role="dialog"]')
                && location.pathname.startsWith('/dashboard/plugins/')
                && !location.pathname.endsWith('/new')
                && document.body.innerText.includes(${JSON.stringify(REAUTH_PLUGIN_NAME)});
            })()`, { timeoutMs: 45_000, label: "queued action automatic retry" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              dialog: Boolean(document.querySelector('[role="dialog"]')),
              path: location.pathname,
              plugin: document.body.innerText.includes(${JSON.stringify(REAUTH_PLUGIN_NAME)}),
              rawAccessText: document.body.innerText.includes('Checking workspace access...') || document.body.innerText.includes('Redirecting to your dashboard...'),
            }))()`);
            witness(ctx, !actual.dialog && actual.plugin && actual.path.startsWith("/dashboard/plugins/") && !actual.path.endsWith("/new"), "Verification closes the dialog and completes the original plugin creation", actual);
            witness(ctx, !actual.rawAccessText, "Bare permission transition copy is never shown", actual);
          },
          screenshot: {
            name: "protected-action-completed",
            requireText: [REAUTH_PLUGIN_NAME, "SKILLS", "Confirm workspace identity"],
            rejectText: ["Checking workspace access", "Redirecting to your dashboard", "Something went wrong"],
            hashIncludes: "/dashboard/plugins/",
          },
        });
      },
    },
    {
      name: "Truthful Stripe dashboard",
      run: async (ctx) => {
        await ctx.prove("Stripe presents one truthful billing state with clear prices, counts, and actions", {
          voiceover: vo[7],
          action: async () => {
            await navigateTo(ctx, "/dashboard/billing");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"stripe-billing-screen\"]'))", {
              timeoutMs: 45_000,
              label: "Stripe billing screen",
            });
            await ctx.waitFor("!document.body.innerText.includes('Loading Stripe')", { timeoutMs: 45_000, label: "resolved Stripe state" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              path: location.pathname,
              stripeScreen: Boolean(document.querySelector('[data-testid="stripe-billing-screen"]')),
              refreshActions: [...document.querySelectorAll('button')].filter((entry) => entry.textContent?.trim() === 'Refresh').length,
              hasSeatCounts: ['Included users', 'Active users', 'Billable users'].every((label) => document.body.innerText.includes(label)),
              hasModels: document.body.innerText.includes('OpenWork Models'),
            }))()`);
            witness(ctx, actual.path === "/dashboard/billing" && actual.stripeScreen, "The Settings destination visibly presents Stripe", actual);
            witness(ctx, actual.refreshActions === 1 && actual.hasSeatCounts && actual.hasModels, "Stripe has one refresh action and clear seat/model state", actual);
          },
          screenshot: {
            name: "stripe-billing-dashboard",
            requireText: ["Stripe", "Included users", "Active users", "Billable users", "OpenWork Models", "Refresh"],
            rejectText: ["Billing response was incomplete", "Something went wrong"],
            hashIncludes: "/dashboard/billing",
          },
        });
      },
    },
  ],
};
