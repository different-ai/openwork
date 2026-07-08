/**
 * Org Google Workspace, end to end (spec: evals/voiceovers/org-google-workspace-demo.md):
 *
 * - Frame 1: admin saves the org Google OAuth client (the two-field den-web
 *   preset drives POST /v1/oauth-providers/google-workspace/client; here the
 *   same call runs as API-driven setup, witnessed by the member-visible list
 *   flipping from absent to present).
 * - Frames 2-4: the member desktop shows the native entry as an ordinary
 *   catalog card, connects through a real browser OAuth round trip against
 *   the mock Google IdP, and the card flips to Connected with no reload —
 *   all on desktop code that shipped with #2451, zero client changes.
 * - Frame 5: a real chat turn creates a Gmail draft through OpenWork Cloud
 *   Control -> Den capability route -> mock Gmail; the mock's request log +
 *   decoded RFC 822 raw are the external witness.
 * - Frame 6: a freshly created second org sees no Google entry.
 * - Frame 7: the local Google Workspace extension is untouched.
 *
 * Run against a Den stack whose den-api has DEN_GOOGLE_OAUTH_AUTHORIZE_URL,
 * DEN_GOOGLE_OAUTH_TOKEN_URL, and DEN_GOOGLE_API_BASE_URL pointed at the
 * mock server (scripts/mock-oauth-mcp-server.mjs, AUTO_APPROVE=1).
 */

import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("org-google-workspace-demo");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL.replace("127.0.0.1", "localhost")).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const DRAFT_SUBJECT = `Follow up ${RUN_TAG}`;
const WORKSPACE_PATH = `/tmp/openwork-org-google-workspace-${RUN_TAG}`;
const GOOGLE_CARD_EXPR = (needle) =>
  `[...document.querySelectorAll("button")].some((el) => el.textContent.includes("Google Workspace") && el.textContent.includes(${JSON.stringify(needle)}))`;

const state = {
  adminSession: null,
  memberSession: null,
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

async function ensureVerifiedUser(ctx, email, name, password) {
  let token = await signIn(email, password);
  if (token) return token;

  const signUp = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
  ctx.assert(signUp.response.ok, `Sign-up failed for ${email}: ${signUp.response.status}`);
  ctx.assert(MARK_VERIFIED_CMD.length > 0, "Set OPENWORK_EVAL_MARK_VERIFIED_CMD to verify eval accounts.");
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
  token = await signIn(email, password);
  ctx.assert(Boolean(token), `Sign-in still failing for ${email} after sign-up.`);
  return token;
}

async function ensureMember(ctx) {
  state.memberSession = await ensureVerifiedUser(ctx, MEMBER_EMAIL, "Jordan Demo", MEMBER_PASSWORD);
  const orgs = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${state.memberSession}` } });
  const inAcme = (orgs.body.orgs ?? []).some((org) => org.slug === "acme-robotics-demo");
  if (inAcme) return;

  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminSession}` },
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status}`);
  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${state.memberSession}` },
    body: JSON.stringify({ id: invite.body.inviteToken }),
  });
  ctx.assert(accept.response.ok && accept.body.accepted, "Invitation accept failed.");
}

