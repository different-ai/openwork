import { execSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import type { ChildProcess } from "node:child_process";

// Narration is loaded from the approved script (evals/voiceovers/org-connection-lifecycle-desktop.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-connection-lifecycle-desktop");
if (!vo) throw new Error("Missing approved voice-over script for org-connection-lifecycle-desktop.");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOCK_SERVER_SCRIPT = join(ROOT, "scripts", "mock-oauth-mcp-server.mjs");
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL.replace("127.0.0.1", "localhost")).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_LIFECYCLE_MOCK_PORT || 3979);
const MOCK_LOCAL_URL = `http://127.0.0.1:${MOCK_PORT}`;
// When a public URL is provided the mock server is managed externally (e.g.
// started on the sandbox that hosts Electron) and the flow talks to it over
// that URL instead of spawning its own local instance.
const MOCK_EXTERNAL_URL = process.env.OPENWORK_EVAL_LIFECYCLE_MOCK_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
const MOCK_SELF_HOSTED = MOCK_EXTERNAL_URL.length === 0;
const MOCK_PUBLIC_URL = MOCK_SELF_HOSTED ? MOCK_LOCAL_URL : MOCK_EXTERNAL_URL;
const MOCK_CONTROL_URL = MOCK_SELF_HOSTED ? MOCK_LOCAL_URL : MOCK_EXTERNAL_URL;
const RUN_TAG = Date.now();
const CONNECTION_NAME = `Meeting Notes ${RUN_TAG}`;
const WORKSPACE_PATH = `/tmp/openwork-org-connection-lifecycle-${RUN_TAG}`;

type ParsedFetch = {
  response: Response;
  body: unknown;
  text: string;
};

type ConnectionSummary = {
  id: string;
  name: string;
  connectedForMe: boolean | null;
  connectedAt: string | null;
};

type MockAuthorizeRequest = {
  method: string;
  path: string;
  url: string;
  at: string;
};

type FlowState = {
  adminSession: string | null;
  memberSession: string | null;
  connectionId: string | null;
  workspaceId: string | null;
  connectClickedAt: string | null;
  reconnectClickedAt: string | null;
  firstConnectedAt: string | null;
  secondConnectedAt: string | null;
  mockChild: ChildProcess | null;
  mockOutput: string;
};

const state: FlowState = {
  adminSession: null,
  memberSession: null,
  connectionId: null,
  workspaceId: null,
  connectClickedAt: null,
  reconnectClickedAt: null,
  firstConnectedAt: null,
  secondConnectedAt: null,
  mockChild: null,
  mockOutput: "",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const entry = value[key];
  return typeof entry === "string" ? entry : null;
}

function requireStateString(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} was not prepared.`);
  return value;
}

function bodyPreview(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function parseConnection(value: unknown): ConnectionSummary | null {
  if (!isRecord(value)) return null;
  const id = readStringField(value, "id");
  const name = readStringField(value, "name");
  if (!id || !name) return null;
  return {
    id,
    name,
    connectedForMe: typeof value.connectedForMe === "boolean" ? value.connectedForMe : null,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
  };
}

function parseConnections(value: unknown): ConnectionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.connections)) return [];
  const connections: ConnectionSummary[] = [];
  for (const entry of value.connections) {
    const parsed = parseConnection(entry);
    if (parsed) connections.push(parsed);
  }
  return connections;
}

function parseMockAuthorizeRequest(value: unknown): MockAuthorizeRequest | null {
  if (!isRecord(value)) return null;
  const method = readStringField(value, "method");
  const path = readStringField(value, "path");
  const url = readStringField(value, "url");
  const at = readStringField(value, "at");
  if (!method || !path || !url || !at) return null;
  return { method, path, url, at };
}

function parseMockRequests(value: unknown): MockAuthorizeRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) return [];
  const requests: MockAuthorizeRequest[] = [];
  for (const entry of value.requests) {
    const parsed = parseMockAuthorizeRequest(entry);
    if (parsed) requests.push(parsed);
  }
  return requests;
}

async function denApiFetch(path: string, options: RequestInit = {}): Promise<ParsedFetch> {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", DEN_WEB_URL);
  const response = await fetch(`${DEN_API_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.trim().length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function signIn(email: string, password: string): Promise<string | null> {
  const { response, body } = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  return readStringField(body, "token");
}

async function ensureMember(ctx: FlowContext): Promise<void> {
  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  if (state.memberSession) return;

  ctx.log(`Bootstrapping member ${MEMBER_EMAIL} via the real invitation flow.`);
  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${requireStateString(state.adminSession, "admin session")}` },
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status} ${bodyPreview(invite.body).slice(0, 300)}`);
  const inviteToken = readStringField(invite.body, "inviteToken");
  ctx.assert(Boolean(inviteToken), `Invitation did not return inviteToken: ${bodyPreview(invite.body).slice(0, 300)}`);

  const signUp = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
  });
  ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status} ${bodyPreview(signUp.body).slice(0, 300)}`);
  ctx.assert(MARK_VERIFIED_CMD.length > 0, "Set OPENWORK_EVAL_MARK_VERIFIED_CMD to verify the member's email.");
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", MEMBER_EMAIL), { cwd: ROOT, stdio: "ignore" });

  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  ctx.assert(Boolean(state.memberSession), "Member sign-in still failing after sign-up.");

  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${requireStateString(state.memberSession, "member session")}` },
    body: JSON.stringify({ id: requireStateString(inviteToken, "invite token") }),
  });
  ctx.assert(accept.response.ok && isRecord(accept.body) && accept.body.accepted === true, `Invitation accept failed: ${accept.response.status} ${bodyPreview(accept.body).slice(0, 300)}`);
}

