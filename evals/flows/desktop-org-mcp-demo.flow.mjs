/**
 * Tutorial-driven desktop proof for org MCP connections:
 *
 * - Admin setup creates a per-member org MCP connection in Den (the den-web
 *   admin screen is proven separately by mcp-connections-cloud-oauth).
 * - Jordan signs the desktop into the same org.
 * - The connection appears in OpenWork Connect as an org MCP item that needs
 *   Jordan's sign-in.
 * - Jordan clicks through Connect, the OS browser completes a real OAuth
 *   round trip, and the item becomes Ready in Connect.
 * - A real chat turn executes the external MCP tool through OpenWork Cloud
 *   Control; the mock server log is the external witness.
 */

import { execSync } from "node:child_process";

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL.replace("127.0.0.1", "localhost")).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const CONNECTION_NAME = `Team Knowledge Base ${RUN_TAG}`;
const ECHO_TEXT = `org mcp desktop proof ${RUN_TAG}`;
const WORKSPACE_PATH = `/tmp/openwork-desktop-org-mcp-demo-${RUN_TAG}`;

const state = {
  adminSession: null,
  memberSession: null,
  connectionId: null,
  workspaceId: null,
  clickedAt: null,
  chatStartedAt: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const revealHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showing) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
};

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

async function ensureMember(ctx) {
  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  if (state.memberSession) return;

  ctx.log(`Bootstrapping member ${MEMBER_EMAIL} via the real invitation flow.`);
  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminSession}` },
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status}`);

  const signUp = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
  });
  ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status}`);
  ctx.assert(MARK_VERIFIED_CMD.length > 0, "Set OPENWORK_EVAL_MARK_VERIFIED_CMD to verify the member's email.");
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", MEMBER_EMAIL), { stdio: "ignore" });

  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  ctx.assert(Boolean(state.memberSession), "Member sign-in still failing after sign-up.");

  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${state.memberSession}` },
    body: JSON.stringify({ id: invite.body.inviteToken }),
  });
  ctx.assert(accept.response.ok && accept.body.accepted, "Invitation accept failed.");
}

