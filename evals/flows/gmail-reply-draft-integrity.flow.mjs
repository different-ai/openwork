import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/gmail-reply-draft-integrity.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("gmail-reply-draft-integrity");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL.replace("127.0.0.1", "localhost")).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const WORKSPACE_PATH = `/tmp/openwork-gmail-reply-draft-integrity-${RUN_TAG}`;
const GMAIL_THREAD_ID = "thread-q3-launch";
const PROMPT = `Use the OpenWork Cloud connection: find the Gmail thread about "Q3 launch" (call search_capabilities, then the Gmail messages capability), then create a reply draft on that thread with subject "Re: Q3 launch" confirming Thursday works, addressed to sarah@acme.test. Do not include quoted history yourself; pass the threadId so OpenWork can append it. When done, reply with the draft link the tool returned.`;
const PROMPT_FRAGMENT = 'find the Gmail thread about "Q3 launch"';
const GOOGLE_CARD_EXPR = (needle) =>
  `[...document.querySelectorAll("button")].some((el) => el.textContent.includes("Google Workspace") && el.textContent.includes(${JSON.stringify(needle)}))`;

const state = {
  adminSession: null,
  memberSession: null,
  workspaceId: null,
  clickedAt: null,
  chatStartedAt: null,
  draftEntry: null,
  decodedDraft: null,
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
          body: JSON.stringify({ folderPath: ${JSON.stringify(WORKSPACE_PATH)}, name: 'gmail-reply-draft-integrity', preset: 'starter' }),
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

async function bootstrapDesktopToDen(ctx) {
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
}

async function mockRequests() {
  const { requests } = await fetch(`${MOCK_SERVER_URL}/requests`).then((response) => response.json());
  return requests;
}

async function mockDrafts() {
  const { drafts } = await fetch(`${MOCK_SERVER_URL}/gmail/drafts-log`).then((response) => response.json());
  return drafts;
}

async function connectGoogleWorkspace(ctx) {
  await openMcpSettings(ctx);
  await ctx.clickText("Refresh", { timeoutMs: 15_000 }).catch(() => {});
  await clickTab(ctx, "Marketplace");

  let connected = await ctx.eval(`(() => {
    const card = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Google Workspace'));
    return Boolean(card?.textContent.includes('Connected with your own account'));
  })()`);
  if (!connected) {
    await ctx.waitFor(GOOGLE_CARD_EXPR("Connect your account"), { timeoutMs: 60_000, label: "org Google Workspace connect card" });
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

    let authorize = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !authorize) {
      const requests = await mockRequests();
      authorize = requests.find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= state.clickedAt) ?? null;
      if (!authorize) await sleep(500);
    }
    ctx.assert(Boolean(authorize), "No GET /authorize reached the mock Google IdP after the connect click.");
    const tokenExchange = (await mockRequests()).some((entry) => entry.method === "POST" && entry.path === "/token" && entry.at >= state.clickedAt);
    ctx.assert(tokenExchange, "The auto-approved Google consent should complete a code-for-token exchange.");
  }

  await openMcpSettings(ctx);
  await clickTab(ctx, "My Extensions");
  await ctx.waitFor(
    `(() => {
      const card = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("Google Workspace") && el.textContent.includes("Connected with your own account"));
      return Boolean(card && !card.textContent.includes("Connect your account"));
    })()`,
    { timeoutMs: 90_000, label: "org Google Workspace card connected in My Extensions" },
  );
  const server = await memberUsableConnections();
  const entry = server.find((candidate) => candidate.id === "google-workspace");
  connected = entry?.connectedForMe === true;
  ctx.assert(connected, "Server-side connectedForMe should be true after the Google round trip.");
}

async function ensureOpenWorkCloudControl(ctx) {
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
}

async function ensureRuntimeCloudMcp(ctx) {
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
}

