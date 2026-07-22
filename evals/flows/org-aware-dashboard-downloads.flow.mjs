/**
 * Daytona-first proof for organization-aware dashboard downloads.
 *
 * Run this against a single-org Den sandbox configured as Acme Robotics with:
 * - alex@acme.test in DEN_SINGLE_ORG_OWNER_EMAILS and DEN_BOOTSTRAP_ADMIN_EMAILS
 * - installLinks enabled by this flow through the platform-admin API
 * - a generic win-x64 installer available through OPENWORK_INSTALLER_ARTIFACTS_DIR
 *
 * Riley is created through ordinary sign-up and single-org membership
 * provisioning. No invitation or app-version endpoint participates in setup.
 */
import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "org-aware-dashboard-downloads";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "riley.downloads@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const ORGANIZATION_NAME = "Acme Robotics";

const state = {
  adminToken: null,
  memberToken: null,
  organizationId: null,
  adminDirectLink: null,
  memberDirectLink: null,
  windowsDownloadHref: null,
  firstSharedLink: null,
  secondSharedLink: null,
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

async function denApiFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  headers.set("origin", DEN_WEB_URL);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(`${DEN_API_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function markVerified(ctx, email) {
  witness(ctx, MARK_VERIFIED_CMD.length > 0, "The eval has an email-verification setup command", Boolean(MARK_VERIFIED_CMD));
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function signInApi(email, password) {
  return denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

async function ensureAccount(ctx, input) {
  let signedIn = await signInApi(input.email, input.password);
  if (!signedIn.response.ok) {
    const signUp = await denApiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: input.email, name: input.name, password: input.password }),
    });
    const accepted = signUp.response.ok || [400, 409, 422].includes(signUp.response.status);
    witness(ctx, accepted, `${input.name} account exists or was created`, { status: signUp.response.status, body: signUp.body });
    markVerified(ctx, input.email);
    signedIn = await signInApi(input.email, input.password);
  }

  witness(
    ctx,
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `${input.name} can sign in through Den API`,
    { status: signedIn.response.status, email: input.email },
  );
  return signedIn.body.token;
}

async function ensureSetup(ctx) {
  if (state.adminToken && state.memberToken && state.organizationId) return;

  state.adminToken = await ensureAccount(ctx, {
    email: ADMIN_EMAIL,
    name: "Alex Chen",
    password: ADMIN_PASSWORD,
  });

  const org = await denApiFetch("/v1/org", { headers: authHeaders(state.adminToken) });
  witness(ctx, org.response.ok, "Alex can load the Acme organization", { status: org.response.status, body: org.body });
  witness(ctx, org.body?.organization?.name === ORGANIZATION_NAME, "The eval is running against Acme Robotics", org.body?.organization);
  witness(ctx, typeof org.body?.organization?.id === "string", "Acme exposes an organization id", org.body?.organization);
  state.organizationId = org.body.organization.id;

  const capability = await denApiFetch(`/v1/admin/organizations/${state.organizationId}/capabilities`, {
    method: "PUT",
    headers: authHeaders(state.adminToken),
    body: JSON.stringify({ capabilities: { installLinks: true } }),
  });
  witness(
    ctx,
    capability.response.ok,
    "Alex is allowlisted as a platform admin and enables Acme install links",
    { status: capability.response.status, body: capability.body },
  );

  state.memberToken = await ensureAccount(ctx, {
    email: MEMBER_EMAIL,
    name: "Riley Downloads",
    password: MEMBER_PASSWORD,
  });
  const memberOrgs = await denApiFetch("/v1/me/orgs", { headers: authHeaders(state.memberToken) });
  const acmeMembership = Array.isArray(memberOrgs.body?.orgs)
    && memberOrgs.body.orgs.some((entry) => entry?.id === state.organizationId);
  witness(
    ctx,
    memberOrgs.response.ok && acmeMembership,
    "Riley is provisioned into Acme without an invitation flow",
    { status: memberOrgs.response.status, orgs: memberOrgs.body?.orgs },
  );

  ctx.output("org-aware-download-setup", JSON.stringify({
    organizationId: state.organizationId,
    organizationName: ORGANIZATION_NAME,
    adminEmail: ADMIN_EMAIL,
    memberEmail: MEMBER_EMAIL,
    memberProvisioning: "single-org sign-up; no invitation endpoint",
  }, null, 2));
}

async function navigateTo(ctx, url) {
  await ctx.eval(`location.assign(${JSON.stringify(url)}); true`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${url}` });
}

