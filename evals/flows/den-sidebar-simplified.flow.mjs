/**
 * Den sidebar simplified (spec: evals/voiceovers/den-sidebar-simplified.md):
 * sixteen flat rows become seven top-level entries with grouped children.
 *
 * Drives den-web through a Chrome CDP target (like the llm-provider flows):
 * point --cdp-url at a Chrome whose single tab is OPENWORK_EVAL_DEN_WEB_URL.
 * Setup (member invite) goes through the Den API; every visible claim is
 * asserted in the real UI as Alex (admin) and Jordan (member).
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("den-sidebar-simplified");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";

const TOP_LEVEL = ["Dashboard", "Your Connections", "Extensions", "Models", "Members", "Analytics", "Settings"];
const RETIRED_TOP_LEVEL = ["MCP Connections", "Integrations", "OpenWork Models", "LLM Providers", "Desktop Policies", "API Keys", "SCIM", "SSO", "Billing", "Org Settings"];
const NAV_TEXT = "(document.querySelector('nav')?.innerText ?? '')";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function denApiFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
    headers: { "content-type": "application/json", origin: DEN_WEB_URL, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

async function apiSignIn(email, password) {
  const { response, body } = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return response.ok ? body.token : null;
}

async function ensureJordanInAcme(ctx) {
  let member = await apiSignIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  if (!member) {
    const signUp = await denApiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
    });
    ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status}`);
    member = await apiSignIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  }
  ctx.assert(Boolean(member), "Member sign-in failed.");

  const orgs = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${member}` } });
  if ((orgs.body.orgs ?? []).some((org) => org.slug === "acme-robotics-demo")) return;

  const admin = await apiSignIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(admin), "Admin sign-in failed for member setup.");
  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${admin}` },
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status}`);
  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${member}` },
    body: JSON.stringify({ id: invite.body.inviteToken }),
  });
  ctx.assert(accept.response.ok && accept.body.accepted, `Invitation accept failed: ${JSON.stringify(accept.body)}`);
}

async function goTo(ctx, path) {
  await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}${path}`)})`);
  await sleep(1_500);
}

async function uiSignIn(ctx, email, password) {
  await goTo(ctx, "/");
  // Idempotency: a previous run (or frame) may have left someone signed in,
  // in which case "/" redirects straight to the dashboard.
  if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
    await uiSignOut(ctx);
    await goTo(ctx, "/");
  }
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "auth screen" });
  // Ensure the sign-in mode is selected (the screen defaults to sign-up).
  await ctx.eval(`(() => {
    const tab = [...document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Sign in');
    tab?.click();
    return true;
  })()`);
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  const filled = await ctx.eval(`(() => {
    const setNative = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"], input[name="email"]');
    const password = document.querySelector('input[type="password"]');
    if (!email || !password) return false;
    setNative(email, ${JSON.stringify(email)});
    setNative(password, ${JSON.stringify(password)});
    const buttons = [...document.querySelectorAll('button')].filter((el) => el.textContent.trim() === 'Sign in' && !el.disabled);
    buttons[buttons.length - 1]?.click();
    return buttons.length > 0;
  })()`);
  ctx.assert(filled, "Could not fill and submit the sign-in form.");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
  await ctx.waitFor("Boolean(document.querySelector('nav'))", { timeoutMs: 30_000, label: "sidebar rendered" });
  await sleep(1_000);
}

async function uiSignOut(ctx) {
  // Single-org shells render direct sign-out; multi-org shells keep it in the org switcher.
  const clickedDirect = await ctx.eval(`(() => {
    const button = document.querySelector('button[aria-label="Sign out"]');
    button?.click();
    return Boolean(button);
  })()`);
  if (!clickedDirect) {
    const opened = await ctx.eval(`(() => {
      const trigger = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Acme Robotics') || el.textContent.includes('Owner') || el.textContent.includes('Member'));
      trigger?.click();
      return Boolean(trigger);
    })()`);
    ctx.assert(opened, "Could not open the org switcher.");
    await ctx.waitFor("[...document.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Sign out')", { timeoutMs: 10_000, label: "sign out option" });
    await ctx.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Sign out');
      btn?.click();
      return true;
    })()`);
  }
  await ctx.waitFor("!location.pathname.startsWith('/dashboard') || document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "signed out" });
  await sleep(1_000);
}

async function clickNav(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const link = [...document.querySelectorAll('nav a')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}));
    link?.click();
    return Boolean(link);
  })()`);
  ctx.assert(clicked, `Sidebar entry not found: ${label}`);
  await sleep(1_500);
}

async function navChildLabels(ctx) {
  return ctx.eval(`(() => {
    const groups = [...document.querySelectorAll('nav .border-l')];
    const active = groups[0];
    return active ? [...active.querySelectorAll('a')].map((el) => el.textContent.trim()) : [];
  })()`);
}

function stripBetaLabel(label) {
  return label.replace(/alpha$/i, "").trim();
}

export default {
  id: "den-sidebar-simplified",
  title: "Den sidebar: sixteen rows become seven — tools, models, people, settings",
  kind: "user-facing",
  spec: "evals/voiceovers/den-sidebar-simplified.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The admin sidebar is seven top-level entries with only Your Connections marked Alpha", {
          voiceover: vo[0],
          action: async () => {
            await ensureJordanInAcme(ctx);
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
          },
          assert: async () => {
            for (const label of TOP_LEVEL) {
              await ctx.waitFor(`${NAV_TEXT}.includes(${JSON.stringify(label)})`, { timeoutMs: 15_000, label: `nav has ${label}` });
            }
            const nav = await ctx.eval(NAV_TEXT);
            for (const retired of RETIRED_TOP_LEVEL) {
              ctx.assert(!nav.includes(retired), `Retired top-level label still in the resting sidebar: ${retired}`);
            }
            ctx.assert(!/\bnew\b/i.test(nav), "The sidebar must not show New badges anymore.");
            ctx.assert(/Your Connections\s*Alpha/i.test(nav), "Your Connections keeps the visible Alpha badge.");
            const betaMatches = nav.match(/\balpha\b/gi) ?? [];
            ctx.assert(betaMatches.length === 1, `Only Your Connections should be badged Alpha at rest, saw ${betaMatches.length}: ${nav}`);
          },
          screenshot: {
            name: "sidebar-seven",
            claim: "The admin sidebar shows seven top-level entries, no New badges, and the remaining Alpha badge on Your Connections.",
            requireText: ["Dashboard", "Your Connections", "Extensions", "Models", "Members", "Analytics", "Settings"],
            rejectText: ["MCP Connections", "SCIM"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Extensions opens on Sources — where plugins come from", {
          voiceover: vo[1],
          action: async () => {
            await clickNav(ctx, "Extensions");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/integrations')", { timeoutMs: 15_000, label: "sources route (old integrations URL)" });
            ctx.assert(!(await ctx.eval("location.pathname.includes('/mcp-connections')")), "Extensions must not land on the alpha Connections route.");
            await ctx.expectText("Sources", { timeoutMs: 15_000 });
            await ctx.expectText("GitHub", { timeoutMs: 15_000 });
          },
          screenshot: {
            name: "extensions-sources-default",
            claim: "Extensions lands on Sources, not the alpha Connections page.",
            requireText: ["Extensions", "Sources", "GitHub"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Connections is last in Extensions, wearing an Alpha badge", {
          voiceover: vo[2],
          action: async () => {
            const children = await navChildLabels(ctx);
            const stripped = children.map(stripBetaLabel);
            ctx.assert(
              JSON.stringify(stripped) === JSON.stringify(["Sources", "Plugins", "Marketplaces", "Connections"]),
              `Extensions children must read in pipeline order, got ${JSON.stringify(children)}`,
            );
            ctx.assert(/Connections\s*Alpha/i.test(children[children.length - 1] ?? ""), `Connections child must carry the Alpha badge, got ${JSON.stringify(children)}`);
            await clickNav(ctx, "Connections");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/mcp-connections')", { timeoutMs: 15_000, label: "connections route" });
            await ctx.expectText("Google Workspace", { timeoutMs: 20_000 });
            await ctx.expectText("Notion", { timeoutMs: 10_000 });
          },
          screenshot: {
            name: "extensions-connections-beta-last",
            claim: "Connections is reachable only after choosing the last Alpha child in Extensions.",
            requireText: ["Connections", "Google Workspace", "Notion"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Models holds OpenWork Models and LLM Providers side by side", {
          voiceover: vo[3],
          action: async () => {
            await clickNav(ctx, "Models");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/inference')", { timeoutMs: 15_000, label: "models route" });
            const children = await navChildLabels(ctx);
            ctx.assert(children.some((label) => label.startsWith("OpenWork Models")), `Models children missing OpenWork Models: ${JSON.stringify(children)}`);
            ctx.assert(children.some((label) => label.startsWith("LLM Providers")), `Models children missing LLM Providers: ${JSON.stringify(children)}`);
          },
          screenshot: {
            name: "models-group",
            claim: "The Models group shows OpenWork Models and LLM Providers as siblings.",
            requireText: ["Models", "OpenWork Models", "LLM Providers"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Set-once governance lives under Settings", {
          voiceover: vo[4],
          action: async () => {
            await clickNav(ctx, "Settings");
          },
          assert: async () => {
            const children = await navChildLabels(ctx);
            for (const label of ["General", "Desktop Policies", "Billing", "API Keys", "SSO", "SCIM"]) {
              ctx.assert(children.includes(label), `Settings children missing ${label}: ${JSON.stringify(children)}`);
            }
          },
          screenshot: {
            name: "settings-group",
            claim: "Settings groups General, Desktop Policies, Billing, API Keys, SSO, and SCIM.",
            requireText: ["Settings", "Desktop Policies", "Billing", "API Keys", "SSO", "SCIM"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("A member sidebar is just Dashboard and Your Connections", {
          voiceover: vo[5],
          action: async () => {
            await uiSignOut(ctx);
            await uiSignIn(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
          },
          assert: async () => {
            await ctx.waitFor(`${NAV_TEXT}.includes('Your Connections')`, { timeoutMs: 20_000, label: "member nav" });
            const nav = await ctx.eval(NAV_TEXT);
            for (const adminLabel of ["Extensions", "Models", "Members", "Analytics", "Settings"]) {
              ctx.assert(!nav.includes(adminLabel), `Member sidebar leaked admin entry: ${adminLabel}`);
            }
          },
          screenshot: {
            name: "member-sidebar",
            claim: "The member sidebar has only Dashboard and Your Connections.",
            requireText: ["Dashboard", "Your Connections"],
            rejectText: ["Extensions", "Settings", "Members"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("The old MCP Connections bookmark still lands inside Extensions", {
          voiceover: vo[6],
          action: async () => {
            await uiSignOut(ctx);
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            // The bookmark saved before the rename: the raw pre-rename URL.
            await goTo(ctx, "/dashboard/mcp-connections");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/mcp-connections')", { timeoutMs: 15_000, label: "old URL renders" });
            await ctx.expectText("Google Workspace", { timeoutMs: 20_000 });
            const children = await navChildLabels(ctx);
            ctx.assert(children.map(stripBetaLabel).includes("Connections"), "The old URL must highlight the Extensions group with Connections active.");
          },
          screenshot: {
            name: "old-bookmark",
            claim: "The pre-rename URL still renders the Connections page inside the Extensions group.",
            requireText: ["Connections", "Google Workspace"],
            rejectText: ["Something went wrong", "404"],
          },
        });
      },
    },
  ],
};
