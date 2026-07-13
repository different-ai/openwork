import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("connections-beta-desktop");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = Date.now();
const CONNECTION_NAME = `beta-proof-desktop-${RUN_TAG}`;
const CONNECTION_URL = "https://beta-proof.example.com/mcp";
const WORKSPACE_PATH = "/tmp/openwork-connections-beta-desktop";

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

async function signIn(email, password) {
  const { response, body } = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  return body.token;
}

async function ensureAdminSession(ctx) {
  if (state.adminSession) return state.adminSession;
  state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
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

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(300);
}

async function signDesktopIntoCloud(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000 });

  const alreadySignedIn = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())");
  if (!alreadySignedIn) {
    // Point the app at the local Den control plane the designed way:
    // desktop-bootstrap.json (via the desktop bridge). Everything derives
    // from it — including getDenMcpUrl(), which the cloud MCP auto-config
    // uses; localStorage overrides alone are not enough.
    await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
    const bootstrap = {
      baseUrl: DEN_API_URL,
      apiBaseUrl: DEN_API_URL,
      requireSignin: false,
      handoff: null,
    };
    const written = await ctx.eval(`(async () => {
      const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
      if (!bridge) return { ok: false };
      await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
      return { ok: true };
    })()`, { awaitPromise: true });
    ctx.assert(written?.ok, "Failed to write desktop bootstrap config.");
    await ctx.eval(`(() => {
      localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(DEN_API_URL)});
      localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(DEN_API_URL)});
      return true;
    })()`);
    await ctx.eval("location.reload()");
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after bootstrap reload" });
    const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
      method: "POST",
      headers: { authorization: `Bearer ${state.adminSession}` },
      body: JSON.stringify({ desktopScheme: "openwork" }),
    });
    ctx.assert(handoff.response.ok, `Handoff create failed: ${handoff.response.status}`);
    await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_API_URL });
  }
  await ctx.waitFor(
    "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
    { timeoutMs: 45_000, label: "persisted den auth token" },
  );
  await ctx.waitFor(
    "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
    { timeoutMs: 60_000, label: "active org resolved" },
  );
}

async function ensureWorkspace(ctx) {
  const inWorkspace = await ctx.eval("window.location.hash.includes('/workspace/')");
  if (!inWorkspace) {
    // Fresh userdata + cloud sign-in: org picker -> resources -> folder.
    await ctx.clickText("Continue with organization", { timeoutMs: 20_000 }).catch(() => {});
    await ctx.clickText("Continue to workspace", { timeoutMs: 30_000 }).catch(() => {});
    await ctx.waitFor(
      "Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]')) || window.location.hash.includes('/workspace/')",
      { timeoutMs: 30_000, label: "folder form or workspace" },
    );
    const needsFolder = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))");
    if (needsFolder) {
      await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
      await ctx.clickText("Use this folder", { timeoutMs: 20_000 });
    }
    await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace open" });
  }
  // Dismiss the OpenWork Models upsell if it appears.
  await ctx.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Continue without OpenWork Models');
    btn?.click();
    return true;
  })()`);
}

async function navigateToExtensionsMarketplace(ctx) {
  await closeStaleDialogs(ctx);
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
  ctx.assert(Boolean(workspaceId), "No workspace id in URL.");
  await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/mcp`);
  await ctx.waitFor("window.location.hash.includes('/settings/extensions/mcp')", { timeoutMs: 30_000, label: "extensions settings route" });
  await ctx.waitFor(
    "[...document.querySelectorAll('button')].some((entry) => entry.textContent.trim() === 'Marketplace')",
    { timeoutMs: 30_000, label: "marketplace toggle rendered" },
  );
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent.trim() === 'Marketplace');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, "Marketplace toggle button was not found.");
  await ctx.waitFor("document.body.innerText.includes('Extension Marketplace')", { timeoutMs: 20_000, label: "marketplace view" });
}

async function clickRefreshIfAvailable(ctx) {
  const clicked = await ctx.eval(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Refresh' && !button.disabled);
    buttons[buttons.length - 1]?.click();
    return buttons.length > 0;
  })()`);
  if (clicked) await sleep(2_000);
}

async function waitForMarketplaceCard(ctx, name) {
  const deadline = Date.now() + 90_000;
  let refreshed = false;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      return [...document.querySelectorAll('button')].some((button) => button.querySelector('h4')?.textContent.trim() === ${JSON.stringify(name)});
    })()`);
    if (found) return;
    if (!refreshed && Date.now() > deadline - 60_000) {
      await clickRefreshIfAvailable(ctx);
      refreshed = true;
    }
    await sleep(2_000);
  }
  ctx.assert(false, `Marketplace card did not render: ${name}`);
}

async function clickExtensionCard(ctx, name) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => entry.querySelector('h4')?.textContent.trim() === ${JSON.stringify(name)});
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, `Extension card not found: ${name}`);
}

