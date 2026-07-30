import { defineFlow } from "../runner/flow.ts";

const FLOW_ID = "cloud-web-connect-e2e";
const SIGN_IN_ORIGIN = "http://localhost:3005";
const CONNECTION_NAME = "Acme Mock Tools";
const ACTION_FILE = "eval-action.md";
const ACTION_CONTENT = "cloud-web-connect-e2e proof";
const LOOKUP_RECORD = "record-7";
const LOOKUP_OK_TEXT = `acme lookup ok: ${LOOKUP_RECORD}`;

const state = {
  denToken: "",
  org: null,
  cloudInstance: null,
  unauthenticatedCloudStatus: 0,
  clientToken: "",
  workspaceId: "",
  approvalId: "",
  connectionId: "",
  executedToolName: "",
  executeResultText: "",
  mockWitnessEntries: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimBase(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function required(ctx, name) {
  return ctx.env[name].trim();
}

function denBase(ctx) {
  return trimBase(required(ctx, "OPENWORK_EVAL_DEN_API_URL"));
}

function spaBase(ctx) {
  return trimBase(required(ctx, "OPENWORK_EVAL_SPA_URL"));
}

function mockBase(ctx) {
  return trimBase(required(ctx, "OPENWORK_EVAL_MOCK_URL"));
}

function instanceBase() {
  return trimBase(state.cloudInstance?.url);
}

function instanceUrl(path) {
  return `${instanceBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function hostHeaders(ctx) {
  return {
    "content-type": "application/json",
    "x-openwork-host-token": required(ctx, "OPENWORK_EVAL_INSTANCE_HOST_TOKEN"),
  };
}

function clientHeaders() {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${state.clientToken}`,
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value).slice(0, 1_200);
  } catch {
    return String(value).slice(0, 1_200);
  }
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${safeJson(actual)}`}`);
}

function recordOutput(ctx, name, value) {
  ctx.output(name, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

async function fetchJson(url, options = {}) {
  const { response, text } = await fetchText(url, options);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function denFetch(ctx, path, options = {}) {
  return fetchJson(`${denBase(ctx)}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: SIGN_IN_ORIGIN,
      ...(options.headers ?? {}),
    },
  });
}

async function instanceFetchJson(path, options = {}) {
  return fetchJson(instanceUrl(path), options);
}

async function navigateAbsolute(ctx, url, timeoutMs = 90_000) {
  await ctx.eval(`location.href = ${JSON.stringify(url)}`);
  await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
    timeoutMs,
    label: `loaded ${url}`,
  });
}

async function clearDenBrowserSession(ctx) {
  await ctx.eval(`(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("openwork.den.")) localStorage.removeItem(key);
    }
    localStorage.removeItem("openwork:web:auth-token");
    return true;
  })()`);
}

function denBrowserBase(ctx) {
  const override = process.env.OPENWORK_EVAL_DEN_BROWSER_URL?.trim();
  return override || denBase(ctx);
}

async function seedDenSession(ctx) {
  const org = state.org;
  witness(ctx, Boolean(state.denToken), "The Den session token is available before browser seeding");
  witness(ctx, Boolean(org?.id), "The active organization is available before browser seeding", org);
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(denBrowserBase(ctx))});
    localStorage.setItem("openwork.den.authToken", ${JSON.stringify(state.denToken)});
    localStorage.setItem("openwork.den.activeOrgId", ${JSON.stringify(org.id)});
    localStorage.setItem("openwork.den.activeOrgSlug", ${JSON.stringify(org.slug ?? "")});
    localStorage.setItem("openwork.den.activeOrgName", ${JSON.stringify(org.name ?? "")});
    return true;
  })()`);
}

async function signIn(ctx) {
  const signInResult = await denFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({
      email: required(ctx, "OPENWORK_EVAL_DEN_EMAIL"),
      password: required(ctx, "OPENWORK_EVAL_DEN_PASSWORD"),
    }),
  });
  witness(ctx, signInResult.response.ok, "Admin email/password sign-in returns HTTP 200", {
    status: signInResult.response.status,
    body: signInResult.body,
  });
  const token = typeof signInResult.body?.token === "string" ? signInResult.body.token.trim() : "";
  witness(ctx, token.length > 0, "Admin sign-in response includes a bearer token");
  state.denToken = token;
}