async function ensureWorkspace(ctx: FlowContext): Promise<void> {
  const ready = await ctx.eval(`(() => {
    const text = document.body.innerText;
    return window.location.hash.includes('/workspace/')
      && !text.includes('Choose your organization')
      && !Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
  })()`);
  if (ready === true) return;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const workspaceState = await ctx.eval(`(() => {
      const text = document.body.innerText;
      const hasFolderInput = Boolean(document.querySelector('input[placeholder="/workspace/my-project"]'));
      const hasWorkspaceRoute = window.location.hash.includes('/workspace/') && !text.includes('Choose your organization') && !hasFolderInput;
      const hasOnboardingStep = text.includes('Choose your organization') || text.includes('Continue to workspace') || text.includes('Loading available resources');
      const hasCreateAction = !hasOnboardingStep && window.__openworkControl?.listActions?.().find((a) => a.id === 'workspace.create')?.disabled === false;
      return { hasFolderInput, hasWorkspaceRoute, hasCreateAction };
    })()`);
    if (isRecord(workspaceState) && (workspaceState.hasWorkspaceRoute === true || workspaceState.hasCreateAction === true)) break;
    if (isRecord(workspaceState) && workspaceState.hasFolderInput === true) {
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

async function currentWorkspaceId(ctx: FlowContext): Promise<string> {
  if (state.workspaceId) return state.workspaceId;
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
  ctx.assert(typeof workspaceId === "string" && workspaceId.length > 0, "No workspace id in URL.");
  if (typeof workspaceId !== "string") throw new Error("No workspace id in URL.");
  return workspaceId;
}

function parseWorkspaceSetup(value: unknown): { ok: boolean; workspaceId: string | null } {
  if (!isRecord(value)) return { ok: false, workspaceId: null };
  return {
    ok: value.ok === true,
    workspaceId: readStringField(value, "workspaceId"),
  };
}

async function createFreshEvalWorkspace(ctx: FlowContext): Promise<void> {
  await ensureWorkspace(ctx);
  await ctx.waitFor(
    "Boolean(localStorage.getItem('openwork.server.port') && localStorage.getItem('openwork.server.token') && localStorage.getItem('openwork.server.hostToken'))",
    { timeoutMs: 30_000, label: "OpenWork server auth for workspace setup" },
  );
  let created: unknown = null;
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
          body: JSON.stringify({ folderPath: ${JSON.stringify(WORKSPACE_PATH)}, name: 'org-connection-lifecycle-desktop', preset: 'starter' }),
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
    const parsed = parseWorkspaceSetup(created);
    if (parsed.ok && parsed.workspaceId) break;
    await sleep(1_000);
  }
  const parsed = parseWorkspaceSetup(created);
  ctx.assert(parsed.ok && Boolean(parsed.workspaceId), `Workspace setup failed: ${bodyPreview(created)}`);
  state.workspaceId = requireStateString(parsed.workspaceId, "workspace id");
  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await sleep(2_000);
  if (await ctx.eval("window.location.hash.includes('/onboarding')") === true) {
    await ensureWorkspace(ctx);
    await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  }
  await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "fresh eval workspace selected" });
}