async function resetChatState(ctx) {
  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await ctx.waitFor("window.location.hash.includes('/session')", { timeoutMs: 20_000 });
  await ctx.waitFor(
    "window.__openworkControl?.listActions?.().find((a) => a.id === 'session.create_task')?.disabled === false",
    { timeoutMs: 30_000, label: "session.create_task enabled" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor("window.location.hash.includes('/session/ses_')", { timeoutMs: 30_000, label: "fresh task session" });
  await ctx.waitFor("Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))", { timeoutMs: 30_000, label: "composer" });
}

async function pollForGmailRead(ctx) {
  let recent = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const requests = await mockRequests();
    recent = requests.filter((entry) => entry.at >= state.chatStartedAt);
    const read = recent.find((entry) =>
      entry.method === "GET" && (entry.path === "/gmail/v1/users/me/messages" || entry.path === `/gmail/v1/users/me/threads/${GMAIL_THREAD_ID}`)
    );
    if (read) return read;
    await sleep(2_000);
  }
  ctx.assert(false, `No Gmail read reached the mock after ${state.chatStartedAt}. Recent requests: ${JSON.stringify(recent.slice(-12))}`);
}

function decodeDraft(raw) {
  const rfc822 = Buffer.from(raw, "base64url").toString("utf8");
  const normalized = rfc822.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const headerText = separator === -1 ? normalized : normalized.slice(0, separator);
  const bodyText = separator === -1 ? "" : normalized.slice(separator + 2);
  const transfer = headerText.split("\n").find((line) => /^Content-Transfer-Encoding:/i.test(line)) ?? "";
  const body = /base64/i.test(transfer)
    ? Buffer.from(bodyText.replace(/\s+/g, ""), "base64").toString("utf8").replace(/\r\n?/g, "\n")
    : bodyText.replace(/\r\n?/g, "\n");
  return { rfc822, headers: headerText, body };
}

async function pollForThreadedDraft(ctx) {
  let recent = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const drafts = await mockDrafts();
    recent = drafts.filter((draft) => draft.at >= state.chatStartedAt);
    const draft = recent.find((entry) => entry.threadId === GMAIL_THREAD_ID) ?? recent[0];
    if (draft) return draft;
    await sleep(2_000);
  }
  ctx.assert(false, `No Gmail draft reached the mock after ${state.chatStartedAt}. Recent drafts: ${JSON.stringify(recent)}`);
}

function requireDecodedDraft(ctx) {
  ctx.assert(Boolean(state.decodedDraft), "No decoded draft is available; frame 3 must pass before inspecting the body.");
  return state.decodedDraft;
}

function quoteIndex(body) {
  const match = body.match(/^On .*Sarah.*wrote:$/m);
  return match?.index ?? -1;
}