async function resolveSignedInOrg(ctx) {
  const orgsResult = await denFetch(ctx, "/v1/me/orgs", {
    headers: bearer(state.denToken),
  });
  witness(ctx, orgsResult.response.ok, "Signed-in admin can read /v1/me/orgs", {
    status: orgsResult.response.status,
    body: orgsResult.body,
  });
  const orgs = Array.isArray(orgsResult.body?.orgs) ? orgsResult.body.orgs : [];
  const org = orgs[0] ?? null;
  witness(ctx, Boolean(org?.id), "The signed-in admin belongs to an organization", orgsResult.body);
  witness(ctx, org.name === required(ctx, "OPENWORK_EVAL_ORG_NAME"), "The active organization display name matches the eval org", {
    expected: required(ctx, "OPENWORK_EVAL_ORG_NAME"),
    actual: org.name,
  });
  state.org = org;
}

async function waitForOnboarding(ctx) {
  try {
    await ctx.waitForRoute("/onboarding", { timeoutMs: 60_000 });
  } catch {
    await ctx.waitFor("location.pathname === '/onboarding' || location.hash.replace(/^#/, '').startsWith('/onboarding')", {
      timeoutMs: 60_000,
      label: "onboarding route",
    });
  }
}

async function pollCloudInstance(ctx) {
  const deadline = Date.now() + 180_000;
  let last = null;
  while (Date.now() < deadline) {
    const result = await denFetch(ctx, "/v1/cloud/instance", {
      headers: bearer(state.denToken),
    });
    last = { status: result.response.status, body: result.body };
    if (result.response.ok && result.body?.status === "ready" && typeof result.body.url === "string" && result.body.url.trim()) {
      state.cloudInstance = { ...result.body, url: trimBase(result.body.url) };
      return;
    }
    if ([401, 403, 404].includes(result.response.status)) {
      witness(ctx, false, "Authenticated cloud instance lookup is allowed and available", last);
    }
    await sleep(5_000);
  }
  witness(ctx, false, "Cloud instance became ready within 3 minutes", last);
}

async function extractClientToken(ctx) {
  const root = await fetchText(instanceUrl("/"));
  witness(ctx, root.response.ok, "The Cloud instance root HTML is fetchable", { status: root.response.status });
  const match = root.text.match(/window\.__OPENWORK_BOOTSTRAP__\s*=\s*(\{[^<]+?\})\s*<\/script>/);
  witness(ctx, Boolean(match), "The instance HTML includes __OPENWORK_BOOTSTRAP__", root.text.slice(0, 500));
  const bootstrap = JSON.parse(match[1]);
  const token = typeof bootstrap?.token === "string" ? bootstrap.token.trim() : "";
  witness(ctx, token.length > 0, "The bootstrap JSON includes a client token");
  state.clientToken = token;
}

function pickWorkspace(payload) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.workspaces)
      ? payload.workspaces
      : Array.isArray(payload)
        ? payload
        : [];
  return items.find((workspace) => workspace.id === payload?.activeId) ?? items[0] ?? null;
}

async function resolveWorkspace(ctx) {
  const workspaces = await instanceFetchJson("/workspaces", { headers: clientHeaders() });
  witness(ctx, workspaces.response.ok, "The instance client token can list workspaces", {
    status: workspaces.response.status,
    body: workspaces.body,
  });
  const workspace = pickWorkspace(workspaces.body);
  witness(ctx, Boolean(workspace?.id), "The Cloud instance exposes a workspace id", workspaces.body);
  state.workspaceId = workspace.id;
}

async function waitForFileWriteApproval(ctx) {
  const deadline = Date.now() + 30_000;
  let last = null;
  while (Date.now() < deadline) {
    const approvals = await instanceFetchJson("/approvals", { headers: hostHeaders(ctx) });
    last = { status: approvals.response.status, body: approvals.body };
    witness(ctx, approvals.response.ok, "The host token can list pending approvals", last);
    const items = Array.isArray(approvals.body?.items) ? approvals.body.items : [];
    const approval = items.find((item) =>
      item.workspaceId === state.workspaceId
      && item.action === "workspace.file.write"
      && typeof item.summary === "string"
      && item.summary.includes(ACTION_FILE)
    ) ?? items.find((item) => typeof item.summary === "string" && item.summary.includes(ACTION_FILE));
    if (approval?.id) return approval;
    await sleep(500);
  }
  witness(ctx, false, "A pending approval appears for the eval file write", last);
}