async function ensureWorkspace(ctx) {
  const ready = await ctx.eval(`(() => {
    const text = document.body.innerText;
    return window.location.hash.includes('/workspace/')
      && !text.includes('Choose your organization')
      && !Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
  })()`);
  if (ready) return;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await ctx.eval(`(() => {
      const text = document.body.innerText;
      const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
      const hasWorkspaceRoute = window.location.hash.includes('/workspace/') && !text.includes('Choose your organization') && !hasFolderInput;
      const hasOnboardingStep = text.includes('Choose your organization') || text.includes('Continue to workspace') || text.includes('Loading available resources');
      const hasCreateAction = !hasOnboardingStep && window.__openworkControl?.listActions?.().find((a) => a.id === 'workspace.create')?.disabled === false;
      return { hasFolderInput, hasWorkspaceRoute, hasCreateAction };
    })()`);
    if (state.hasWorkspaceRoute || state.hasCreateAction) break;
    if (state.hasFolderInput) {
      await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
      await ctx.clickText("Use this folder", { timeoutMs: 20_000 });
      await sleep(750);
      continue;
    }
    await ctx.eval(`(() => {
      const labels = ['Continue with organization', 'Continue to workspace', 'Continue'];
      const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled);
      const button = buttons.find((candidate) => labels.includes(candidate.textContent.trim()));
      button?.scrollIntoView({ block: 'center' });
      button?.click();
      return Boolean(button);
    })()`);
    await sleep(1_000);
  }
  await ctx.waitFor(
    `(() => {
      const text = document.body.innerText;
      const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
      const hasWorkspaceRoute = window.location.hash.includes('/workspace/') && !text.includes('Choose your organization') && !hasFolderInput;
      const hasOnboardingStep = text.includes('Choose your organization') || text.includes('Continue to workspace') || text.includes('Loading available resources');
      const hasCreateAction = !hasOnboardingStep && window.__openworkControl?.listActions?.().find((a) => a.id === 'workspace.create')?.disabled === false;
      return hasWorkspaceRoute || hasCreateAction;
    })()`,
    { timeoutMs: 10_000, label: "workspace route or create action" },
  );
  await ctx.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Continue without OpenWork Models');
    btn?.click();
    return true;
  })()`, { awaitPromise: true });
}

async function currentWorkspaceId(ctx) {
  // Prefer the fresh eval workspace: after the OAuth deep-link the app can
  // land back on a previously active workspace, and the proof must not
  // drift into stale profile workspaces.
  if (state.workspaceId) return state.workspaceId;
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
  ctx.assert(Boolean(workspaceId), "No workspace id in URL.");
  return workspaceId;
}

async function readRuntimeCloudControlMcp(ctx) {
  const pinnedWorkspaceId = state.workspaceId ?? "";
  return ctx.eval(`(async () => {
    const parts = window.location.hash.split('/');
    const workspaceIndex = parts.indexOf('workspace');
    const workspaceId = ${JSON.stringify(pinnedWorkspaceId)} || (workspaceIndex >= 0 ? parts[workspaceIndex + 1] : '');
    const port = localStorage.getItem('openwork.server.port');
    const token = localStorage.getItem('openwork.server.token');
    const hostToken = localStorage.getItem('openwork.server.hostToken');
    if (!workspaceId || !port || !token) return { ok: false, reason: 'missing workspace/server auth', workspaceId, port: Boolean(port), token: Boolean(token) };
    const headers = { Authorization: 'Bearer ' + token };
    if (hostToken) headers['X-OpenWork-Host-Token'] = hostToken;
    const response = await fetch('http://127.0.0.1:' + port + '/workspace/' + workspaceId + '/mcp', { headers });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (!response.ok) return { ok: false, reason: 'mcp endpoint failed', status: response.status, text };
    const items = payload?.items ?? [];
    const entry = items.find((item) => item.name === 'openwork-cloud');
    const engineSync = payload?.engineSync?.status ?? null;
    return {
      ok: Boolean(entry?.config?.url?.includes('/mcp/agent') && entry?.config?.headers?.Authorization && entry?.config?.oauth === false && engineSync === 'ok'),
      workspaceId,
      names: items.map((item) => item.name),
      engineSync,
      engineFailures: payload?.engineSync?.failures ?? [],
      entry,
    };
  })()`, { awaitPromise: true });
}

async function waitForRuntimeCloudControlMcp(ctx) {
  let last = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      last = await readRuntimeCloudControlMcp(ctx);
      if (last?.ok) return;
    } catch (error) {
      last = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    await sleep(1_000);
  }
  ctx.assert(false, `Runtime OpenWork Cloud Control MCP config never became ready: ${JSON.stringify(last)}`);
}

async function createFreshEvalWorkspace(ctx) {
  await ensureWorkspace(ctx);
  await ctx.waitFor(
    "Boolean(localStorage.getItem('openwork.server.port') && localStorage.getItem('openwork.server.token') && localStorage.getItem('openwork.server.hostToken'))",
    { timeoutMs: 30_000, label: "OpenWork server auth for workspace setup" },
  );
  let created = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    created = await ctx.eval(`(async () => {
      try {
        const port = localStorage.getItem('openwork.server.port');
        const token = localStorage.getItem('openwork.server.token');
        const hostToken = localStorage.getItem('openwork.server.hostToken');
        const base = 'http://127.0.0.1:' + port;
        const headers = {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'X-OpenWork-Host-Token': hostToken,
        };
        const response = await fetch(base + '/workspaces/local', {
          method: 'POST',
          headers,
          body: JSON.stringify({ folderPath: ${JSON.stringify(WORKSPACE_PATH)}, name: 'openwork-desktop-org-mcp-demo', preset: 'starter' }),
        });
        const text = await response.text();
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        if (!response.ok) return { ok: false, status: response.status, text };
        const workspaceId = payload?.activeId ?? payload?.workspaces?.find((workspace) => workspace.path === ${JSON.stringify(WORKSPACE_PATH)})?.id;
        if (!workspaceId) return { ok: false, status: response.status, text: 'workspace id missing' };
        const activate = await fetch(base + '/workspaces/' + workspaceId + '/activate?persist=true', { method: 'POST', headers });
        if (!activate.ok) return { ok: false, status: activate.status, text: await activate.text() };
        localStorage.setItem('openwork.react.activeWorkspace', workspaceId);
        return { ok: true, workspaceId };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })()`, { awaitPromise: true });
    if (created?.ok) break;
    await sleep(1_000);
  }
  ctx.assert(created?.ok && created.workspaceId, `Workspace setup failed: ${JSON.stringify(created)}`);
  state.workspaceId = created.workspaceId;
  await ctx.navigateHash(`/workspace/${created.workspaceId}/session`);
  await sleep(2_000);
  if (await ctx.eval("window.location.hash.includes('/onboarding')")) {
    await ensureWorkspace(ctx);
    await ctx.navigateHash(`/workspace/${created.workspaceId}/session`);
  }
  await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "fresh eval workspace selected" });
}

async function openMcpSettings(ctx) {
  const workspaceId = await currentWorkspaceId(ctx);
  let last = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/mcp`);
    await sleep(1_000);
    last = await ctx.eval(`(() => {
      const text = document.body.innerText;
      return {
        hash: window.location.hash,
        onOnboarding: window.location.hash.includes('/onboarding') || text.includes('Continue with organization') || text.includes('Continue to workspace'),
        hasTabs: text.includes('My Extensions') && text.includes('Marketplace'),
      };
    })()`);
    if (last.onOnboarding) {
      await ensureWorkspace(ctx);
      await sleep(500);
      continue;
    }
    if (last.hash.includes('/settings/extensions/mcp') && last.hasTabs) return workspaceId;
    await sleep(1_000);
  }
  ctx.assert(false, `MCP settings never became ready: ${JSON.stringify(last)}`);
}

