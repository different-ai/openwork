/**
 * Create plugin single request (spec: evals/voiceovers/create-plugin-single-request.md):
 * creating a plugin with one skill, org-wide sharing, and marketplace publish
 * should save through a single browser POST.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("create-plugin-single-request");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const state = {
  pluginId: "",
  pluginName: "",
  saveDurationMs: 0,
  skillName: "Sales call checklist",
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

async function apiJson(ctx, path, token) {
  const result = await denApiFetch(path, { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(result.response.ok, `${path} failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
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
  // Idempotency plumbing, not a demo claim: end any leftover session through
  // the auth endpoint and drop the locally persisted auth token so the flow
  // always starts from the sign-in screen.
  await ctx.eval("fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)");
  await ctx.eval("localStorage.clear(); sessionStorage.clear(); true");
  await sleep(1_000);
  await goTo(ctx, "/");
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "signed out" });
}

async function fillPluginEditor(ctx) {
  state.pluginName = `Sales call prep ${Date.now().toString(36)}`;
  const pluginDescription = "A team plugin for preparing sales calls.";
  const skillDescription = "Use before every customer call.";
  const skillInstructions = "Review the account notes, recent objections, and next-best questions before the call.";

  await ctx.waitFor("document.body.innerText.includes('Create a plugin')", { timeoutMs: 20_000, label: "create plugin editor" });
  const filledPlugin = await ctx.eval(`(() => {
    const setNative = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const name = document.querySelector('input[placeholder="e.g. Sales call prep"]');
    const description = document.querySelector('textarea[placeholder="What does this plugin help people do?"]');
    if (!name || !description) return false;
    setNative(name, ${JSON.stringify(state.pluginName)});
    setNative(description, ${JSON.stringify(pluginDescription)});
    return true;
  })()`);
  ctx.assert(filledPlugin, "Could not fill plugin metadata.");

  const addedSkill = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Skill' && !el.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(addedSkill, "Could not add a skill component.");
  await ctx.waitFor("Boolean(document.querySelector('input[placeholder^=\"Name (e.g. Prep a sales call)\"]'))", { timeoutMs: 10_000, label: "skill fields" });

  const filledSkill = await ctx.eval(`(() => {
    const setNative = (el, value) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const name = document.querySelector('input[placeholder^="Name (e.g. Prep a sales call)"]');
    const description = document.querySelector('input[placeholder^="One-line description"]');
    const instructions = document.querySelector('textarea[placeholder^="Write the instructions"]');
    if (!name || !description || !instructions) return false;
    setNative(name, ${JSON.stringify(state.skillName)});
    setNative(description, ${JSON.stringify(skillDescription)});
    setNative(instructions, ${JSON.stringify(skillInstructions)});
    return true;
  })()`);
  ctx.assert(filledSkill, "Could not fill the skill fields.");
  // The marketplace picker is a custom listbox button (no native <select>);
  // its trigger shows the selected marketplace name once the list loads.
  await ctx.waitFor(MARKETPLACE_SELECTED_EXPR, { timeoutMs: 20_000, label: "marketplace pre-selected" });
}

// True once the Share card's listbox trigger shows a real marketplace name
// instead of the empty-state label ("Don't publish yet").
const MARKETPLACE_SELECTED_EXPR = `(() => {
  const share = [...document.querySelectorAll('h2')].find((el) => el.textContent.trim() === 'Share');
  const trigger = share?.parentElement?.querySelector('button[aria-haspopup="listbox"]');
  const label = (trigger?.textContent ?? '').trim();
  return label.length > 0 && !label.includes('publish yet');
})()`;

async function installFetchLogger(ctx) {
  await ctx.eval(`(() => {
    const original = window.__openworkOriginalFetch ?? window.fetch.bind(window);
    window.__openworkOriginalFetch = original;
    window.fetch = async (...args) => {
      const at = Date.now();
      const input = args[0];
      const init = args[1] ?? {};
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      const started = performance.now();
      try {
        return await original(...args);
      } finally {
        if (url.includes('/api/den/')) {
          const entry = { at, method, ms: Math.round(performance.now() - started), url };
          const current = JSON.parse(localStorage.getItem('__fetchLog') || '[]');
          current.push(entry);
          localStorage.setItem('__fetchLog', JSON.stringify(current));
        }
      }
    };
    localStorage.setItem('__fetchLog', '[]');
    localStorage.setItem('__createStart', String(Date.now()));
    return true;
  })()`);
}

function summarizeFetches(entries) {
  return entries.map((entry) => `${entry.method} ${entry.url} (${entry.ms}ms)`).join("\n");
}

export default {
  id: "create-plugin-single-request",
  title: "Create plugin: one save request preserves sharing and publish side effects",
  kind: "user-facing",
  spec: "evals/voiceovers/create-plugin-single-request.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("An admin opens Create plugin and fills a plugin with a skill", {
          voiceover: vo[0],
          action: async () => {
            await uiSignIn(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await goTo(ctx, "/dashboard/plugins/new");
            await fillPluginEditor(ctx);
          },
          assert: async () => {
            const shareState = await ctx.eval(`(() => {
              const share = [...document.querySelectorAll('h2')].find((el) => el.textContent.trim() === 'Share');
              const card = share?.parentElement;
              const checkbox = card?.querySelector('input[type="checkbox"]');
              return { checked: Boolean(checkbox?.checked), marketplaceSelected: ${MARKETPLACE_SELECTED_EXPR}, text: card?.innerText ?? '' };
            })()`);
            ctx.assert(shareState.text.includes("Marketplace"), "The Share card should include Marketplace.");
            ctx.assert(shareState.marketplaceSelected, "The first marketplace should be pre-selected.");
            ctx.assert(shareState.checked, "Org-wide sharing should be checked by default.");
            // Input values are not part of innerText, so witness the filled
            // skill through the DOM value instead of expectText.
            const skillFilled = await ctx.eval(`document.querySelector('input[placeholder^="Name (e.g. Prep a sales call)"]')?.value === ${JSON.stringify(state.skillName)}`);
            ctx.assert(skillFilled, "The skill name input should hold the filled value.");
          },
          screenshot: {
            name: "create-plugin-filled",
            claim: "The Create plugin editor is filled with one skill, org-wide sharing, and a marketplace selection.",
            requireText: ["Create a plugin", "Skill", "Share"],
            rejectText: ["Failed", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("One click creates the plugin with one Den request", {
          voiceover: vo[1],
          action: async () => {
            await installFetchLogger(ctx);
            const clicked = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Create plugin' && !el.disabled);
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "Could not click Create plugin.");
            await ctx.waitFor("location.pathname.includes('/dashboard/plugins/plg_') && !location.pathname.endsWith('/new')", { timeoutMs: 45_000, label: "plugin detail route" });
            state.pluginId = await ctx.eval("location.pathname.split('/').filter(Boolean).at(-1)");
            ctx.assert(typeof state.pluginId === "string" && state.pluginId.startsWith("plg_"), `Could not read plugin id from URL: ${state.pluginId}`);
          },
          assert: async () => {
            await ctx.expectText(state.pluginName, { timeoutMs: 20_000 });
            const fetchResult = await ctx.eval(`(() => {
              const start = Number(localStorage.getItem('__createStart') || '0');
              const entries = JSON.parse(localStorage.getItem('__fetchLog') || '[]').filter((entry) => entry.at >= start);
              const maxEnd = entries.length ? Math.max(...entries.map((entry) => entry.at + entry.ms)) : Date.now();
              return { durationMs: maxEnd - start, entries };
            })()`);
            const entries = fetchResult.entries;
            // The structural invariant: the whole save is ONE mutation. The
            // detail page issues follow-up GETs, so assert on POSTs only.
            const posts = entries.filter((entry) => entry.method === "POST");
            ctx.assert(posts.length === 1, `Expected exactly one POST during the save, saw ${posts.length}:\n${summarizeFetches(posts)}`);
            const createPost = posts[0];
            ctx.assert(
              createPost.url.includes("/v1/plugins") && !createPost.url.includes("/access") && !createPost.url.includes("/marketplaces") && !createPost.url.includes("/config-objects"),
              `The single POST must be the plugin create, saw: ${createPost.method} ${createPost.url}`,
            );
            const lastPostEnd = Math.max(...posts.map((entry) => entry.at + entry.ms));
            const start = Number(await ctx.eval("localStorage.getItem('__createStart')"));
            state.saveDurationMs = lastPostEnd - start;
            ctx.assert(state.saveDurationMs < 15_000, `Sanity ceiling: save took ${state.saveDurationMs}ms`);
            ctx.output("create-plugin-save", `Saved in ${Math.round(state.saveDurationMs)}ms with one POST:\n${summarizeFetches(posts)}\nAll den requests during save+landing:\n${summarizeFetches(entries)}`);
          },
          screenshot: {
            name: "plugin-detail-after-single-request",
            claim: "The newly created plugin opens after a single create request.",
            requireText: [state.pluginName],
            rejectText: ["Failed", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Nothing was lost by batching", {
          voiceover: vo[2],
          action: async () => {
            // The detail page still shows the skill, then Alex returns to the
            // catalog where the new plugin sits with its marketplace badge.
            await ctx.expectText(state.skillName, { timeoutMs: 20_000 });
            await goTo(ctx, "/dashboard/plugins");
            await ctx.waitFor(`document.body.innerText.includes(${JSON.stringify(state.pluginName)})`, { timeoutMs: 30_000, label: "plugin in catalog" });
          },
          assert: async () => {
            const token = await apiSignIn(ADMIN_EMAIL, ADMIN_PASSWORD);
            ctx.assert(Boolean(token), "Admin API sign-in failed.");
            const pluginId = state.pluginId;

            const pluginAccess = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, token);
            const pluginGrant = (pluginAccess.items ?? []).find((grant) => grant.orgWide === true && grant.role === "viewer" && !grant.removedAt);
            ctx.assert(Boolean(pluginGrant), `Plugin org-wide viewer grant missing: ${JSON.stringify(pluginAccess)}`);

            const memberships = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(pluginId)}/config-objects`, token);
            ctx.assert((memberships.items ?? []).length === 1, `Expected exactly one plugin component: ${JSON.stringify(memberships)}`);
            const configObjectId = memberships.items[0]?.configObjectId;
            ctx.assert(typeof configObjectId === "string", `Missing config object id: ${JSON.stringify(memberships)}`);

            const configAccess = await apiJson(ctx, `/v1/config-objects/${encodeURIComponent(configObjectId)}/access`, token);
            const configGrant = (configAccess.items ?? []).find((grant) => grant.orgWide === true && grant.role === "viewer" && !grant.removedAt);
            ctx.assert(Boolean(configGrant), `Config object org-wide viewer grant missing: ${JSON.stringify(configAccess)}`);

            const marketplaces = await apiJson(ctx, "/v1/marketplaces", token);
            const marketplaceId = marketplaces.items?.[0]?.id;
            ctx.assert(typeof marketplaceId === "string", `No marketplace available: ${JSON.stringify(marketplaces)}`);
            const marketplacePlugins = await apiJson(ctx, `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/plugins`, token);
            ctx.assert((marketplacePlugins.items ?? []).some((item) => item.pluginId === pluginId), `Marketplace does not include plugin ${pluginId}: ${JSON.stringify(marketplacePlugins)}`);

            // The catalog card carries the marketplace badge and the skill count.
            await ctx.expectText(state.pluginName, { timeoutMs: 20_000 });
            await ctx.expectText("1 Skill", { timeoutMs: 20_000 });
            ctx.output("create-plugin-side-effects", JSON.stringify({ configObjectId, marketplaceId, pluginId }, null, 2));
          },
          screenshot: {
            name: "plugin-catalog-with-published-plugin",
            claim: "The catalog lists the new plugin with its marketplace badge and one skill after the batched save.",
            requireText: [state.pluginName, "Marketplace"],
            rejectText: ["Failed", "Something went wrong"],
          },
        });
      },
    },
  ],
};
