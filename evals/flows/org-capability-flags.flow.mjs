import { execSync } from "node:child_process";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-capability-flags.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-capability-flags");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
// alex is the ORG admin: his /v1/org payload is the proof that an org can read
// its own capabilities. He takes part through his API session only — the whole
// visible demo happens in the platform admin's browser.
const ORG_ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ORG_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const ORG_FILTER_INPUT = 'input[placeholder="Org name, slug, or id"]';

const state = {
  platformAdminToken: null,
  orgAdminToken: null,
  orgId: null,
  orgSlug: null,
  otherOrgsOnBeforeToggle: null,
};

export default {
  id: "org-capability-flags",
  title: "Install links are default-on for every org, with a reversible /admin kill switch",
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
          await ctx.prove("Install links are on for every organization by default, no enablement needed", {
            voiceover: vo[0],
            action: async () => {
              await ensurePlatformAdmin(ctx);
              await ensureOrgAdminContext(ctx);
              // Idempotency affordance: a previous run may have left an explicit
              // override. Clear it through the admin API before asserting the
              // default-on state — the demo itself then toggles the kill switch
              // through the UI.
              await setCapabilityViaAdminApi(ctx, { installLinks: null });
              await signInToDenWebWithoutOrg(ctx, PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/admin");
              await ctx.waitForText("User backoffice", { timeoutMs: 45_000 });
              await clickOrganizationsTab(ctx);
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"admin-orgs-page\"]'))", {
                timeoutMs: 20_000,
                label: "admin organizations view",
              });
              await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(acmeRowSelector())}))`, {
                timeoutMs: 20_000,
                label: "Acme organization row",
              });
              await scrollAcmeRowIntoView(ctx);
            },
            assert: async () => {
              await ctx.expectText("Acme Robotics");
              // The section header renders uppercase via CSS, so innerText
              // sees "CAPABILITIES"; assert on the untransformed label.
              await ctx.expectText("Install links");
              const checked = await readAcmeInstallLinksCheckbox(ctx);
              ctx.assert(checked === true, "Install links checkbox was not checked with no stored override.");

              const admin = await fetchAdminCapabilities(ctx);
              ctx.assert(admin.installLinks === true, "Admin API did not report installLinks on by default.");

              const orgView = await fetchOrgCapabilities(ctx);
              ctx.assert(orgView.installLinks === true, "/v1/org did not report installLinks on by default.");
              ctx.output("capabilities-default-on", JSON.stringify({ admin, orgView }, null, 2));
            },
            screenshot: {
              name: "admin-acme-capabilities-default-on",
              requireText: ["User backoffice", "Acme Robotics", "Install links"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("One checkbox in /admin turns install links off for Acme, and only Acme", {
            voiceover: vo[1],
            action: async () => {
              // Filter to Acme first — a real admin narrowing to one org, and it
              // keeps this capture visually distinct from frame 1's full list.
              await ctx.fill(ORG_FILTER_INPUT, "Acme");
              await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(acmeRowSelector())}))`, {
                timeoutMs: 20_000,
                label: "Acme row after filtering",
              });
              state.otherOrgsOnBeforeToggle = await fetchOtherOrgsWithCapabilityOn(ctx);
              await clickAcmeInstallLinksCheckbox(ctx);
              await ctx.waitFor(`(() => {
                const checkbox = document.querySelector(${JSON.stringify(acmeInstallLinksCheckboxSelector())});
                return Boolean(checkbox && !checkbox.checked && !checkbox.disabled);
              })()`, { timeoutMs: 20_000, label: "capability checkbox saved as unchecked" });
            },
            assert: async () => {
              const checked = await readAcmeInstallLinksCheckbox(ctx);
              ctx.assert(checked === false, "Capability checkbox did not stay unchecked.");

              const admin = await fetchAdminCapabilities(ctx);
              ctx.assert(admin.installLinks === false, "Admin API did not report the capability off after the kill switch.");

              // "Just Acme": the toggle must not have changed any other org.
              const before = state.otherOrgsOnBeforeToggle;
              ctx.assert(Array.isArray(before), "Frame 2 did not snapshot the other orgs before the toggle.");
              const after = await fetchOtherOrgsWithCapabilityOn(ctx);
              ctx.assert(
                JSON.stringify(after) === JSON.stringify(before),
                `Other orgs changed with Acme's toggle: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
              );
              ctx.output("kill-switch-disabled-acme-only", JSON.stringify({ admin, otherOrgsWithCapabilityOn: after }, null, 2));
            },
            screenshot: {
              name: "admin-acme-capabilities-kill-switch-off",
              requireText: ["Acme Robotics", "Install links"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Acme's own workspace reads the kill-switched state through /v1/org", {
            voiceover: vo[2],
            action: async () => {
              // Clear the filter — back to the full backoffice list, now with
              // Acme's row unchecked (and a visibly different capture from frame 2).
              await ctx.fill(ORG_FILTER_INPUT, "");
              await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(acmeRowSelector())}))`, {
                timeoutMs: 20_000,
                label: "Acme row after clearing the filter",
              });
              await scrollAcmeRowIntoView(ctx);
            },
            assert: async () => {
              // The payload Acme's own admin reads — fetched with alex's session.
              const orgView = await fetchOrgCapabilities(ctx);
              ctx.assert(orgView.installLinks === false, "/v1/org did not report the kill-switched state to Acme's own admin.");
              ctx.output("acme-org-payload-kill-switched", JSON.stringify({ orgAdmin: ORG_ADMIN_EMAIL, capabilities: orgView }, null, 2));

              const checked = await readAcmeInstallLinksCheckbox(ctx);
              ctx.assert(checked === false, "Admin row stopped showing the kill switch off state.");
              await ctx.expectText("Acme Robotics");
            },
            screenshot: {
              name: "acme-reports-install-links-dark",
              requireText: ["Acme Robotics", "Install links"],
            },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Re-checking the box restores install links for Acme", {
            voiceover: vo[3],
            action: async () => {
              await ctx.fill(ORG_FILTER_INPUT, "Acme");
              await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(acmeRowSelector())}))`, {
                timeoutMs: 20_000,
                label: "Acme row after filtering again",
              });
              await clickAcmeInstallLinksCheckbox(ctx);
              await ctx.waitFor(`(() => {
                const checkbox = document.querySelector(${JSON.stringify(acmeInstallLinksCheckboxSelector())});
                return Boolean(checkbox && checkbox.checked && !checkbox.disabled);
              })()`, { timeoutMs: 20_000, label: "capability checkbox saved as checked" });
            },
            assert: async () => {
              const admin = await fetchAdminCapabilities(ctx);
              ctx.assert(admin.installLinks === true, "Admin API did not report the capability on after restoring it.");

              const orgView = await fetchOrgCapabilities(ctx);
              ctx.assert(orgView.installLinks === true, "/v1/org did not report the capability on after restoring it.");
              ctx.output("acme-org-payload-restored", JSON.stringify({ orgAdmin: ORG_ADMIN_EMAIL, capabilities: orgView }, null, 2));

              await ctx.expectText("Install links");
            },
            screenshot: {
              name: "admin-acme-capabilities-restored",
              requireText: ["Acme Robotics", "Install links"],
            },
          });
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
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
    // Close the extra websocket so the runner process can exit cleanly.
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

/**
 * The platform admin is an ordinary account whose email is on the Den admin
 * allowlist. The account is created here (idempotently); allowlist membership
 * comes from DEN_BOOTSTRAP_ADMIN_EMAILS on the den-api under test, which
 * upserts the email into admin_allowlist on boot.
 */
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
  if (state.orgAdminToken && state.orgId) {
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

  const org = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${state.orgAdminToken}` },
  });
  ctx.assert(org.response.ok, `Could not load ${ORG_ADMIN_EMAIL}'s organization: ${org.response.status} ${org.text.slice(0, 300)}`);
  const organization = org.body?.organization;
  ctx.assert(typeof organization?.id === "string" && typeof organization?.slug === "string", "Organization payload was missing id/slug.");
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
  const result = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `/v1/org fetch failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(isRecord(result.body?.capabilities), "/v1/org response was missing capabilities.");
  return result.body.capabilities;
}

/**
 * Slugs of every organization other than Acme whose effective installLinks
 * state is on, read from the admin overview rows (which expose capabilities).
 * Used to prove Acme's toggle changed Acme and nothing else.
 */
async function fetchOtherOrgsWithCapabilityOn(ctx) {
  const token = requireStateValue(state.platformAdminToken, "platform admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const result = await denApiFetch("/v1/admin/overview", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(result.response.ok, `Admin overview fetch failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  const organizations = result.body?.organizations;
  ctx.assert(Array.isArray(organizations), "Admin overview response was missing organizations.");
  return organizations
    .filter((org) => isRecord(org) && org.id !== orgId && isRecord(org.capabilities) && org.capabilities.installLinks === true)
    .map((org) => org.slug)
    .sort();
}

