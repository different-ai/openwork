import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("connections-beta");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = Date.now();
const CONNECTION_NAME = `beta-proof-${RUN_TAG}`;
const CONNECTION_URL = "https://beta-proof.example.com/mcp";
const NAV_TEXT = "(document.querySelector('nav')?.innerText ?? '')";

const state = {
  adminSession: null,
  connectionId: null,
};

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

async function ensureAdminSession(ctx) {
  if (state.adminSession) return state.adminSession;
  state.adminSession = await apiSignIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
  return state.adminSession;
}

async function cleanupBetaProofConnections(ctx, token) {
  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(existing.response.ok, `Connection list failed: ${existing.response.status}`);
  for (const connection of existing.body.connections ?? []) {
    if (typeof connection.name !== "string" || !connection.name.startsWith("beta-proof-")) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    ctx.assert(removed.response.ok, `Leftover cleanup failed for ${connection.name}: ${removed.response.status}`);
  }
}

async function createPerMemberConnection(ctx) {
  const token = await ensureAdminSession(ctx);
  await cleanupBetaProofConnections(ctx, token);
  const created = await denApiFetch("/v1/mcp-connections", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: CONNECTION_NAME,
      url: CONNECTION_URL,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    }),
  });
  ctx.assert(created.response.ok, `Connection create failed: ${created.response.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  state.connectionId = created.body.id ?? created.body.connection?.id;
  ctx.assert(Boolean(state.connectionId), `Connection create response did not include an id: ${JSON.stringify(created.body).slice(0, 200)}`);
}

async function goTo(ctx, path) {
  await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}${path}`)})`);
  await sleep(1_500);
}

async function uiSignIn(ctx, email, password) {
  await goTo(ctx, "/");
  if (await ctx.eval("location.pathname.startsWith('/dashboard')")) {
    await uiSignOut(ctx);
    await goTo(ctx, "/");
  }
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "auth screen" });
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
  return label.replace(/beta$/i, "").trim();
}

async function hasPageBetaBadge(ctx) {
  return ctx.eval(`(() => {
    return [...document.querySelectorAll('span')].some((span) => {
      const className = String(span.className ?? '');
      return span.textContent.trim() === 'Beta' && className.includes('rounded-full') && !span.closest('nav');
    });
  })()`);
}

export default {
  id: "connections-beta",
  title: "Connections beta treatment: visible, black, and last",
  kind: "user-facing",
  spec: "evals/voiceovers/connections-beta.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Beta is visible before you ever click", {
          voiceover: vo[0],
          action: async () => {
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
          },
          assert: async () => {
            await ctx.waitFor(`${NAV_TEXT}.includes('Dashboard')`, { timeoutMs: 15_000, label: "dashboard nav" });
            const nav = await ctx.eval(NAV_TEXT);
            ctx.assert(/Your Connections\s*Beta/i.test(nav), `Your Connections must carry Beta in the resting nav: ${nav}`);
            ctx.assert(nav.includes("Extensions"), "Extensions group must be present for the admin.");
          },
          screenshot: {
            name: "connections-beta-resting-sidebar",
            claim: "The resting admin sidebar shows Your Connections marked Beta before Alex opens anything.",
            requireText: ["Your Connections", "Dashboard"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Extensions no longer lands on the beta feature", {
          voiceover: vo[1],
          action: async () => {
            await clickNav(ctx, "Extensions");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/integrations')", { timeoutMs: 15_000, label: "sources route" });
            ctx.assert(!(await ctx.eval("location.pathname.includes('/mcp-connections')")), "Extensions must not default to the Connections route.");
            const children = await navChildLabels(ctx);
            ctx.assert(
              JSON.stringify(children.map(stripBetaLabel)) === JSON.stringify(["Sources", "Plugins", "Marketplaces", "Connections"]),
              `Extensions children are out of order: ${JSON.stringify(children)}`,
            );
            ctx.assert(/Connections\s*Beta/i.test(children[children.length - 1] ?? ""), `Connections child must be last with Beta: ${JSON.stringify(children)}`);
          },
          screenshot: {
            name: "connections-beta-extensions-default-sources",
            claim: "Clicking Extensions lands Alex on Sources while Connections remains last and badged Beta.",
            requireText: ["Sources"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The Connections page says Beta and wears black, not purple", {
          voiceover: vo[2],
          action: async () => {
            await clickNav(ctx, "Connections");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/mcp-connections')", { timeoutMs: 15_000, label: "connections route" });
            await ctx.expectText("Google Workspace", { timeoutMs: 20_000 });
            const proof = await ctx.eval(`(() => {
              const addCustom = [...document.querySelectorAll('button')].find((button) => button.textContent.trim().includes('Add Custom'));
              return {
                beta: [...document.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Beta' && String(span.className ?? '').includes('rounded-full') && !span.closest('nav')),
                purple: document.querySelector('[class*="violet"], [class*="purple"]') !== null,
                addCustomBackground: addCustom ? getComputedStyle(addCustom).backgroundColor : null,
              };
            })()`);
            ctx.assert(proof.beta, "Connections hero Beta pill was not visible.");
            ctx.assert(!proof.purple, "Connections page must not render violet or purple classes.");
            ctx.assert(proof.addCustomBackground === "rgb(15, 23, 42)", `Add Custom should be black slate, got ${proof.addCustomBackground}`);
          },
          screenshot: {
            name: "connections-beta-black-page",
            claim: "The Connections page shows a Beta hero pill, black Add Custom button, and no purple styling.",
            requireText: ["Connections", "Add Custom", "Google Workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("A per-member connection wears the black pill", {
          voiceover: vo[3],
          action: async () => {
            await createPerMemberConnection(ctx);
            await goTo(ctx, "/dashboard/mcp-connections");
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME, { timeoutMs: 20_000 });
            const pill = await ctx.eval(`(() => {
              const span = [...document.querySelectorAll('span')].find((entry) => entry.textContent.includes('Individual accounts'));
              return span ? { classes: [...span.classList], text: span.textContent.trim() } : null;
            })()`);
            ctx.assert(Boolean(pill), "Individual accounts pill was not rendered.");
            ctx.assert(pill.classes.includes("bg-gray-900"), `Individual accounts pill must be black: ${JSON.stringify(pill.classes)}`);
            ctx.assert(pill.classes.includes("text-white"), `Individual accounts pill text must be white: ${JSON.stringify(pill.classes)}`);
            ctx.assert(!pill.classes.some((className) => /violet|purple/i.test(className)), `Individual accounts pill must not be purple: ${JSON.stringify(pill.classes)}`);
          },
          screenshot: {
            name: "connections-beta-per-member-pill",
            claim: "A per-member org connection renders with the black Individual accounts pill.",
            requireText: [CONNECTION_NAME, "Individual accounts"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Your Connections is marked beta for members too", {
          voiceover: vo[4],
          action: async () => {
            await goTo(ctx, "/dashboard/your-connections");
          },
          assert: async () => {
            await ctx.waitFor("location.pathname.includes('/your-connections')", { timeoutMs: 15_000, label: "your connections route" });
            ctx.assert(await hasPageBetaBadge(ctx), "Your Connections hero Beta pill was not visible.");
            await ctx.expectText(CONNECTION_NAME, { timeoutMs: 20_000 });
            await ctx.expectText("Connect your account", { timeoutMs: 10_000 });
          },
          screenshot: {
            name: "connections-beta-your-connections",
            claim: "The member-facing Your Connections page is also Beta and asks the user to connect their own account.",
            requireText: ["Your Connections", CONNECTION_NAME, "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        if (!state.connectionId) return;
        const token = await ensureAdminSession(ctx);
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        ctx.assert(removed.response.ok, `Cleanup delete failed: ${removed.response.status}`);
      },
    },
  ],
};
