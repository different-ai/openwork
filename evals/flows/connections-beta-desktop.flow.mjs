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

async function navigateToConnectSettings(ctx) {
  await closeStaleDialogs(ctx);
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
  ctx.assert(Boolean(workspaceId), "No workspace id in URL.");
  await ctx.navigateHash(`/workspace/${workspaceId}/settings/connect`);
  await ctx.waitFor("window.location.hash.includes('/settings/connect')", { timeoutMs: 30_000, label: "connect settings route" });
  await ctx.waitFor("document.body.innerText.includes('Connect')", { timeoutMs: 30_000, label: "connect settings view" });
}

async function clickRefreshIfAvailable(ctx) {
  const clicked = await ctx.eval(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Refresh' && !button.disabled);
    buttons[buttons.length - 1]?.click();
    return buttons.length > 0;
  })()`);
  if (clicked) await sleep(2_000);
}

async function waitForConnectConnectionRow(ctx, name) {
  const deadline = Date.now() + 90_000;
  let refreshed = false;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      return [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
        .some((row) => (row.textContent ?? '').includes(${JSON.stringify(name)}));
    })()`);
    if (found) return;
    if (!refreshed && Date.now() > deadline - 60_000) {
      await clickRefreshIfAvailable(ctx);
      refreshed = true;
    }
    await sleep(2_000);
  }
  ctx.assert(false, `Connect organization row did not render: ${name}`);
}

async function readConnectConnectionState(ctx, name) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
      .find((entry) => compact(entry).includes(${JSON.stringify(name)}));
    return {
      pageText: document.body.innerText,
      rowText: compact(row),
    };
  })()`);
}

async function readExtensionsMarketplaceState(ctx, name) {
  return ctx.eval(`(() => {
    const text = document.body.innerText;
    const filterOptions = [...document.querySelectorAll('select option')].map((option) => option.textContent.trim());
    return {
      text,
      hasConnection: text.includes(${JSON.stringify(name)}),
      filterOptions,
    };
  })()`);
}

export default {
  id: "connections-beta-desktop",
  title: "Desktop Connect: alpha org connections appear only in Connect",
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
        await ctx.prove("The org tool appears in Connect as needing the member's sign-in", {
          voiceover: vo[1],
          action: async () => {
            await navigateToConnectSettings(ctx);
            await waitForConnectConnectionRow(ctx, CONNECTION_NAME);
            await ctx.eval(`(() => {
              const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
                .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(CONNECTION_NAME)}));
              row?.scrollIntoView({ block: 'center' });
              return Boolean(row);
            })()`);
            await sleep(500);
          },
          assert: async () => {
            const proof = await readConnectConnectionState(ctx, CONNECTION_NAME);
            ctx.assert(proof.pageText.includes("From your organization"), "Connect organization section missing.");
            ctx.assert(proof.pageText.includes("NEEDS YOUR SIGN-IN"), `Needs-your-sign-in group missing: ${proof.pageText.slice(0, 300)}`);
            ctx.assert(proof.rowText.includes(CONNECTION_NAME), `Connect row not found: ${JSON.stringify(proof)}`);
            ctx.assert(proof.rowText.includes("Connect your account"), `Connect row action missing: ${proof.rowText}`);
          },
          screenshot: {
            name: "connections-beta-desktop-connect-row",
            claim: "OpenWork Connect shows the org MCP connection under Needs your sign-in with Connect your account.",
            requireText: ["From your organization", "NEEDS YOUR SIGN-IN", CONNECTION_NAME, "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Extensions Marketplace no longer lists org MCP connections", {
          voiceover: vo[2],
          action: async () => {
            await navigateToExtensionsMarketplace(ctx);
          },
          assert: async () => {
            const proof = await readExtensionsMarketplaceState(ctx, CONNECTION_NAME);
            ctx.assert(proof.text.includes("Extension Marketplace"), "Extensions Marketplace did not render.");
            ctx.assert(!proof.hasConnection, `Extensions Marketplace rendered org connection: ${proof.text}`);
            ctx.assert(!proof.filterOptions.includes("Organization MCP Connections"), `Org MCP filter leaked: ${JSON.stringify(proof.filterOptions)}`);
          },
          screenshot: {
            name: "connections-beta-desktop-extensions-absent",
            claim: "Extensions Marketplace stays local-only and has no org MCP connection card or filter.",
            requireText: ["Extension Marketplace"],
            rejectText: [CONNECTION_NAME, "Organization MCP Connections", "Something went wrong"],
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