async function memberUsableConnections() {
  const { body } = await denApiFetch("/v1/mcp-connections?scope=usable", {
    headers: { authorization: `Bearer ${state.memberSession}` },
  });
  return body.connections ?? [];
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
    const step = await ctx.eval(`(() => {
      const text = document.body.innerText;
      const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
      const hasWorkspaceRoute = window.location.hash.includes('/workspace/') && !text.includes('Choose your organization') && !hasFolderInput;
      const hasOnboardingStep = text.includes('Choose your organization') || text.includes('Continue to workspace') || text.includes('Loading available resources');
      const hasCreateAction = !hasOnboardingStep && window.__openworkControl?.listActions?.().find((a) => a.id === 'workspace.create')?.disabled === false;
      return { hasFolderInput, hasWorkspaceRoute, hasCreateAction };
    })()`);
    if (step.hasWorkspaceRoute || step.hasCreateAction) break;
    if (step.hasFolderInput) {
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
  await ctx.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Continue without OpenWork Models');
    btn?.click();
    return true;
  })()`, { awaitPromise: true });
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
          body: JSON.stringify({ folderPath: ${JSON.stringify(WORKSPACE_PATH)}, name: 'org-google-workspace-demo', preset: 'starter' }),
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
  const workspaceId = state.workspaceId;
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
    if (last.hash.includes('/settings/extensions/mcp') && last.hasTabs) return;
    await sleep(1_000);
  }
  ctx.assert(false, `MCP settings never became ready: ${JSON.stringify(last)}`);
}

async function clickTab(ctx, label) {
  await ctx.waitFor(
    `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)} && !candidate.disabled);
      button?.click();
      return Boolean(button);
    })()`,
    { timeoutMs: 30_000, label: `${label} tab` },
  );
}

async function mockRequests() {
  const { requests } = await fetch(`${MOCK_SERVER_URL}/requests`).then((r) => r.json());
  return requests;
}

export default {
  id: "org-google-workspace-demo",
  title: "Org Google Workspace: admin sets it up once, members connect their own account, the agent drafts Gmail as them",
  kind: "user-facing",
  spec: "evals/voiceovers/org-google-workspace-demo.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("An org admin sets up Google Workspace once by saving the org OAuth client", {
          voiceover: vo[0],
          action: async () => {
            const health = await fetch(`${MOCK_SERVER_URL}/health`).then((r) => r.json()).catch(() => null);
            ctx.assert(Boolean(health?.ok), `Mock Google IdP not reachable at ${MOCK_SERVER_URL}.`);
            ctx.assert(health.autoApprove !== false, "Mock server must auto-approve for this flow.");

            state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
            ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
            await ensureMember(ctx);

            // Rerun hygiene: drop any Google connection the member kept from a
            // previous run so the flow always starts from "not connected".
            await denApiFetch("/v1/oauth-providers/google-workspace/disconnect", {
              method: "POST",
              headers: { authorization: `Bearer ${state.memberSession}` },
            }).catch(() => {});

            const before = await memberUsableConnections();
            const alreadyEnrolled = before.some((entry) => entry.id === "google-workspace");
            if (alreadyEnrolled) {
              ctx.log("Org already enrolled from a previous run; the absent-before witness only applies to first runs.");
            } else {
              ctx.assert(!alreadyEnrolled, "Google Workspace should be absent before the admin enrolls the org.");
            }

            const saved = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
              method: "POST",
              headers: { authorization: `Bearer ${state.adminSession}` },
              body: JSON.stringify({ clientId: `acme-google-client-${RUN_TAG}`, clientSecret: "acme-google-secret" }),
            });
            ctx.assert(saved.response.ok, `Saving the org Google client failed: ${saved.response.status}`);
          },
          assert: async () => {
            const after = await memberUsableConnections();
            const entry = after.find((candidate) => candidate.id === "google-workspace");
            ctx.assert(Boolean(entry), "Members should now see Google Workspace among usable connections.");
            ctx.assert(entry.credentialMode === "per_member", "Google Workspace must be per-member.");
            ctx.assert(entry.connectedForMe === false, "The member has not connected yet.");
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The member desktop shows Google Workspace as an ordinary org catalog card", {
          voiceover: vo[1],
          action: async () => {
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

            await openMcpSettings(ctx);
            await ctx.clickText("Refresh", { timeoutMs: 15_000 }).catch(() => {});
            await clickTab(ctx, "Marketplace");
          },
          assert: async () => {
            await ctx.expectText("Extension Marketplace", { timeoutMs: 30_000 });
            await ctx.waitFor(GOOGLE_CARD_EXPR("Connect your account"), { timeoutMs: 60_000, label: "org Google Workspace card with connect action" });
            await ctx.eval(`(() => {
              const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Google Workspace') && el.textContent.includes('Connect your account'));
              card?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
          },
          screenshot: {
            name: "org-google-workspace-marketplace",
            claim: "The desktop Marketplace shows the org Google Workspace card with a Connect your account action.",
            requireText: ["Google Workspace", "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Connecting opens a real browser OAuth round trip against the org Google client", {
          voiceover: vo[2],
          action: async () => {
            const opened = await ctx.eval(`(() => {
              const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Google Workspace') && el.textContent.includes('Connect your account'));
              card?.scrollIntoView({ block: 'center' });
              card?.click();
              return Boolean(card);
            })()`);
            ctx.assert(opened, "Could not open the org Google Workspace card.");
            await ctx.expectText("OpenWork stores this sign-in", { timeoutMs: 15_000 });
            state.clickedAt = new Date().toISOString();
            const clicked = await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const button = [...(dialog?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === 'Connect your account' && !el.disabled);
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "Could not click the modal Connect your account button.");
          },
          assert: async () => {
            let authorize = null;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !authorize) {
              const requests = await mockRequests();
              authorize = requests.find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= state.clickedAt) ?? null;
              if (!authorize) await sleep(500);
            }
            ctx.assert(Boolean(authorize), "No GET /authorize reached the mock Google IdP after the connect click.");
            const params = new URL(`${MOCK_SERVER_URL}${authorize.url}`).searchParams;
            ctx.assert(params.get("client_id") === `acme-google-client-${RUN_TAG}`, "Authorize must use the org saved Google client id.");
            ctx.assert(Boolean(params.get("state")), "Authorize request is missing signed state.");
            ctx.assert(Boolean(params.get("code_challenge")), "Authorize request is missing PKCE.");
            ctx.assert((params.get("redirect_uri") ?? "").includes("/v1/oauth-providers/google-workspace/connect/callback"), "Redirect must return to the Den native-provider callback.");

            const tokenExchange = (await mockRequests()).some((entry) => entry.method === "POST" && entry.path === "/token" && entry.at >= state.clickedAt);
            ctx.assert(tokenExchange, "The auto-approved consent should complete a code-for-token exchange.");
          },
          screenshot: {
            name: "org-google-workspace-consent",
            claim: "The consent modal shows the org sign-in copy before the browser round trip.",
            requireText: ["Google Workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The same card flips to Connected with no reload", {
          voiceover: vo[3],
          action: async () => {
            await openMcpSettings(ctx);
            await clickTab(ctx, "My Extensions");
          },
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const card = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("Google Workspace") && el.textContent.includes("Connected with your own account"));
                return Boolean(card && !card.textContent.includes("Connect your account"));
              })()`,
              { timeoutMs: 90_000, label: "org Google Workspace card connected in My Extensions" },
            );
            const server = await memberUsableConnections();
            const entry = server.find((candidate) => candidate.id === "google-workspace");
            ctx.assert(entry?.connectedForMe === true, "Server-side connectedForMe should be true after the round trip.");
          },
          screenshot: {
            name: "org-google-workspace-connected",
            claim: "Google Workspace is Connected with the member own account after the browser OAuth round trip.",
            requireText: ["Google Workspace", "Connected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("A real chat turn drafts the Gmail through the org connection", {
          voiceover: vo[4],
          action: async () => {
            await openMcpSettings(ctx);
            await revealHidden(ctx);
            await ctx.expectText("OpenWork Cloud Control", { timeoutMs: 30_000 });
            const alreadyConnected = await ctx.eval(`(() => {
              const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('OpenWork Cloud Control'));
              return Boolean(card?.textContent.includes('Connected'));
            })()`);
            if (!alreadyConnected) {
              const openedCard = await ctx.eval(`(() => {
                const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('OpenWork Cloud Control'));
                card?.scrollIntoView({ block: 'center' });
                card?.click();
                return Boolean(card);
              })()`);
              ctx.assert(openedCard, "Could not open the OpenWork Cloud Control card.");
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
            await ctx.clickText("Refresh", { timeoutMs: 15_000 }).catch(() => {});
            let runtime = null;
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
              runtime = await ctx.eval(`(async () => {
                const workspaceId = ${JSON.stringify(state.workspaceId)};
                const port = localStorage.getItem('openwork.server.port');
                const token = localStorage.getItem('openwork.server.token');
                const hostToken = localStorage.getItem('openwork.server.hostToken');
                if (!workspaceId || !port || !token) return { ok: false, reason: 'missing workspace/server auth' };
                const headers = { Authorization: 'Bearer ' + token };
                if (hostToken) headers['X-OpenWork-Host-Token'] = hostToken;
                const response = await fetch('http://127.0.0.1:' + port + '/workspace/' + workspaceId + '/mcp', { headers });
                if (!response.ok) return { ok: false, status: response.status };
                const payload = await response.json();
                const entry = (payload?.items ?? []).find((item) => item.name === 'openwork-cloud');
                return { ok: Boolean(entry?.config?.url?.includes('/mcp/agent') && payload?.engineSync?.status === 'ok') };
              })()`, { awaitPromise: true });
              if (runtime?.ok) break;
              await sleep(1_000);
            }
            ctx.assert(runtime?.ok, `Runtime OpenWork Cloud Control MCP never became ready: ${JSON.stringify(runtime)}`);

            await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
            await ctx.waitFor("window.location.hash.includes('/session')", { timeoutMs: 20_000 });
            state.chatStartedAt = new Date().toISOString();
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().find((a) => a.id === 'session.create_task')?.disabled === false",
              { timeoutMs: 30_000, label: "session.create_task enabled" },
            );
            await ctx.control("session.create_task");
            await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 30_000, label: "fresh task session" });
            await ctx.waitFor("Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))", { timeoutMs: 30_000, label: "composer" });
            const prompt = `Use the OpenWork Cloud Control connection: call search_capabilities with query "gmail draft", then call execute_capability on the Gmail draft capability. For the body arguments use: to = customer@example.com, subject = ${DRAFT_SUBJECT}, body = Thanks for the call today. Reply with the draft id the tool returned.`;
            await ctx.control("composer.set_text", { text: prompt });
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().find((a) => a.id === 'composer.send')?.disabled === false",
              { timeoutMs: 15_000, label: "composer.send enabled" },
            );
            await ctx.control("composer.send");
          },
          assert: async () => {
            // The send is async: wait for the turn to visibly start (Stop
            // appears) before waiting for it to finish, so a slow model
            // cannot race the completion check.
            await ctx.waitFor(
              "Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'))",
              { timeoutMs: 30_000, label: "assistant started" },
            ).catch(() => {});
            await ctx.waitFor("!Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'))", { timeoutMs: 240_000, label: "assistant finished" });

            // External witness: the mock Gmail must have received the draft
            // during this chat window. Poll — tool execution can trail the
            // final assistant text by a moment.
            let draftCall = null;
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline && !draftCall) {
              const requests = await mockRequests();
              draftCall = requests.find((entry) => entry.method === "POST" && entry.path === "/gmail/v1/users/me/drafts" && entry.at >= state.chatStartedAt) ?? null;
              if (!draftCall) await sleep(2_000);
            }
            ctx.assert(Boolean(draftCall), `No POST /gmail/v1/users/me/drafts on the mock after ${state.chatStartedAt}.`);

            const { drafts } = await fetch(`${MOCK_SERVER_URL}/gmail/drafts-log`).then((r) => r.json());
            const witnessed = drafts.some((draft) => {
              const decoded = Buffer.from(draft.raw, "base64url").toString("utf8").replace(/\s+/g, " ");
              return decoded.includes(String(RUN_TAG)) && decoded.includes("customer@example.com");
            });
            ctx.assert(witnessed, "The decoded RFC 822 draft on the mock must carry the run tag and recipient.");

            await ctx.waitFor(
              `(document.body.innerText.match(new RegExp(${JSON.stringify(String(RUN_TAG))}, 'g')) ?? []).length >= 1`,
              { timeoutMs: 30_000, label: "run tag visible in the conversation" },
            );
          },
          screenshot: {
            name: "org-google-workspace-chat",
            claim: "A real desktop chat created the Gmail draft through the org Google connection and reported it.",
            requireText: [String(RUN_TAG)],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("A company that has not enrolled sees no Google entry at all", {
          voiceover: vo[5],
          action: async () => {
            const rivalEmail = "rival.demo@umbrella.test";
            state.rivalSession = await ensureVerifiedUser(ctx, rivalEmail, "Rival Demo", MEMBER_PASSWORD);
            const created = await denApiFetch("/v1/org", {
              method: "POST",
              headers: { authorization: `Bearer ${state.rivalSession}` },
              body: JSON.stringify({ name: `Umbrella ${RUN_TAG}` }),
            });
            ctx.assert(created.response.ok, `Second org create failed: ${created.response.status}`);
          },
          assert: async () => {
            const { body } = await denApiFetch("/v1/mcp-connections?scope=usable", {
              headers: { authorization: `Bearer ${state.rivalSession}` },
            });
            const connections = body.connections ?? [];
            ctx.assert(!connections.some((entry) => entry.id === "google-workspace"), "A non-enrolled org must not see Google Workspace.");
            ctx.assert(connections.length === 0, `A fresh org should have no usable connections, got ${JSON.stringify(connections)}.`);
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("The local solo Google Workspace extension is untouched by the org connection", {
          voiceover: vo[6],
          action: async () => {
            await openMcpSettings(ctx);
            await clickTab(ctx, "Marketplace");
            await ctx.eval(`(() => {
              const el = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.includes('Google Workspace') && candidate.textContent.includes('View setup'));
              el?.scrollIntoView({ block: 'center' });
              return Boolean(el);
            })()`);
          },
          assert: async () => {
            // The local built-in extension still offers its own setup in the
            // Marketplace catalog, exactly as before the org connection.
            await ctx.waitFor(GOOGLE_CARD_EXPR("View setup"), { timeoutMs: 30_000, label: "local built-in Google Workspace card still renders" });
            // And the org connection stays connected server-side at the same time.
            const server = await memberUsableConnections();
            const entry = server.find((candidate) => candidate.id === "google-workspace");
            ctx.assert(entry?.connectedForMe === true, "The org Google connection must still be connected for the member.");
          },
          screenshot: {
            name: "org-google-workspace-local-intact",
            claim: "The local Google Workspace extension still renders its own setup alongside the org connection.",
            requireText: ["Google Workspace", "View setup"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