async function openExtensionsConnections(ctx: FlowContext): Promise<string> {
  const workspaceId = await currentWorkspaceId(ctx);
  let last: unknown = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/connections`);
    await sleep(1_000);
    last = await ctx.eval(`(() => {
      const text = document.body.innerText;
      return {
        hash: window.location.hash,
        onOnboarding: window.location.hash.includes('/onboarding') || text.includes('Continue with organization') || text.includes('Continue to workspace'),
        hasExtensions: text.includes('Extensions'),
      };
    })()`);
    if (isRecord(last) && last.onOnboarding === true) {
      await ensureWorkspace(ctx);
      await sleep(500);
      continue;
    }
    if (
      isRecord(last)
      && typeof last.hash === "string"
      && last.hash.includes("/settings/extensions")
      && last.hasExtensions === true
    ) return workspaceId;
    await sleep(1_000);
  }
  ctx.assert(false, `Extensions connections route never became ready: ${bodyPreview(last)}`);
  throw new Error("Extensions connections route never became ready.");
}

async function clickRefreshIfPresent(ctx: FlowContext): Promise<void> {
  await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((el) => (el.textContent ?? '').trim() === 'Refresh' && !el.disabled);
    button?.click();
    return Boolean(button);
  })()`).catch(() => undefined);
}

async function waitForConnectionCard(ctx: FlowContext): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await ctx.eval(`(() => {
      return [...document.querySelectorAll('button')]
        .some((button) => (button.textContent ?? '').includes(${JSON.stringify(CONNECTION_NAME)}));
    })()`);
    if (found === true) return;
    await ctx.control("extensions.refresh-marketplace").catch(() => undefined);
    await clickRefreshIfPresent(ctx);
    await sleep(2_000);
  }
  ctx.assert(false, `Connection card did not render: ${CONNECTION_NAME}`);
}

async function openConnectionDetail(ctx: FlowContext): Promise<void> {
  const opened = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((el) => (el.textContent ?? '').includes(${JSON.stringify(CONNECTION_NAME)}) && !el.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(opened === true, `Could not open connection detail for ${CONNECTION_NAME}.`);
}

async function waitForNotConnectedDetail(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(
    `(() => {
      const text = document.body.innerText;
      const hasConnectButton = [...document.querySelectorAll('button')]
        .some((el) => (el.textContent ?? '').trim() === 'Connect your account' && !el.disabled);
      return text.includes(${JSON.stringify(CONNECTION_NAME)}) && text.includes('Not connected') && hasConnectButton;
    })()`,
    { timeoutMs: 60_000, label: "not connected connection detail" },
  );
}

async function clickExactButton(ctx: FlowContext, label: string): Promise<void> {
  // Lifecycle buttons disable briefly while a connect/disconnect settles, so
  // wait for the enabled button instead of failing on a race.
  await ctx.waitFor(
    `Boolean([...document.querySelectorAll('button')]
      .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)} && !el.disabled))`,
    { timeoutMs: 30_000, label: `enabled button: ${label}` },
  );
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)} && !el.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked === true, `Could not click ${label}.`);
}

async function waitForNoExactButton(ctx: FlowContext, label: string): Promise<void> {
  await ctx.waitFor(
    `!Boolean([...document.querySelectorAll('button')]
      .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)}))`,
    { timeoutMs: 90_000, label: `button removed: ${label}` },
  );
}

function startMockServer(): void {
  if (!MOCK_SELF_HOSTED) return;
  if (state.mockChild) return;
  const child = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: String(MOCK_PORT),
      ISSUER: MOCK_PUBLIC_URL,
      AUTO_APPROVE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    state.mockOutput += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    state.mockOutput += String(chunk);
  });
  child.on("exit", () => {
    if (state.mockChild === child) state.mockChild = null;
  });
  state.mockChild = child;
}

function stopMockServer(): void {
  const child = state.mockChild;
  if (!child) return;
  state.mockChild = null;
  child.kill("SIGTERM");
}

process.once("exit", stopMockServer);