async function openConnectSettings(ctx) {
  const workspaceId = await currentWorkspaceId(ctx);
  let last = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await ctx.navigateHash(`/workspace/${workspaceId}/settings/connect`);
    await sleep(1_000);
    last = await ctx.eval(`(() => {
      const text = document.body.innerText;
      return {
        hash: window.location.hash,
        onOnboarding: window.location.hash.includes('/onboarding') || text.includes('Continue with organization') || text.includes('Continue to workspace'),
        hasConnect: text.includes('Connect'),
      };
    })()`);
    if (last.onOnboarding) {
      await ensureWorkspace(ctx);
      await sleep(500);
      continue;
    }
    if (last.hash.includes('/settings/connect') && last.hasConnect) return workspaceId;
    await sleep(1_000);
  }
  ctx.assert(false, `Connect settings never became ready: ${JSON.stringify(last)}`);
}

async function waitForConnectOrgRow(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      return [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
        .some((row) => (row.textContent ?? '').includes(${JSON.stringify(name)}));
    })()`);
    if (found) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `Connect org row did not render: ${name}`);
}

async function waitForConnectReadyRow(ctx, name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
        .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(name)}));
      return Boolean(row && (row.textContent ?? '').includes('Ready') && !(row.textContent ?? '').includes('Connect your account'));
    })()`);
    if (found) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => {});
    await sleep(2_000);
  }
  ctx.assert(false, `Connect org row did not become ready: ${name}`);
}

async function waitForMockAuthorizeRequest(ctx) {
  let authorizeRequest = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !authorizeRequest) {
    const { requests } = await fetch(`${MOCK_SERVER_URL}/requests`).then((r) => r.json());
    authorizeRequest = requests.find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= state.clickedAt) ?? null;
    if (!authorizeRequest) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  ctx.assert(Boolean(authorizeRequest), "No GET /authorize reached the mock IdP after the desktop Connect click.");
  const params = new URL(`${MOCK_SERVER_URL}${authorizeRequest.url}`).searchParams;
  ctx.assert(Boolean(params.get("state")), "Authorize request is missing signed state.");
  ctx.assert(Boolean(params.get("client_id")), "Authorize request is missing dynamic client_id.");
  ctx.assert((params.get("redirect_uri") ?? "").includes(state.connectionId), "Authorize redirect_uri was not scoped to this connection.");
}