async function approveFileWrite(ctx, approval) {
  const approved = await instanceFetchJson(`/approvals/${encodeURIComponent(approval.id)}`, {
    method: "POST",
    headers: hostHeaders(ctx),
    body: JSON.stringify({ reply: "allow" }),
  });
  witness(ctx, approved.response.ok && approved.body?.ok === true && approved.body?.allowed === true, "The host token approves the pending file write", {
    status: approved.response.status,
    body: approved.body,
  });
  state.approvalId = approval.id;
}

async function performApprovedFileWrite(ctx) {
  await extractClientToken(ctx);
  await resolveWorkspace(ctx);

  const controller = new AbortController();
  const writePromise = instanceFetchJson(`/workspace/${encodeURIComponent(state.workspaceId)}/files/content`, {
    method: "POST",
    headers: clientHeaders(),
    signal: controller.signal,
    body: JSON.stringify({
      path: ACTION_FILE,
      content: ACTION_CONTENT,
      force: true,
    }),
  }).catch((error) => ({ error }));

  await sleep(2_000);
  const approval = await waitForFileWriteApproval(ctx).catch((error) => {
    controller.abort();
    throw error;
  });
  await approveFileWrite(ctx, approval);

  const write = await writePromise;
  witness(ctx, !write.error, "The file write request completes after approval", write.error?.message);
  witness(ctx, write.response.ok && write.body?.ok === true, "The approved file write returns ok:true", {
    status: write.response.status,
    body: write.body,
  });

  const read = await instanceFetchJson(`/workspace/${encodeURIComponent(state.workspaceId)}/files/content?path=${encodeURIComponent(ACTION_FILE)}`, {
    headers: clientHeaders(),
  });
  witness(ctx, read.response.ok && read.body?.content === ACTION_CONTENT, "The written file can be read back from the Cloud instance", {
    status: read.response.status,
    body: read.body,
  });
  recordOutput(ctx, "approved-file-write.json", {
    workspaceId: state.workspaceId,
    approvalId: state.approvalId,
    path: ACTION_FILE,
    content: read.body?.content,
  });
}

async function listManageableConnections(ctx) {
  const list = await denFetch(ctx, "/v1/mcp-connections?scope=manageable", {
    headers: bearer(state.denToken),
  });
  witness(ctx, list.response.ok, "Admin can list manageable MCP connections", {
    status: list.response.status,
    body: list.body,
  });
  return Array.isArray(list.body?.connections) ? list.body.connections : [];
}

function matchingMockConnection(connection, mockUrl) {
  return connection?.name === CONNECTION_NAME
    && connection?.url === `${mockUrl}/mcp`
    && connection?.authType === "none";
}

async function ensureMockMcpConnection(ctx) {
  const mockUrl = mockBase(ctx);
  const existing = (await listManageableConnections(ctx)).find((connection) => matchingMockConnection(connection, mockUrl));
  if (existing?.id) {
    state.connectionId = existing.id;
    recordOutput(ctx, "mock-mcp-connection.json", existing);
    return;
  }

  const created = await denFetch(ctx, "/v1/mcp-connections", {
    method: "POST",
    headers: bearer(state.denToken),
    body: JSON.stringify({
      name: CONNECTION_NAME,
      url: `${mockUrl}/mcp`,
      authType: "none",
      access: { orgWide: true },
    }),
  });
  if (created.response.ok && created.body?.id) {
    state.connectionId = created.body.id;
    recordOutput(ctx, "mock-mcp-connection.json", created.body);
    return;
  }

  const reusable = (await listManageableConnections(ctx)).find((connection) => matchingMockConnection(connection, mockUrl));
  witness(ctx, Boolean(reusable?.id), "A prior Acme Mock Tools connection can be reused after create conflict/validation", {
    createStatus: created.response.status,
    createBody: created.body,
    reusable,
  });
  state.connectionId = reusable.id;
  recordOutput(ctx, "mock-mcp-connection.json", reusable);
}

async function mockRequests(ctx) {
  const result = await fetchJson(`${mockBase(ctx)}/requests`);
  witness(ctx, result.response.ok, "The mock MCP witness log is readable", {
    status: result.response.status,
    body: result.body,
  });
  if (Array.isArray(result.body)) return result.body;
  if (Array.isArray(result.body?.requests)) return result.body.requests;
  if (Array.isArray(result.body?.entries)) return result.body.entries;
  return [];
}