async function goToDenWeb(ctx, pathname) {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${pathname}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

/**
 * The platform admin has no organization, so den-web never lands on
 * /dashboard after sign-in. Wait for the auth session instead, then let the
 * caller navigate straight to /admin.
 */
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`den-web session for ${email} did not appear within 45s.`);
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  // Sign out via the den-web proxy path (den-api sits behind /api/den) and
  // clear browser cookies so stale profile sessions from previous runs can
  // never leak into this one.
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
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
  return clicked;
}

async function clickLastExactText(ctx, text, selector) {
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
  return clicked;
}

async function clickOrganizationsTab(ctx) {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim().startsWith('Organizations ('));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: "organizations tab" });
}

function acmeRowSelector() {
  const slug = requireStateValue(state.orgSlug, "organization slug");
  return `[data-testid="admin-org-row-${slug}"]`;
}

function acmeInstallLinksCheckboxSelector() {
  return `${acmeRowSelector()} [data-testid="admin-capability-installLinks"]`;
}

async function scrollAcmeRowIntoView(ctx) {
  await ctx.eval(`(() => {
    document.querySelector(${JSON.stringify(acmeRowSelector())})?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

async function readAcmeInstallLinksCheckbox(ctx) {
  return ctx.eval(`(() => {
    const checkbox = document.querySelector(${JSON.stringify(acmeInstallLinksCheckboxSelector())});
    return checkbox ? checkbox.checked : null;
  })()`);
}

async function clickAcmeInstallLinksCheckbox(ctx) {
  await ctx.waitFor(`(() => {
    const checkbox = document.querySelector(${JSON.stringify(acmeInstallLinksCheckboxSelector())});
    if (!checkbox || checkbox.disabled) {
      return false;
    }
    checkbox.scrollIntoView({ block: 'center' });
    checkbox.click();
    return true;
  })()`, { timeoutMs: 20_000, label: "toggle capability checkbox" });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