async function waitForMockHealth(ctx: FlowContext): Promise<void> {
  let last: unknown = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${MOCK_CONTROL_URL}/health`).catch(() => null);
    if (response?.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.ok === true) {
        if (Object.prototype.hasOwnProperty.call(body, "autoApprove")) {
          ctx.assert(body.autoApprove !== false, "Mock server must auto-approve (AUTO_APPROVE=1) for this flow.");
        }
        return;
      }
      last = body;
    } else {
      last = response ? `HTTP ${response.status}` : "unreachable";
    }
    await sleep(500);
  }
  ctx.assert(false, `Mock OAuth+MCP server not reachable at ${MOCK_CONTROL_URL}. Last: ${bodyPreview(last)} Output: ${state.mockOutput.slice(-1_000)}`);
}

async function readMockRequests(): Promise<MockAuthorizeRequest[]> {
  const response = await fetch(`${MOCK_CONTROL_URL}/requests`);
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Mock request log failed: ${response.status}`);
  return parseMockRequests(body);
}

async function waitForMockAuthorizeRequest(ctx: FlowContext, clickedAt: string): Promise<void> {
  let authorizeRequest: MockAuthorizeRequest | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !authorizeRequest) {
    const requests = await readMockRequests();
    authorizeRequest = requests.find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= clickedAt) ?? null;
    if (!authorizeRequest) await sleep(500);
  }
  ctx.assert(Boolean(authorizeRequest), "No GET /authorize reached the mock IdP after the desktop Connect click.");
  if (!authorizeRequest) throw new Error("No GET /authorize reached the mock IdP after the desktop Connect click.");
  const params = new URL(authorizeRequest.url, MOCK_CONTROL_URL).searchParams;
  ctx.assert(Boolean(params.get("state")), "Authorize request is missing signed state.");
  ctx.assert(Boolean(params.get("client_id")), "Authorize request is missing dynamic client_id.");
  // New connections use the deployment-wide shared callback (connection routing
  // travels in the signed state); legacy rows keep the per-connection path.
  const redirectUri = params.get("redirect_uri") ?? "";
  ctx.assert(
    redirectUri.includes("/v1/mcp-connections/")
      && (redirectUri.includes("/oauth/callback") || redirectUri.includes(requireStateString(state.connectionId, "connection id"))),
    `Authorize redirect_uri was not an OpenWork MCP connection callback: ${redirectUri}`,
  );
}

async function memberUsableConnection(ctx: FlowContext): Promise<ConnectionSummary | null> {
  const result = await denApiFetch("/v1/mcp-connections?scope=usable", {
    headers: { authorization: `Bearer ${requireStateString(state.memberSession, "member session")}` },
  });
  ctx.assert(result.response.ok, `Member usable connection list failed: ${result.response.status} ${bodyPreview(result.body).slice(0, 300)}`);
  return parseConnections(result.body).find((entry) => entry.id === state.connectionId) ?? null;
}

async function waitForMemberConnection(ctx: FlowContext, label: string, timeoutMs: number, predicate: (connection: ConnectionSummary) => boolean): Promise<ConnectionSummary> {
  let last: ConnectionSummary | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = await memberUsableConnection(ctx);
    if (last && predicate(last)) return last;
    await sleep(1_000);
  }
  ctx.assert(false, `${label} did not settle. Last member-usable connection: ${bodyPreview(last)}`);
  throw new Error(`${label} did not settle.`);
}