async function mintMcpToken(ctx) {
  const result = await denFetch(ctx, "/v1/mcp/token", {
    method: "POST",
    headers: bearer(state.denToken),
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  witness(ctx, result.response.ok, "Admin can mint an agent MCP token", {
    status: result.response.status,
    body: result.body,
  });
  const token = typeof result.body?.token === "string" ? result.body.token.trim() : "";
  witness(ctx, token.length > 0, "The minted MCP token is present");
  return token;
}

async function mcpAgentCall(ctx, mcpToken, method, params = {}) {
  const response = await fetch(`${denBase(ctx)}/mcp/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const raw = await response.text();
  witness(ctx, response.ok, `MCP ${method} returned HTTP 200`, raw.slice(0, 500));
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  witness(ctx, Boolean(dataLine), `MCP ${method} returned a data frame`, raw.slice(0, 500));
  const payload = JSON.parse(dataLine.slice(5));
  witness(ctx, !payload.error, `MCP ${method} returned no JSON-RPC error`, payload.error ?? null);
  return payload.result;
}

function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("\n");
}

function parseToolJson(result) {
  const text = toolResultText(result).trim();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function schemaProperties(schema) {
  const properties = schema && typeof schema === "object" && !Array.isArray(schema) ? schema.properties : null;
  return properties && typeof properties === "object" && !Array.isArray(properties) ? Object.keys(properties) : [];
}

function schemaRequired(schema) {
  return schema && typeof schema === "object" && Array.isArray(schema.required)
    ? schema.required.filter((entry) => typeof entry === "string")
    : [];
}

function toolNameFromCapability(name) {
  const parts = String(name ?? "").split(":");
  return parts[parts.length - 1] ?? "";
}

function lookupBodyForMatch(match, toolName) {
  const properties = schemaProperties(match?.argumentsSchema);
  const requiredFields = schemaRequired(match?.argumentsSchema);
  const preferredLookupKeys = ["recordId", "record_id", "id", "record", "query"];
  const preferredEchoKeys = ["text", "message", "input"];
  if (toolName === "mock_echo") {
    const echoKey = preferredEchoKeys.find((key) => properties.includes(key)) ?? requiredFields[0] ?? properties[0] ?? "text";
    return { [echoKey]: LOOKUP_OK_TEXT };
  }
  const lookupKey = preferredLookupKeys.find((key) => properties.includes(key)) ?? requiredFields[0] ?? properties[0] ?? "recordId";
  return { [lookupKey]: LOOKUP_RECORD };
}

function selectMockCapability(matches) {
  const exactAcme = matches.find((match) => match?.name === `mcp:${state.connectionId}:acme_lookup`);
  const acme = exactAcme ?? matches.find((match) => toolNameFromCapability(match?.name) === "acme_lookup");
  if (acme) return acme;
  const exactEcho = matches.find((match) => match?.name === `mcp:${state.connectionId}:mock_echo`);
  return exactEcho ?? matches.find((match) => toolNameFromCapability(match?.name) === "mock_echo") ?? null;
}

function entryToolNames(entry) {
  return Array.isArray(entry?.toolNames) ? entry.toolNames.filter((name) => typeof name === "string") : [];
}

async function executeMockMcpThroughAgent(ctx) {
  const before = await mockRequests(ctx);
  const mcpToken = await mintMcpToken(ctx);
  const search = await mcpAgentCall(ctx, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "acme lookup records", limit: 10, type: "mcp" },
  });
  const parsedSearch = parseToolJson(search);
  const matches = Array.isArray(parsedSearch.matches) ? parsedSearch.matches : [];
  const match = selectMockCapability(matches);
  witness(ctx, Boolean(match?.name), "search_capabilities finds the mock MCP acme_lookup capability (or mock_echo fallback)", {
    connectionId: state.connectionId,
    matches: matches.map((entry) => ({ name: entry.name, summary: entry.summary, schemaDigest: entry.schemaDigest })),
  });

  const toolName = toolNameFromCapability(match.name);
  const executeArguments = {
    name: match.name,
    body: lookupBodyForMatch(match, toolName),
  };
  if (typeof match.schemaDigest === "string" && match.schemaDigest.trim()) {
    executeArguments.schemaDigest = match.schemaDigest;
  }

  const execute = await mcpAgentCall(ctx, mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: executeArguments,
  });
  state.executedToolName = toolName;
  state.executeResultText = toolResultText(execute);

  const after = await mockRequests(ctx);
  const newEntries = after.slice(before.length);
  state.mockWitnessEntries = newEntries.filter((entry) => entryToolNames(entry).includes(toolName));

  witness(ctx, after.length > before.length, "The mock MCP witness log grew after execute_capability", {
    before: before.length,
    after: after.length,
  });
  witness(ctx, state.mockWitnessEntries.length > 0, `A new mock MCP request names ${toolName}`, newEntries);
  witness(ctx, state.executeResultText.includes(LOOKUP_OK_TEXT), "The execute_capability result contains the Acme lookup proof text", state.executeResultText);
  recordOutput(ctx, "mock-mcp-witness.json", {
    toolName,
    executeResultText: state.executeResultText,
    entries: state.mockWitnessEntries,
  });
}

export default defineFlow({
  id: FLOW_ID,
  title: "Cloud web sign-in opens a real instance, completes an approved action, and executes a mock MCP through OpenWork Connect",
  kind: "user-facing",
  preserveTheme: true,
  requiresApp: true,
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_SPA_URL",
    "OPENWORK_EVAL_MOCK_URL",
    "OPENWORK_EVAL_DEN_EMAIL",
    "OPENWORK_EVAL_DEN_PASSWORD",
    "OPENWORK_EVAL_ORG_NAME",
    "OPENWORK_EVAL_INSTANCE_HOST_TOKEN",
  ],
  steps: [
    {
      name: "Frame 1 — No app without sign-in",
      run: async (ctx) => {
        await ctx.prove("No app without sign-in.", {
          action: async () => {
            await navigateAbsolute(ctx, `${spaBase(ctx)}/`);
            await clearDenBrowserSession(ctx);
            await ctx.eval("location.reload()");
            await ctx.waitForText("Welcome to", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("Welcome to", { timeoutMs: 60_000 });
            await ctx.expectNoText("New session");
          },
          screenshot: {
            name: "frame-1-signin-gate",
            claim: "The web SPA shows the forced sign-in gate and the app shell is absent before authentication.",
            requireText: ["Welcome to"],
            rejectText: ["New session"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Admin signs in",
      run: async (ctx) => {
        await ctx.prove("Admin signs in.", {
          action: async () => {
            await signIn(ctx);
            await resolveSignedInOrg(ctx);
            await seedDenSession(ctx);
            await ctx.eval("location.reload()");
            // While Den auth is still verifying, app-root re-renders the forced
            // sign-in page, so wait for a POSITIVE settled surface: a negative
            // wait passes on the empty DOM right after reload and then the
            // capture lands on the "checking" flash. Which surface appears is
            // profile-dependent (first-run welcome vs a configured workspace),
            // so accept any of them.
            await ctx.waitFor(
              `["Use Without Cloud", "New session", "What do you need done?"].some((marker) => document.body.innerText.includes(marker))`,
              { timeoutMs: 60_000, label: "app past the sign-in gate" },
            );
          },
          assert: async () => {
            // Assert the session is genuinely usable, not which post-sign-in
            // screen the app picks: that depends on whether a workspace/server
            // is already configured in this browser profile, which made this
            // frame pass only on dirty profiles. Probed node-side because
            // ctx.eval does not await promises.
            const res = await fetch(`${denBase(ctx)}/v1/me`, {
              headers: { Authorization: `Bearer ${state.denToken}` },
            });
            const body = await res.json().catch(() => null);
            const email = body && body.user ? body.user.email : null;
            witness(ctx, res.status === 200, "Den accepts the signed-in admin session", { status: res.status });
            witness(ctx, email === required(ctx, "OPENWORK_EVAL_DEN_EMAIL"), "The session belongs to the signing-in admin", { email });
            const seeded = await ctx.eval(`(() => localStorage.getItem("openwork.den.authToken") !== null)()`);
            witness(ctx, seeded === true || seeded === "true", "The browser carries the Den session", { seeded });
            const gated = await ctx.hasText("Paste sign-in code");
            witness(ctx, gated === false, "The forced sign-in gate is no longer blocking the app", { gated });
          },
          screenshot: {
            name: "frame-2-signed-in",
            claim: "The admin's Den session is seeded into the browser and Den accepts it; the forced sign-in gate is gone.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Machine assigned after sign-in",
      run: async (ctx) => {
        await ctx.prove("A machine is assigned only after sign-in.", {
          action: async () => {
            const unauthenticated = await denFetch(ctx, "/v1/cloud/instance");
            state.unauthenticatedCloudStatus = unauthenticated.response.status;
            await pollCloudInstance(ctx);
            recordOutput(ctx, "cloud-instance.json", state.cloudInstance);
          },
          assert: async () => {
            witness(ctx, state.unauthenticatedCloudStatus === 401, "Unauthenticated cloud instance lookup returns 401", state.unauthenticatedCloudStatus);
            witness(ctx, state.cloudInstance?.status === "ready", "The authenticated cloud instance is ready", state.cloudInstance);
            witness(ctx, instanceBase().startsWith("https://") && instanceBase().includes("daytonaproxy"), "The Cloud instance URL is a Daytona HTTPS proxy URL", instanceBase());
          },
        });
      },
    },
    {
      name: "Frame 4 — Instance is full app",
      run: async (ctx) => {
        await ctx.prove("The instance is the full OpenWork app.", {
          action: async () => {
            await navigateAbsolute(ctx, instanceBase());
            await seedDenSession(ctx);
            // The instance build also forces sign-in; after seeding, land on the
            // session surface directly instead of whatever route the gate picks.
            await navigateAbsolute(ctx, `${instanceBase()}/session`);
            await ctx.waitFor("document.body.innerText.includes('What do you need done?') || document.body.innerText.includes('New session')", {
              timeoutMs: 90_000,
              label: "OpenWork app shell in Cloud instance",
            });
          },
          assert: async () => {
            const marker = await ctx.eval(`(() => {
              const text = document.body.innerText;
              if (text.includes("What do you need done?")) return "What do you need done?";
              if (text.includes("New session")) return "New session";
              return "";
            })()`);
            witness(ctx, marker === "What do you need done?" || marker === "New session", "The Cloud instance renders the OpenWork app shell", marker);
          },
          screenshot: {
            name: "frame-4-instance-app",
            claim: "The Cloud instance loads the full OpenWork app shell after the same signed-in organization session is restored.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5 — Approved file write action",
      run: async (ctx) => {
        await ctx.prove("Admin completes an action (approved file write).", {
          action: async () => {
            await performApprovedFileWrite(ctx);
          },
          assert: async () => {
            witness(ctx, Boolean(state.workspaceId), "The action ran against a Cloud workspace", state.workspaceId);
            witness(ctx, Boolean(state.approvalId), "The file write exercised the approvals system before completing", state.approvalId);
          },
        });
      },
    },
    {
      name: "Frame 6 — Mock MCP appears in Connect",
      run: async (ctx) => {
        await ctx.prove("The org's mock MCP appears in Connect, in the instance.", {
          action: async () => {
            await ensureMockMcpConnection(ctx);
            await navigateAbsolute(ctx, instanceUrl("/settings/connect"));
            // The Den availability probe can latch "unavailable" if its first
            // request raced the cold tunnel; the banner's Refresh retries it.
            // The org-connections hook fetches once on mount and renders a
            // stale "Failed to fetch" without retrying, and the availability
            // probe can latch "unavailable" when its first request races a
            // cold connection. Reload until a mount succeeds end to end.
            for (let round = 0; round < 8; round += 1) {
              await new Promise((resolve) => setTimeout(resolve, 8000));
              let pageState = "";
              try {
                pageState = String(await ctx.eval(`(() => {
                  const text = document.body.innerText || "";
                  if (text.includes(${JSON.stringify(CONNECTION_NAME)})) return "ready";
                  if (text.includes("Failed to fetch") || text.includes("temporarily unavailable")) return "stale";
                  return "pending";
                })()`));
              } catch {
                continue;
              }
              if (pageState === "ready") break;
              if (pageState === "stale") {
                try { await ctx.eval("location.reload()"); } catch {}
              }
            }
          },
          assert: async () => {
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 60_000 });
            await ctx.waitForText("Connected to", { timeoutMs: 60_000 });
          },
          screenshot: {
            name: "frame-6-connect",
            claim: "Settings > Connect in the Cloud instance shows the org-wide Acme Mock Tools MCP connection.",
            requireText: [CONNECTION_NAME],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7 — Mock MCP executes through Connect",
      run: async (ctx) => {
        await ctx.prove("The mock MCP provably executes through OpenWork Connect.", {
          action: async () => {
            await executeMockMcpThroughAgent(ctx);
          },
          assert: async () => {
            witness(ctx, state.mockWitnessEntries.length > 0, "The mock MCP witness log captured the executed tool", state.mockWitnessEntries);
            witness(ctx, state.executeResultText.includes(LOOKUP_OK_TEXT), "The OpenWork Connect execution returned the Acme lookup proof", state.executeResultText);
          },
          // No screenshot: the execution is node-side and the Connect view is
          // visually identical to frame 6 (the runner rejects duplicate
          // frames). The witness is the recorded mock request log + result.
        });
      },
    },
  ],
});