async function clearBrowserSession(ctx) {
  await navigateTo(ctx, DEN_WEB_URL);
  await ctx.eval("(() => { localStorage.clear(); sessionStorage.clear(); return true; })()");
  await ctx.client.send("Network.clearBrowserCookies");
  await navigateTo(ctx, DEN_WEB_URL);
}

async function uiSignIn(ctx, email, password) {
  await clearBrowserSession(ctx);
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "Den sign-in screen" });
  await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('button, a')].find((element) => element.textContent?.trim() === 'Sign in');
    tab?.click();
    return true;
  })()`);
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", {
    timeoutMs: 15_000,
    label: "email input",
  });
  const submitted = await ctx.eval(`(() => {
    const setValue = (element, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
      descriptor?.set?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const emailInput = document.querySelector('input[type="email"], input[name="email"]');
    const passwordInput = document.querySelector('input[type="password"]');
    if (!emailInput || !passwordInput) return false;
    setValue(emailInput, ${JSON.stringify(email)});
    setValue(passwordInput, ${JSON.stringify(password)});
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === 'Sign in' && !button.disabled);
    buttons.at(-1)?.click();
    return buttons.length > 0;
  })()`);
  witness(ctx, submitted === true, `The sign-in form was submitted for ${email}`, submitted);
  try {
    await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 8_000, label: "dashboard after sign-in" });
  } catch {
    // Daytona's proxied Next.js page can retain its pre-sign-in hydration
    // state even after Better Auth has set the session cookie. A real hard
    // refresh immediately resolves the authenticated route, so keep that
    // infrastructure repair explicit in the proof instead of hiding it.
    ctx.output("daytona-signin-hydration-reload", `Refreshing the signed-in ${email} session without cached page data.`);
    await ctx.client.send("Page.reload", { ignoreCache: true });
    await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 30_000, label: "dashboard after sign-in reload" });
  }
  await ctx.waitFor("Boolean(document.querySelector('nav'))", { timeoutMs: 30_000, label: "dashboard navigation" });
  await sleep(600);
}

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label });
}

function tokenFromInstallLink(link) {
  return new URL(link).searchParams.get("token") ?? "";
}

async function fetchInstallConfig(ctx, link) {
  const token = tokenFromInstallLink(link);
  witness(ctx, token.length >= 8, "The install page URL carries an opaque token", link);
  const result = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(token)}`);
  witness(ctx, result.response.ok, "The install token still resolves", { status: result.response.status, body: result.body });
  return result.body;
}