export default {
  id: "desktop-org-mcp-demo",
  title: "Desktop app: org MCP connections appear in Connect, connect through browser OAuth, and work in chat",
  kind: "user-facing",
  spec: "evals/desktop-org-mcp-demo.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup: publish a per-member org MCP connection for Jordan",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        const healthBody = await fetch(`${MOCK_SERVER_URL}/health`).then((r) => r.json());
        ctx.assert(healthBody.autoApprove !== false, "Mock server must auto-approve (AUTO_APPROVE!=0) for this flow.");

        state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
        await ensureMember(ctx);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("Team Knowledge Base ") || connection.name.startsWith("desktop-consolidation-")) {
            await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
          }
        }

        const created = await denApiFetch("/v1/mcp-connections", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminSession}` },
          body: JSON.stringify({
            name: CONNECTION_NAME,
            url: `${MOCK_SERVER_URL}/mcp`,
            authType: "oauth",
            credentialMode: "per_member",
            access: { orgWide: true },
          }),
        });
        ctx.assert(created.response.ok, `Connection create failed: ${created.response.status}`);
        state.connectionId = created.body.id;

        const usable = await denApiFetch("/v1/mcp-connections?scope=usable", {
          headers: { authorization: `Bearer ${state.memberSession}` },
        });
        const mine = (usable.body.connections ?? []).find((entry) => entry.id === state.connectionId);
        ctx.assert(Boolean(mine), "Member cannot see the org-wide connection.");
        ctx.assert(mine.connectedForMe === false, "Member's account should not be connected at flow start.");
      },
    },
    {
      name: "Desktop app boots and signs in as Jordan",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000 });
        await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
        const bootstrap = { baseUrl: DEN_API_URL, apiBaseUrl: DEN_API_URL, requireSignin: false, handoff: null };
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
          const prefs = JSON.parse(localStorage.getItem('openwork.preferences') || '{}');
          localStorage.setItem('openwork.preferences', JSON.stringify({ ...prefs, selectedAgent: 'openwork' }));
          return true;
        })()`);
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after bootstrap reload" });

        const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
          method: "POST",
          headers: { authorization: `Bearer ${state.memberSession}` },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        ctx.assert(handoff.response.ok, `Handoff create failed: ${handoff.response.status}`);
        await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_API_URL });
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 45_000, label: "persisted den auth token" });
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", { timeoutMs: 60_000, label: "active org resolved" });
        await createFreshEvalWorkspace(ctx);
      },
    },
    {
      name: "Jordan discovers the org MCP connection in OpenWork Connect",
      run: async (ctx) => {
        await openConnectSettings(ctx);
        await ctx.expectHashIncludes("/settings/connect", { timeoutMs: 20_000 });
        await waitForConnectOrgRow(ctx, CONNECTION_NAME);

        await ctx.prove("Jordan sees the org MCP connection in OpenWork Connect, with a connect action", {
          voiceover: "Jordan opens OpenWork Connect and sees the org-shared MCP connection under Needs your sign-in, clearly marked as something they can connect with their own account.",
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME, { timeoutMs: 60_000 });
            await ctx.expectText("NEEDS YOUR SIGN-IN", { timeoutMs: 30_000 });
            await ctx.expectText("Connect your account", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "desktop-org-mcp-connect",
            claim: "OpenWork Connect shows the org-published MCP connection with a 'Connect your account' action.",
            requireText: ["From your organization", "NEEDS YOUR SIGN-IN", CONNECTION_NAME, "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Jordan connects through real browser OAuth",
      run: async (ctx) => {
        state.clickedAt = new Date().toISOString();
        const clicked = await ctx.eval(`(() => {
          const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
            .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(CONNECTION_NAME)}));
          const button = [...(row?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === 'Connect your account' && !el.disabled);
          button?.click();
          return Boolean(button);
        })()`);
        ctx.assert(clicked, "Could not click the Connect row's Connect your account button.");
        await waitForMockAuthorizeRequest(ctx);
      },
    },
    {
      name: "The item becomes ready in OpenWork Connect",
      run: async (ctx) => {
        await openConnectSettings(ctx);
        await waitForConnectReadyRow(ctx, CONNECTION_NAME);
        await ctx.prove("After the browser sign-in completes, the same org MCP item is ready in OpenWork Connect", {
          voiceover: "The OAuth callback completed in the browser, and the desktop did not need a manual reload. Jordan's row is now ready in OpenWork Connect as a connected MCP integration.",
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const row = [...document.querySelectorAll('[data-testid="connect-organization-row"]')]
                  .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(CONNECTION_NAME)}));
                return Boolean(row && (row.textContent ?? '').includes("Ready") && !(row.textContent ?? '').includes("Connect your account"));
              })()`,
              { timeoutMs: 90_000, label: "org MCP row ready in Connect" },
            );
          },
          screenshot: {
            name: "desktop-org-mcp-connected",
            claim: "The org MCP connection is marked Ready in OpenWork Connect after the browser OAuth round trip.",
            requireText: [CONNECTION_NAME, "Ready"],
            rejectText: ["Connect your account", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "OpenWork Cloud Control is ready",
      run: async (ctx) => {
        await openMcpSettings(ctx);
        await revealHidden(ctx);
        await ctx.expectText("OpenWork Cloud Control", { timeoutMs: 30_000 });

        const alreadyConnected = await ctx.eval(`(() => {
          const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('OpenWork Cloud Control'));
          return Boolean(card?.textContent.includes('Connected'));
        })()`);
        if (!alreadyConnected) {
          const opened = await ctx.eval(`(() => {
            const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('OpenWork Cloud Control'));
            card?.scrollIntoView({ block: 'center' });
            card?.click();
            return Boolean(card);
          })()`);
          ctx.assert(opened, "Could not open the OpenWork Cloud Control card.");
          await ctx.expectText("Manage your org", { timeoutMs: 15_000 });
          const clicked = await ctx.eval(`(() => {
            const dialog = document.querySelector('[role="dialog"]');
            const button = [...(dialog?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === 'Connect' && !el.disabled);
            button?.click();
            return Boolean(button);
          })()`);
          ctx.assert(clicked, "Could not click Connect for OpenWork Cloud Control.");
        }

        await ctx.waitFor(
          `(() => {
            const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('OpenWork Cloud Control'));
            return Boolean(card?.textContent.includes('Connected'));
          })()`,
          { timeoutMs: 60_000, label: "OpenWork Cloud Control connected card" },
        );
        await ctx.expectText("Ready", { timeoutMs: 30_000 });
        await ctx.clickText("Refresh", { timeoutMs: 15_000 }).catch(() => {});
        await waitForRuntimeCloudControlMcp(ctx);
      },
    },
    {
      name: "Jordan's agent executes the org MCP tool in real chat",
      run: async (ctx) => {
        const workspaceId = await currentWorkspaceId(ctx);
        await ctx.navigateHash(`/workspace/${workspaceId}/session`);
        await ctx.waitFor("window.location.hash.includes('/session')", { timeoutMs: 20_000 });
        state.chatStartedAt = new Date().toISOString();

        await ctx.prove("Jordan's agent can immediately execute the newly connected org MCP tool", {
          voiceover: "The connection is not just a settings card. In a real desktop chat, the agent discovers the organization's MCP capability through OpenWork Cloud Control and executes it with Jordan's own connected account.",
          action: async () => {
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().find((a) => a.id === 'session.create_task')?.disabled === false",
              { timeoutMs: 30_000, label: "session.create_task enabled" },
            );
            await ctx.control("session.create_task");
            await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 30_000, label: "fresh task session" });
            await ctx.waitFor("Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))", { timeoutMs: 30_000, label: "composer" });
            const prompt = `Use the OpenWork Cloud Control connection: call search_capabilities with query "echo", then call execute_capability with the exact match name and body {"text":"${ECHO_TEXT}"}. Reply with the exact text the tool returned.`;
            await ctx.control("composer.set_text", { text: prompt });
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().find((a) => a.id === 'composer.send')?.disabled === false",
              { timeoutMs: 15_000, label: "composer.send enabled" },
            );
            await ctx.control("composer.send");
          },
          assert: async () => {
            await ctx.waitFor("!Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'))", { timeoutMs: 180_000, label: "assistant finished" });
            await ctx.waitFor(
              `(document.body.innerText.match(new RegExp(${JSON.stringify(ECHO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}, 'g')) ?? []).length >= 2`,
              { timeoutMs: 60_000, label: "echoed text in prompt and result" },
            );

            const { requests } = await fetch(`${MOCK_SERVER_URL}/requests`).then((r) => r.json());
            const fresh = requests.filter((entry) => entry.method === "POST" && entry.path === "/mcp" && entry.at >= state.chatStartedAt);
            ctx.assert(fresh.length > 0, `No POST /mcp on the external server after ${state.chatStartedAt}.`);
          },
          screenshot: {
            name: "desktop-org-mcp-chat",
            claim: "A real desktop chat executed the org MCP tool through OpenWork Cloud Control and showed the exact result.",
            requireText: [ECHO_TEXT],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        if (state.connectionId) {
          const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removed.response.ok, "Cleanup delete failed.");
        }
      },
    },
  ],
};