export default {
  id: "gmail-reply-draft-integrity",
  title: "Gmail reply drafts stay threaded, quote history, keep clean prose, and return the Gmail draft link",
  kind: "user-facing",
  spec: "evals/voiceovers/gmail-reply-draft-integrity.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).then((response) => response.json()).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock Google IdP not reachable at ${MOCK_SERVER_URL}.`);
        ctx.assert(health.autoApprove !== false, "Mock server must auto-approve for this flow.");

        state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const saved = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminSession}` },
          body: JSON.stringify({
            clientId: `acme-google-client-${RUN_TAG}`,
            clientSecret: "acme-google-secret",
            features: ["calendarRead", "gmailDraft", "gmailRead", "driveFile"],
          }),
        });
        ctx.assert(saved.response.ok, `Saving the org Google client failed: ${saved.response.status} ${JSON.stringify(saved.body)}`);

        await ensureMember(ctx);
        await denApiFetch("/v1/oauth-providers/google-workspace/disconnect", {
          method: "POST",
          headers: { authorization: `Bearer ${state.memberSession}` },
        }).catch(() => {});

        await bootstrapDesktopToDen(ctx);
        await createFreshEvalWorkspace(ctx);
        await connectGoogleWorkspace(ctx);
        await ensureOpenWorkCloudControl(ctx);
        await ensureRuntimeCloudMcp(ctx);
        await resetChatState(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The user asks OpenWork to reply to Sarah's Q3 launch thread", {
          voiceover: vo[0],
          // "I'm in OpenWork, and Sarah's thread about the Q3 launch has been going back "
          action: async () => {
            await ctx.control("composer.set_text", { text: PROMPT });
            await ctx.waitFor(
              "window.__openworkControl?.listActions?.().find((a) => a.id === 'composer.send')?.disabled === false",
              { timeoutMs: 15_000, label: "composer.send enabled" },
            );
            state.chatStartedAt = new Date().toISOString();
            await ctx.control("composer.send");
          },
          assert: async () => {
            await ctx.waitForText(PROMPT_FRAGMENT, { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "gmail-reply-request",
            claim: "The transcript shows the user asking for a threaded Q3 launch reply draft.",
            requireText: ["find the Gmail thread", "Q3 launch"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("OpenWork reads Gmail before drafting the reply", {
          voiceover: vo[1],
          // "OpenWork reads the thread through my connected Google account first, so the "
          action: async () => {},
          assert: async () => {
            const read = await pollForGmailRead(ctx);
            ctx.log(`Observed Gmail read: ${read.method} ${read.url}`);
          },
          screenshot: {
            name: "gmail-reply-reading-thread",
            claim: "While the chat turn is working, the mock Google request log has a Gmail read for this turn.",
            requireText: ["Q3 launch"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The created draft is attached to the original Gmail thread", {
          voiceover: vo[2],
          // "It stages my reply as a draft on the same thread — same \"Re: Q3 launch\" subj"
          action: async () => {},
          assert: async () => {
            const draft = await pollForThreadedDraft(ctx);
            state.draftEntry = draft;
            ctx.assert(draft.threadId === GMAIL_THREAD_ID, `Draft threadId should be ${GMAIL_THREAD_ID}, got ${JSON.stringify(draft.threadId)}.`);
            const decoded = decodeDraft(draft.raw);
            state.decodedDraft = decoded;
            ctx.assert(decoded.headers.includes("In-Reply-To: <sarah-2@acme.test>"), `Draft missing In-Reply-To header. Headers: ${decoded.headers}`);
            ctx.assert(decoded.headers.includes("Subject: Re: Q3 launch"), `Draft missing reply subject. Headers: ${decoded.headers}`);
          },
          screenshot: {
            name: "gmail-reply-threaded-draft",
            claim: "The mock Gmail draft log proves the draft used thread-q3-launch with reply headers.",
            requireText: ["Q3 launch"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The draft body appends Sarah's quoted thread history below the new reply", {
          voiceover: vo[3],
          // "When I look at the draft, my reply sits on top and the entire conversation t"
          action: async () => {},
          assert: async () => {
            const decoded = requireDecodedDraft(ctx);
            const index = quoteIndex(decoded.body);
            ctx.assert(index >= 0, `Draft body missing Sarah quote header. Body: ${decoded.body}`);
            ctx.assert(/^> Are we still on for Thursday\?$/m.test(decoded.body), `Draft body missing quoted fixture line. Body: ${decoded.body}`);
            const thursdayIndex = decoded.body.toLowerCase().indexOf("thursday");
            ctx.assert(thursdayIndex >= 0 && thursdayIndex < index, `The new reply text should mention Thursday before the quote block. Body: ${decoded.body}`);
          },
          screenshot: {
            name: "gmail-reply-quoted-history",
            claim: "The decoded draft has the new reply first and Sarah's quoted history immediately below it.",
            requireText: ["Q3 launch"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The new reply segment uses clean email formatting", {
          voiceover: vo[4],
          // "The text reads like an email a person wrote: real paragraphs, no weird mid-s"
          action: async () => {},
          assert: async () => {
            const decoded = requireDecodedDraft(ctx);
            const index = quoteIndex(decoded.body);
            ctx.assert(index >= 0, `Draft body missing quote delimiter. Body: ${decoded.body}`);
            const newSegment = decoded.body.slice(0, index).trim();
            const lines = newSegment.split("\n");
            for (let i = 0; i < lines.length - 1; i += 1) {
              const current = lines[i].trim();
              const next = lines[i + 1].trim();
              ctx.assert(!current || !next, `New reply has consecutive non-empty lines (hard wrap) around line ${i + 1}: ${JSON.stringify(newSegment)}`);
            }
            ctx.assert(!newSegment.includes("**"), `New reply still contains markdown bold tokens: ${JSON.stringify(newSegment)}`);
            ctx.assert(!/^#{1,6}\s/m.test(newSegment), `New reply still contains markdown heading tokens: ${JSON.stringify(newSegment)}`);
            ctx.assert(!newSegment.includes("`"), `New reply still contains markdown code tokens: ${JSON.stringify(newSegment)}`);
          },
          screenshot: {
            name: "gmail-reply-clean-formatting",
            claim: "The decoded new reply segment has paragraphs, not hard-wrapped markdown.",
            requireText: ["Q3 launch"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("OpenWork relays the Gmail draft link back to the user", {
          voiceover: vo[5],
          // "And OpenWork finishes by handing me the link — one click opens the ready-to-"
          action: async () => {},
          assert: async () => {
            await ctx.waitForText("mail.google.com", { timeoutMs: 240_000 });
            const transcript = await ctx.eval("document.body.innerText");
            ctx.assert(transcript.includes("mail.google.com"), "The chat transcript never showed the Gmail draft URL.");
          },
          screenshot: {
            name: "gmail-reply-draft-link",
            claim: "The chat ends with the Gmail draftUrl that opens the ready-to-send draft.",
            requireText: ["mail.google.com"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