export default {
  id: "connections-beta-desktop",
  title: "Desktop Marketplace: alpha org connections are labeled and last",
  kind: "user-facing",
  spec: "evals/voiceovers/connections-beta-desktop.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Setup signs the desktop into the org after publishing the beta proof connection", {
          voiceover: vo[0],
          action: async () => {
            state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
            ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
            await createPerMemberConnection(ctx);
            await signDesktopIntoCloud(ctx);
            await ensureWorkspace(ctx);
          },
          assert: async () => {
            const auth = await ctx.eval(`(() => ({
              token: (localStorage.getItem('openwork.den.authToken') ?? '').trim(),
              activeOrgId: (localStorage.getItem('openwork.den.activeOrgId') ?? '').trim(),
            }))()`);
            ctx.assert(Boolean(auth.token), "Desktop Den auth token was not persisted.");
            ctx.assert(Boolean(auth.activeOrgId), "Desktop active org was not resolved.");
            await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 20_000, label: "workspace hash" });
          },
          screenshot: {
            name: "connections-beta-desktop-signed-in",
            claim: "The desktop app is signed into Acme after the admin publishes the beta proof org connection.",
            requireText: [],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The org tool appears in the Marketplace, last and wearing Alpha", {
          voiceover: vo[1],
          action: async () => {
            await navigateToExtensionsMarketplace(ctx);
            await waitForMarketplaceCard(ctx, CONNECTION_NAME);
            // The claim is about the LAST card: scroll it into the picture and
            // let the marketplace load toast clear so the frame shows it.
            await ctx.eval(`(() => {
              const card = [...document.querySelectorAll('button')].find((button) => button.querySelector('h4')?.textContent.trim() === ${JSON.stringify(CONNECTION_NAME)});
              card?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
            await ctx.waitFor(
              "!document.body.innerText.includes('marketplace extensions for')",
              { timeoutMs: 10_000, label: "marketplace load toast cleared" },
            ).catch(() => {});
            await sleep(500);
          },
          assert: async () => {
            const proof = await ctx.eval(`(() => {
              const compact = (entry) => (entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
              const card = [...document.querySelectorAll('button')].find((button) => button.querySelector('h4')?.textContent.trim() === ${JSON.stringify(CONNECTION_NAME)});
              const grid = card?.closest('.grid') ?? null;
              const cards = grid ? [...grid.querySelectorAll('button')].filter((button) => button.querySelector('h4')) : [];
              const select = [...document.querySelectorAll('select')].find((entry) => [...entry.options].some((option) => option.textContent.trim() === 'Organization MCP Connections'));
              return {
                cardText: compact(card),
                lastCardText: compact(cards[cards.length - 1]),
                filterOptions: select ? [...select.options].map((option) => option.textContent.trim()) : [],
              };
            })()`);
            ctx.assert(proof.cardText.includes(CONNECTION_NAME), `Marketplace card not found: ${JSON.stringify(proof)}`);
            ctx.assert(proof.cardText.includes("Alpha"), `Marketplace card must include the Alpha pill: ${proof.cardText}`);
            ctx.assert(proof.lastCardText.includes(CONNECTION_NAME), `Org connection must be the last marketplace card: ${proof.lastCardText}`);
            ctx.assert(proof.filterOptions[proof.filterOptions.length - 1] === "Organization MCP Connections", `Marketplace filter order was wrong: ${JSON.stringify(proof.filterOptions)}`);
          },
          screenshot: {
            name: "connections-beta-desktop-marketplace-last",
            claim: "The Marketplace shows the alpha org MCP connection as the last card and the last marketplace filter option.",
            requireText: [CONNECTION_NAME, "Alpha"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The detail modal says Alpha before anyone connects", {
          voiceover: vo[2],
          action: async () => {
            await clickExtensionCard(ctx, CONNECTION_NAME);
            await ctx.waitFor("document.body.innerText.includes('Release stage')", { timeoutMs: 15_000, label: "detail modal release stage" });
          },
          assert: async () => {
            const modal = await ctx.eval(`(() => {
              const roots = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]')];
              const root = roots.find((entry) => entry.textContent.includes(${JSON.stringify(CONNECTION_NAME)}))
                ?? [...document.querySelectorAll('div')].find((entry) => entry.textContent.includes(${JSON.stringify(CONNECTION_NAME)}) && entry.textContent.includes('Release stage'));
              const text = (root?.textContent ?? '').replace(/\\s+/g, ' ').trim();
              const betaPill = root ? [...root.querySelectorAll('span')].some((span) => span.textContent.trim() === 'Alpha') : false;
              return { text, betaPill };
            })()`);
            ctx.assert(modal.text.includes(CONNECTION_NAME), `Detail modal missing connection name: ${modal.text}`);
            ctx.assert(modal.betaPill, "Detail modal missing Alpha pill.");
            ctx.assert(/Release stage\s*Alpha/.test(modal.text), `Detail modal missing Release stage Alpha row: ${modal.text}`);
            ctx.assert(modal.text.includes("Connect your account"), `Detail modal missing connect label: ${modal.text}`);
          },
          screenshot: {
            name: "connections-beta-desktop-detail-modal",
            claim: "The org MCP connection detail modal shows Alpha, Release stage, and Connect your account before authorization.",
            requireText: [CONNECTION_NAME, "Release stage", "Alpha"],
            rejectText: ["Something went wrong"],
          },
        });
        await closeStaleDialogs(ctx);
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