export default defineFlow({
  id: "org-connection-lifecycle-desktop",
  title: "Desktop Extensions: connect, reconnect, and disconnect a per-member org connection",
  kind: "user-facing",
  spec: "evals/voiceovers/org-connection-lifecycle-desktop.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup: mock provider + per-member org connection",
      run: async (ctx) => {
        startMockServer();
        await waitForMockHealth(ctx);

        state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
        await ensureMember(ctx);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${requireStateString(state.adminSession, "admin session")}` },
        });
        ctx.assert(existing.response.ok, `Could not list manageable connections: ${existing.response.status} ${bodyPreview(existing.body).slice(0, 300)}`);
        for (const connection of parseConnections(existing.body)) {
          if (connection.name.startsWith("Meeting Notes ")) {
            const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${requireStateString(state.adminSession, "admin session")}` },
            });
            ctx.assert(removed.response.ok, `Stale connection cleanup failed for ${connection.id}: ${removed.response.status}`);
          }
        }

        const created = await denApiFetch("/v1/mcp-connections", {
          method: "POST",
          headers: { authorization: `Bearer ${requireStateString(state.adminSession, "admin session")}` },
          body: JSON.stringify({
            name: CONNECTION_NAME,
            url: `${MOCK_PUBLIC_URL}/mcp`,
            authType: "oauth",
            credentialMode: "per_member",
            access: { orgWide: true },
          }),
        });
        ctx.assert(created.response.ok, `Connection create failed: ${created.response.status} ${bodyPreview(created.body).slice(0, 300)}`);
        state.connectionId = readStringField(created.body, "id");
        ctx.assert(Boolean(state.connectionId), `Connection create did not return id: ${bodyPreview(created.body).slice(0, 300)}`);

        const mine = await memberUsableConnection(ctx);
        ctx.assert(Boolean(mine), "Member cannot see the org-wide connection.");
        ctx.assert(mine?.connectedForMe === false, "Member's account should not be connected at flow start.");
      },
    },
    {
      name: "Desktop boots and signs in as the member",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000 });
        await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
        // The app derives its /api/den proxy base from these URLs, so both must
        // point at the web origin (den-web proxies /api/den/* to den-api; the
        // bare den-api origin does not serve that prefix).
        const bootstrap = { baseUrl: DEN_WEB_URL, apiBaseUrl: DEN_WEB_URL, requireSignin: false, handoff: null };
        const written = await ctx.eval(`(async () => {
          const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
          if (!bridge) return { ok: false };
          await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
          return { ok: true };
        })()`, { awaitPromise: true });
        ctx.assert(isRecord(written) && written.ok === true, "Failed to write desktop bootstrap config.");
        await ctx.eval(`(() => {
          localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(DEN_WEB_URL)});
          localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(DEN_WEB_URL)});
          let prefs = {};
          try { prefs = JSON.parse(localStorage.getItem('openwork.preferences') || '{}'); } catch {}
          localStorage.setItem('openwork.preferences', JSON.stringify({ ...prefs, selectedAgent: 'openwork' }));
          return true;
        })()`);
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after bootstrap reload" });

        const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
          method: "POST",
          headers: { authorization: `Bearer ${requireStateString(state.memberSession, "member session")}` },
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        const grant = readStringField(handoff.body, "grant");
        ctx.assert(handoff.response.ok && Boolean(grant), `Handoff create failed: ${handoff.response.status} ${bodyPreview(handoff.body).slice(0, 300)}`);
        await ctx.waitFor(
          "Boolean(window.__openworkControl?.listActions?.().some((a) => a.id === 'auth.exchange-grant'))",
          { timeoutMs: 60_000, label: "auth.exchange-grant action registered" },
        );
        await ctx.control("auth.exchange-grant", { grant: requireStateString(grant, "desktop handoff grant"), baseUrl: DEN_WEB_URL });
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 45_000, label: "persisted den auth token" });
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", { timeoutMs: 60_000, label: "active org resolved" });
        await createFreshEvalWorkspace(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Extensions lists the org connection under Needs your sign-in, and its detail page shows an honest Not connected status with a Connect your account button", {
          voiceover: vo[0],
          action: async () => {
            await openExtensionsConnections(ctx);
            await waitForConnectionCard(ctx);
            await ctx.expectText("NEEDS YOUR SIGN-IN", { timeoutMs: 30_000 });
            await openConnectionDetail(ctx);
            await waitForNotConnectedDetail(ctx);
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME, { timeoutMs: 30_000 });
            await ctx.expectText("Not connected", { timeoutMs: 30_000 });
            await ctx.expectText("OAuth required", { timeoutMs: 30_000 });
            await ctx.expectText("Connect your account", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "lifecycle-1-needs-signin",
            claim: "The org connection is listed as needing sign-in and its detail page is honestly not connected.",
            requireText: [CONNECTION_NAME, "Not connected", "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Clicking Connect hands off to the browser: the mock identity provider receives the authorization request started by the desktop", {
          voiceover: vo[1],
          action: async () => {
            state.connectClickedAt = new Date().toISOString();
            await clickExactButton(ctx, "Connect your account");
          },
          assert: async () => {
            await waitForMockAuthorizeRequest(ctx, requireStateString(state.connectClickedAt, "connect click timestamp"));
          },
          screenshot: {
            name: "lifecycle-2-browser-handoff",
            claim: "The mock OAuth provider saw the desktop-started authorization request.",
            requireText: [CONNECTION_NAME],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The detail page flips to Connected on its own after the browser sign-in — no reload — and shows it is the member's own account", {
          voiceover: vo[2],
          assert: async () => {
            await ctx.waitFor("document.body.innerText.includes('Connected with your own account.')", { timeoutMs: 90_000, label: "connected detail description" });
            await waitForNoExactButton(ctx, "Connect your account");
            const connected = await waitForMemberConnection(
              ctx,
              "member connection connected",
              90_000,
              (entry) => entry.connectedForMe === true && typeof entry.connectedAt === "string" && entry.connectedAt.length > 0,
            );
            state.firstConnectedAt = requireStateString(connected.connectedAt, "first connectedAt");
          },
          screenshot: {
            name: "lifecycle-3-connected",
            claim: "The detail page updated itself to the member-owned connected state.",
            requireText: [CONNECTION_NAME, "Connected with your own account."],
            rejectText: ["Connect your account", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The connected detail page now offers both Reconnect and Disconnect", {
          voiceover: vo[3],
          action: async () => {
            // Bring the lifecycle action row into view and focus it so this
            // frame is visibly about the actions (and not a byte-for-byte
            // duplicate of the connected summary in frame 3).
            await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')]
                .find((el) => (el.textContent ?? '').trim() === 'Reconnect');
              button?.scrollIntoView({ block: 'center' });
              button?.focus({ focusVisible: true });
              return Boolean(button);
            })()`);
          },
          assert: async () => {
            const hasActions = await ctx.eval(`(() => {
              const labels = new Set([...document.querySelectorAll('button')]
                .filter((el) => !el.disabled)
                .map((el) => (el.textContent ?? '').trim()));
              return labels.has('Reconnect') && labels.has('Disconnect');
            })()`);
            ctx.assert(hasActions === true, "Connected detail page did not expose both Reconnect and Disconnect.");
            await ctx.expectText("Connected", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "lifecycle-4-lifecycle-actions",
            claim: "The connected detail page exposes Reconnect and Disconnect lifecycle actions.",
            requireText: ["Reconnect", "Disconnect"],
            rejectText: ["Something went wrong"],
            // The connected detail page fits one viewport, so a page capture
            // would be byte-identical to frame 3. Capture the sandbox desktop
            // instead (real window on a real display) when available.
            sandboxCapture: Boolean(process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim()),
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Reconnect runs a fresh OAuth round trip and Den records a new authorization timestamp", {
          voiceover: vo[4],
          action: async () => {
            state.reconnectClickedAt = new Date().toISOString();
            await clickExactButton(ctx, "Reconnect");
          },
          assert: async () => {
            await waitForMockAuthorizeRequest(ctx, requireStateString(state.reconnectClickedAt, "reconnect click timestamp"));
            const reconnected = await waitForMemberConnection(
              ctx,
              "member connection reconnected",
              90_000,
              (entry) => entry.connectedForMe === true && typeof entry.connectedAt === "string" && entry.connectedAt.length > 0 && entry.connectedAt !== state.firstConnectedAt,
            );
            state.secondConnectedAt = requireStateString(reconnected.connectedAt, "second connectedAt");
            await ctx.waitFor("document.body.innerText.includes('Connected with your own account.')", { timeoutMs: 90_000, label: "reconnected detail description" });
          },
          screenshot: {
            name: "lifecycle-5-reconnected",
            claim: "Reconnect completed a fresh OAuth round trip and left the detail page connected again.",
            requireText: [CONNECTION_NAME, "Connected with your own account."],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Disconnect removes the member's credential: Den reports it gone and the page returns to Connect your account", {
          voiceover: vo[5],
          action: async () => {
            await clickExactButton(ctx, "Disconnect");
          },
          assert: async () => {
            await waitForMemberConnection(
              ctx,
              "member connection disconnected",
              30_000,
              (entry) => entry.connectedForMe === false,
            );
            await waitForNotConnectedDetail(ctx);
            await ctx.waitFor("window.location.hash.includes('/settings/extensions/')", { timeoutMs: 30_000, label: "extensions detail route still open" });
          },
          screenshot: {
            name: "lifecycle-6-disconnected",
            claim: "Disconnect removed the member credential and returned the detail page to Connect your account.",
            requireText: [CONNECTION_NAME, "Not connected", "Connect your account"],
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
            headers: { authorization: `Bearer ${requireStateString(state.adminSession, "admin session")}` },
          });
          ctx.assert(removed.response.ok, `Cleanup delete failed: ${removed.response.status} ${bodyPreview(removed.body).slice(0, 300)}`);
        }
        stopMockServer();
      },
    },
  ],
});