async function stubInstallClipboard(ctx) {
  await ctx.eval(`(() => {
    window.__capturedInstallLinks = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedInstallLinks.push(String(value));
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Every Acme member gets the configured desktop installer without invalidating earlier links",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The admin dashboard offers Acme's configured installer instead of public release assets", {
          voiceover: vo[0],
          action: async () => {
            await ensureSetup(ctx);
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await navigateTo(ctx, `${DEN_WEB_URL}/dashboard`);
            await ctx.waitForText(`Download OpenWork for ${ORGANIZATION_NAME}`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(`Download OpenWork for ${ORGANIZATION_NAME}`);
            await ctx.expectText("Download for this workspace");
            const evidence = await ctx.eval(`(() => {
              const card = document.querySelector('[data-testid="organization-download-card"]');
              return {
                cardExists: Boolean(card),
                githubLinks: [...(card?.querySelectorAll('a') ?? [])].map((link) => link.href).filter((href) => href.includes('github.com')),
                githubRequests: performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => url.includes('api.github.com/repos/different-ai/openwork/releases')),
              };
            })()`);
            witness(ctx, evidence.cardExists === true, "The organization download card is visible", evidence);
            witness(ctx, evidence.githubLinks.length === 0, "The card contains no public GitHub download links", evidence);
            witness(ctx, evidence.githubRequests.length === 0, "The dashboard made no GitHub Releases API request", evidence);
          },
          screenshot: {
            name: "admin-acme-download-card",
            requireText: [`Download OpenWork for ${ORGANIZATION_NAME}`, "Download for this workspace"],
            rejectText: ["Apple Silicon (M1+)", "ARM64 Installer"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Alex reaches an Acme install page that clearly requires sign-in", {
          voiceover: vo[1],
          action: async () => {
            await clickSelector(ctx, '[data-testid="organization-download-button"]', "admin workspace download button");
            state.adminDirectLink = await ctx.waitFor(
              "location.pathname === '/install' && new URL(location.href).searchParams.has('token') && location.href",
              { timeoutMs: 30_000, label: "Acme install page" },
            );
            await ctx.waitForText(`Download OpenWork for ${ORGANIZATION_NAME}`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const config = await fetchInstallConfig(ctx, state.adminDirectLink);
            witness(ctx, config?.clientName === ORGANIZATION_NAME, "The install link resolves to Acme Robotics", config);
            witness(ctx, config?.requireSignin === true, "The Acme installer requires normal sign-in", config);
            await ctx.expectText("Run it, then sign in");
          },
          screenshot: {
            name: "admin-acme-install-page",
            requireText: [`Download OpenWork for ${ORGANIZATION_NAME}`, "Run it, then sign in", "Download for"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("An ordinary member sees the download action without admin distribution controls", {
          voiceover: vo[2],
          action: async () => {
            await uiSignIn(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
            await navigateTo(ctx, `${DEN_WEB_URL}/dashboard`);
            await ctx.waitForText("WORKSPACE MEMBER", { timeoutMs: 30_000 });
            await ctx.waitForText("Download for this workspace", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(`Download OpenWork for ${ORGANIZATION_NAME}`);
            await ctx.expectText("WORKSPACE MEMBER");
            await ctx.expectNoText("Copy install link");
            const rotate = await denApiFetch(`/v1/orgs/${state.organizationId}/install-links`, {
              method: "POST",
              headers: authHeaders(state.memberToken),
              body: JSON.stringify({ rotate: true }),
            });
            witness(ctx, rotate.response.status === 403, "Riley cannot rotate team install links", { status: rotate.response.status, body: rotate.body });
          },
          screenshot: {
            name: "member-acme-download-card",
            requireText: ["WORKSPACE MEMBER", `Download OpenWork for ${ORGANIZATION_NAME}`, "Download for this workspace"],
            rejectText: ["Copy install link", "Pending invites"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Riley receives the configured Windows installer from Acme's OpenWork server", {
          voiceover: vo[3],
          action: async () => {
            await ctx.client.send("Emulation.setUserAgentOverride", {
              userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              platform: "Win32",
            });
            await ctx.eval("location.reload(); true");
            await ctx.waitForText("Download for this workspace", { timeoutMs: 30_000 });
            await clickSelector(ctx, '[data-testid="organization-download-button"]', "member workspace download button");
            state.memberDirectLink = await ctx.waitFor(
              "location.pathname === '/install' && new URL(location.href).searchParams.has('token') && location.href",
              { timeoutMs: 30_000, label: "member Acme install page" },
            );
            await ctx.waitForText("Download for Windows", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const memberConfig = await fetchInstallConfig(ctx, state.memberDirectLink);
            witness(ctx, memberConfig?.clientName === ORGANIZATION_NAME, "Riley's installer is configured for Acme", memberConfig);
            state.windowsDownloadHref = await ctx.eval("document.querySelector('[data-testid=\"install-download-primary\"]')?.href ?? ''");
            const downloadUrl = new URL(state.windowsDownloadHref);
            witness(ctx, downloadUrl.origin === new URL(DEN_API_URL).origin, "The Windows download comes from Acme's Den API", state.windowsDownloadHref);
            witness(ctx, downloadUrl.pathname === "/v1/install/win-x64", "The recommended download is the configured Windows installer", state.windowsDownloadHref);
            witness(ctx, !state.windowsDownloadHref.includes("github.com"), "The member download does not point at GitHub", state.windowsDownloadHref);

            const response = await fetch(state.windowsDownloadHref);
            const bytes = await response.arrayBuffer();
            const disposition = response.headers.get("content-disposition") ?? "";
            witness(ctx, response.ok, "Acme's server returns the Windows installer", { status: response.status, disposition, byteLength: bytes.byteLength });
            witness(ctx, disposition.includes("OpenWork-Installer--"), "The Windows filename carries Acme's bootstrap tag", disposition);
            witness(ctx, bytes.byteLength > 0, "The Windows installer response is non-empty", bytes.byteLength);
          },
          screenshot: {
            name: "member-acme-windows-installer",
            requireText: [`Download OpenWork for ${ORGANIZATION_NAME}`, "Download for Windows", "Run it, then sign in"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Copying a new team link leaves the original distributed link valid", {
          voiceover: vo[4],
          action: async () => {
            await ctx.client.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => undefined);
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await navigateTo(ctx, `${DEN_WEB_URL}/dashboard/members`);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"copy-install-link\"]'))", {
              timeoutMs: 30_000,
              label: "copy install link button",
            });
            await stubInstallClipboard(ctx);
            await clickSelector(ctx, '[data-testid="copy-install-link"]', "first copy install link");
            state.firstSharedLink = await ctx.waitFor(
              "window.__capturedInstallLinks?.length === 1 && window.__capturedInstallLinks[0]",
              { timeoutMs: 20_000, label: "first copied install link" },
            );
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"copy-install-link\"]')?.textContent?.trim() === 'Copy install link'",
              { timeoutMs: 6_000, label: "copy button reset" },
            );
            await clickSelector(ctx, '[data-testid="copy-install-link"]', "second copy install link");
            state.secondSharedLink = await ctx.waitFor(
              "window.__capturedInstallLinks?.length === 2 && window.__capturedInstallLinks[1]",
              { timeoutMs: 20_000, label: "second copied install link" },
            );
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"copy-install-link\"]')?.textContent?.trim() === 'Copy install link'",
              { timeoutMs: 6_000, label: "copy button reset after second link" },
            );
          },
          assert: async () => {
            witness(ctx, state.firstSharedLink !== state.secondSharedLink, "Each copy receives an independent opaque link", {
              first: state.firstSharedLink,
              second: state.secondSharedLink,
            });
            const firstConfig = await fetchInstallConfig(ctx, state.firstSharedLink);
            const secondConfig = await fetchInstallConfig(ctx, state.secondSharedLink);
            witness(ctx, firstConfig?.clientName === ORGANIZATION_NAME, "The original link remains an Acme link", firstConfig);
            witness(ctx, secondConfig?.clientName === ORGANIZATION_NAME, "The later link is also an Acme link", secondConfig);
            await ctx.expectText("Copy install link");
          },
          screenshot: {
            name: "admin-stable-team-install-links",
            requireText: ["Members", "Copy install link"],
            rejectText: ["Could not create install link"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Possessing the installer config does not grant Acme workspace access", {
          voiceover: vo[5],
          action: async () => {
            await ctx.eval("(() => { localStorage.clear(); sessionStorage.clear(); return true; })()");
            await ctx.client.send("Network.clearBrowserCookies");
            await navigateTo(ctx, state.firstSharedLink);
            await ctx.waitForText(`Download OpenWork for ${ORGANIZATION_NAME}`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const config = await fetchInstallConfig(ctx, state.firstSharedLink);
            witness(ctx, config?.requireSignin === true, "The distributed installer still requires sign-in", config);
            const anonymousOrg = await denApiFetch("/v1/org");
            witness(ctx, anonymousOrg.response.status === 401, "The install token grants no anonymous workspace session", {
              status: anonymousOrg.response.status,
              body: anonymousOrg.body,
            });
            await ctx.expectText("Run it, then sign in");
            const hasDashboardNavigation = await ctx.eval("Boolean(document.querySelector('nav'))");
            witness(ctx, hasDashboardNavigation === false, "The public install page exposes no authenticated dashboard", hasDashboardNavigation);
          },
          screenshot: {
            name: "installer-still-requires-signin",
            requireText: [`Download OpenWork for ${ORGANIZATION_NAME}`, "Run it, then sign in"],
            rejectText: ["Members", "Settings", "Sign out"],
          },
        });
      },
    },
  ],
};
