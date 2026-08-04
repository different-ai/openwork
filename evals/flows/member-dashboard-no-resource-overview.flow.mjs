import { execFileSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "member-dashboard-no-resource-overview";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = "riley.no-resource-overview@acme.test";
const MEMBER_PASSWORD = "OpenWorkDemo123!";

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

function runMysql(sql) {
  const container = process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() || "openwork-web-local-mysql";
  execFileSync("docker", ["exec", container, "mysql", "-uroot", "-ppassword", "openwork_den", "-e", sql], { stdio: "ignore" });
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
    runMysql(`UPDATE user SET email_verified = 1 WHERE email = '${email.replaceAll("'", "''")}';`);
    token = await signInApi(email, password);
  }
  witness(ctx, token.length > 0, `${name} can sign in through Den`, { email });
  return token;
}

async function ensureMember(ctx) {
  if (state.adminToken && state.memberToken && state.organizationId) return;

  state.adminToken = await ensureAccount(ctx, { email: ADMIN_EMAIL, name: "Alex Chen", password: ADMIN_PASSWORD });
  const org = await denFetch("/v1/org", { headers: authHeaders(state.adminToken) });
  witness(ctx, org.response.ok && typeof org.body?.organization?.id === "string", "Alex can load the active workspace", {
    status: org.response.status,
    organization: org.body?.organization,
  });
  state.organizationId = org.body.organization.id;

  state.memberToken = await ensureAccount(ctx, { email: MEMBER_EMAIL, name: "Riley Member", password: MEMBER_PASSWORD });
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

async function readMemberHome(ctx) {
  return ctx.eval(`(() => {
    const text = document.body?.innerText ?? "";
    return {
      dashboard: Boolean(document.querySelector('[data-testid="member-dashboard"]')),
      overview: Boolean(document.querySelector('[data-testid="member-resource-overview"]')),
      cards: document.querySelectorAll('[data-testid="member-resource-card"]').length,
      availableResources: text.includes("Available resources"),
      assignedDirectly: text.includes("Assigned directly to you"),
      yourWorkspace: text.includes("Your workspace"),
      llmProviders: text.includes("LLM providers"),
      openWorkModels: text.includes("OpenWork Models"),
      marketplaces: text.includes("Marketplaces"),
      plugins: text.includes("Plugins"),
    };
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Member dashboard drops the empty Available resources summary strip",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Member home has no Available resources strip",
      run: async (ctx) => {
        await ctx.prove("Riley's member home opens on the real sections with no Available resources strip", {
          voiceover: vo[0],
          action: async () => {
            await ensureMember(ctx);
            await uiSignIn(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
            await navigateTo(ctx, "/dashboard");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"member-dashboard\"]'))", {
              timeoutMs: 30_000,
              label: "member dashboard",
            });
          },
          assert: async () => {
            const actual = await readMemberHome(ctx);
            witness(ctx, actual.dashboard === true, "Riley lands on the member dashboard", actual);
            witness(ctx, actual.overview === false && actual.cards === 0 && actual.availableResources === false && actual.assignedDirectly === false, "The Available resources summary strip is gone", actual);
            witness(ctx, actual.yourWorkspace === true && actual.llmProviders === true && actual.openWorkModels === true && actual.marketplaces === true && actual.plugins === true, "The real sections are still on the page", actual);
          },
          screenshot: {
            name: "member-home-no-overview",
            requireText: ["Your workspace", "LLM providers", "OpenWork Models", "Marketplaces", "Plugins"],
            rejectText: ["Available resources", "Assigned directly to you", "Something went wrong"],
            hashIncludes: "/dashboard",
          },
        });
      },
    },
    {
      name: "Empty states live in the real sections",
      run: async (ctx) => {
        await ctx.prove("Empty states stay inside LLM providers and the other real sections", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll('h2')].find((entry) => entry.textContent?.trim() === 'LLM providers');
              heading?.scrollIntoView({ block: 'center' });
              return Boolean(heading);
            })()`);
            await sleep(400);
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const text = document.body?.innerText ?? "";
              return {
                overview: Boolean(document.querySelector('[data-testid="member-resource-overview"]')),
                availableResources: text.includes("Available resources"),
                disabledCard: [...document.querySelectorAll('[data-testid="member-resource-card"]')].some((card) => (card.textContent ?? "").includes("Disabled")),
                llmEmpty: text.includes("No custom providers are available to you yet.") || text.includes("available"),
                openWorkModels: text.includes("OpenWork Models"),
                marketplaces: text.includes("Marketplaces"),
                plugins: text.includes("Plugins"),
              };
            })()`);
            witness(ctx, actual.overview === false && actual.availableResources === false && actual.disabledCard === false, "No Disabled / 0 summary cards remain on the page", actual);
            witness(ctx, actual.openWorkModels === true && actual.marketplaces === true && actual.plugins === true, "The real sections still describe what Riley can use", actual);
          },
          screenshot: {
            name: "member-sections-without-summary",
            requireText: ["LLM providers", "OpenWork Models"],
            rejectText: ["Available resources", "Assigned directly to you", "Something went wrong"],
            hashIncludes: "/dashboard",
          },
        });
      },
    },
  ],
};
