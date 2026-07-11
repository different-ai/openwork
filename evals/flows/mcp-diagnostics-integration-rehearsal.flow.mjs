/**
 * Rehearses all three MCP diagnostic levels as one six-step operator journey:
 *
 *   1. An unreachable endpoint names the network phase, owner, and safe reference.
 *   2. A ServiceNow-style OAuth connection completes through Den's real callback.
 *   3. Test connection proves protocol and complete catalog readiness read-only.
 *   4. Live diagnostics preserve Authorized and isolate an MCP version mismatch.
 *   5. Retrying after repair reaches Catalog Ready without claiming an operation.
 *   6. A bounded read-only tool call through /mcp/agent is denied by provider policy
 *      while connection/catalog health remains independently true.
 *
 * Start the deterministic fixture beside the isolated Den with:
 *   DISABLE_DCR=1 MCP_MOCK_DIAGNOSTICS_KEY=rehearsal-key \
 *     pnpm dev:mcp-diagnostic -- --profile servicenow
 *
 * The operation fault is enabled only for the final tools/call, so OAuth,
 * initialize, and paginated tools/list remain healthy for the earlier levels.
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  mcpAgentCall,
  mintMcpToken,
  openAdminConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

const FLOW_ID = "mcp-diagnostics-integration-rehearsal";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_DIAGNOSTICS_KEY = process.env.MCP_MOCK_DIAGNOSTICS_KEY?.trim() || null;
const MOCK_CLIENT_ID = process.env.MOCK_CLIENT_ID?.trim() || "mock-preregistered-client";
const MOCK_CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET?.trim() || "mock-preregistered-secret";
const UNREACHABLE_MCP_URL = process.env.MCP_DIAGNOSTIC_UNREACHABLE_URL?.trim()
  || "http://127.0.0.1:65534/mcp";
const RUN_ID = Date.now();
const UNREACHABLE_NAME = `rehearsal-unreachable-${RUN_ID}`;
const SERVICENOW_NAME = `rehearsal-servicenow-${RUN_ID}`;
const SAFE_READ_TOOL = "look_up_incident_records";
const SAFE_READ_ARGS = { query: "active=true^ORDERBYDESCsys_updated_on", limit: 1 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configuredMockPort() {
  const explicit = process.env.MCP_DIAGNOSTIC_MOCK_PORT?.trim();
  const isolated = process.env.OPENWORK_EXTRA_APP_PORTS?.split(",")[0]?.trim();
  const raw = explicit || isolated || "3978";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MCP diagnostic mock port: ${JSON.stringify(raw)}.`);
  }
  return port;
}

function mockServerOrigin() {
  const explicit = process.env.MOCK_DIAGNOSTIC_MCP_URL?.trim()
    || process.env.MOCK_OAUTH_MCP_URL?.trim();
  if (explicit) return new URL(explicit).origin;
  return `http://127.0.0.1:${configuredMockPort()}`;
}

const MOCK_ORIGIN = mockServerOrigin();
const state = {
  adminSession: null,
  mcpToken: null,
  mockHealth: null,
  stableProtocolVersion: null,
  mockRequestBaseline: 0,
  connectionTestRequestBaseline: 0,
  connectionTestRequests: [],
  unreachableConnectionId: null,
  serviceNowConnectionId: null,
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function witness(ctx, condition, assertion, actual) {
  ctx.assert(condition, assertion);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function toolJson(result) {
  const text = result?.content?.find((entry) => entry?.type === "text")?.text ?? "{}";
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: { raw: text } };
  }
}

async function configureMock(path, body) {
  const response = await fetch(`${MOCK_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(MOCK_DIAGNOSTICS_KEY ? { "x-mock-diagnostics-key": MOCK_DIAGNOSTICS_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Mock configuration ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function mockRequests() {
  const response = await fetch(`${MOCK_ORIGIN}/requests`, {
    headers: { "x-mock-diagnostics-key": MOCK_DIAGNOSTICS_KEY },
  });
  if (!response.ok) throw new Error(`Reading the protected mock request log failed: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.requests) ? body.requests : [];
}

async function authenticatedApi(path, options = {}) {
  return denApiFetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.adminSession}`,
      ...(options.headers ?? {}),
    },
  });
}

function rowScript(connectionName, input) {
  return `(() => {
    const row = [...document.querySelectorAll('[data-testid="mcp-connection-row"]')]
      .find((candidate) => candidate.dataset.connectionName === ${JSON.stringify(connectionName)}
        && (!${JSON.stringify(input.connectionId ?? null)} || candidate.dataset.connectionId === ${JSON.stringify(input.connectionId ?? "")}));
    if (!row) return false;
    const text = row.textContent ?? '';
    if (${JSON.stringify(input.contains ?? null)} && text.includes(${JSON.stringify(input.contains ?? "")})) {
      row.scrollIntoView({ block: 'center' });
      return true;
    }
    const button = [...row.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(input.button ?? "")});
    if (!${JSON.stringify(Boolean(input.button))} || !button) return false;
    row.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`;
}

async function submitAddConnection(ctx, actionLabel = "Add connection") {
  const prepared = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(actionLabel)} && entry.getClientRects().length > 0);
    if (!button || button.disabled) return false;
    button.id = 'fraimz-submit-mcp-connection';
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  })()`);
  witness(ctx, prepared, "The enabled Add connection action is available in the viewport.");
  await ctx.waitFor(`(() => {
    const button = document.querySelector('#fraimz-submit-mcp-connection');
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })()`, { timeoutMs: 5_000, label: "Add connection button in viewport" });
  await ctx.trustedClick("#fraimz-submit-mcp-connection", { timeoutMs: 20_000 });
}

async function refreshConnectionsPage(ctx) {
  await ctx.eval("(() => { window.location.reload(); return true; })()");
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Connections page reload" });
  await openAdminConnections(ctx);
  await ctx.waitForText("Add a connection", { timeoutMs: 30_000 });
}

async function connectionIdNamed(name) {
  const listed = await authenticatedApi("/v1/mcp-connections?scope=manageable");
  if (!listed.response.ok) throw new Error(`Listing manageable MCP connections failed: ${listed.response.status}`);
  return (listed.body.connections ?? []).find((entry) => entry.name === name)?.id ?? null;
}

async function removePriorRehearsalConnections(ctx) {
  const listed = await authenticatedApi("/v1/mcp-connections?scope=manageable");
  if (!listed.response.ok) {
    throw new Error(`Listing prior rehearsal connections failed: ${listed.response.status}`);
  }
  const staleConnections = (listed.body.connections ?? []).filter((connection) => (
    typeof connection?.name === "string"
    && (connection.name.startsWith("rehearsal-unreachable-")
      || connection.name.startsWith("rehearsal-servicenow-"))
  ));
  const removals = await Promise.all(staleConnections.map((connection) => (
    authenticatedApi(`/v1/mcp-connections/${connection.id}`, { method: "DELETE" })
  )));
  witness(
    ctx,
    removals.every((result) => result.response.ok),
    "The replay removes prior synthetic rehearsal connections before capturing new evidence.",
    { removedCount: staleConnections.length },
  );
}

async function deleteConnection(connectionId, ctx, label) {
  if (!connectionId) return;
  const removed = await authenticatedApi(`/v1/mcp-connections/${connectionId}`, { method: "DELETE" });
  witness(ctx, removed.response.ok, `${label} is removed after its part of the proof.`, {
    connectionId,
    status: removed.response.status,
  });
}

async function assertDiagnosticRedaction(ctx, assertion) {
  const text = await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]')?.textContent ?? ''");
  const leaked = /mock-(?:access|refresh|code)|MCP-Session-Id|Synthetic printer|Bearer\s+[A-Za-z0-9._~-]+/i.test(text);
  witness(ctx, !leaked && !text.includes(MOCK_CLIENT_SECRET), assertion, { visibleCharacterCount: text.length });
}

export default {
  id: FLOW_ID,
  title: "Rehearse all three enterprise MCP diagnostic levels as one operator journey",
  kind: "user-facing",
  spec: "evals/voiceovers/mcp-diagnostics-integration-rehearsal.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "MCP_MOCK_DIAGNOSTICS_KEY"],
  steps: [
    {
      name: "Setup — verify the healthy ServiceNow fixture and sign in",
      run: async (ctx) => {
        const healthResponse = await fetch(`${MOCK_ORIGIN}/health`).catch(() => null);
        witness(ctx, Boolean(healthResponse?.ok), `The MCP diagnostic fixture is reachable at ${MOCK_ORIGIN}.`, {
          status: healthResponse?.status ?? null,
        });
        const health = await healthResponse.json();
        const contract = isRecord(health.fixtureContract) ? health.fixtureContract : {};
        const tokenMethods = Array.isArray(contract.tokenEndpointAuthMethods)
          ? contract.tokenEndpointAuthMethods
          : [];
        witness(
          ctx,
          health.ok === true
            && health.profile === "servicenow"
            && health.fault === "none"
            && health.operationFault === "none"
            && contract.mockRegistrationMode === "pre_registered",
          "The fixture starts as a healthy ServiceNow profile with a pre-registered confidential client; the operation fault is injected only in the final step.",
          {
            profile: health.profile,
            fault: health.fault,
            operationFault: health.operationFault,
            mockRegistrationMode: contract.mockRegistrationMode,
          },
        );
        witness(
          ctx,
          tokenMethods.includes("client_secret_post") && health.requestLogEnabled === true,
          "The ServiceNow profile advertises its production-style confidential client-secret token method.",
          { tokenMethods, requestLogEnabled: health.requestLogEnabled },
        );
        ctx.recordEvidence({
          type: "output",
          name: "ServiceNow registration fidelity boundary",
          text: JSON.stringify({
            providerRegistrationMode: contract.registrationMode,
            localProofRegistrationMode: contract.mockRegistrationMode,
            tokenEndpointAuthMethods: tokenMethods,
            limitation: "This proves OpenWork's pre-registered confidential-client ceremony against a deterministic synthetic ServiceNow contract; it does not claim conformance with a live customer tenant.",
          }, null, 2),
        });
        const protocols = Array.isArray(health.protocols)
          ? health.protocols.filter((entry) => typeof entry === "string" && entry.length > 0)
          : [];
        witness(ctx, protocols.length > 0, "The fixture advertises at least one stable recovery protocol.", protocols);
        state.mockHealth = health;
        state.stableProtocolVersion = protocols[0];
        await configureMock("/__mock/auto-approve", { autoApprove: true });
        await configureMock("/__mock/protocol-version", { protocolVersion: state.stableProtocolVersion });

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        witness(ctx, Boolean(state.adminSession), `The Den owner can sign in as ${ADMIN_EMAIL}.`);
        await removePriorRehearsalConnections(ctx);
        await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);

        const created = await authenticatedApi("/v1/mcp-connections", {
          method: "POST",
          body: JSON.stringify({
            name: UNREACHABLE_NAME,
            url: UNREACHABLE_MCP_URL,
            authType: "oauth",
            credentialMode: "shared",
            access: { orgWide: true, memberIds: [], teamIds: [] },
          }),
        });
        witness(
          ctx,
          created.response.ok && typeof created.body?.id === "string",
          "The deliberately unreachable OAuth connection is published without storing a credential.",
          { status: created.response.status },
        );
        state.unreachableConnectionId = created.body.id;
        await openAdminConnections(ctx);
        await ctx.waitForText(UNREACHABLE_NAME, { timeoutMs: 30_000 });
        await ctx.eval(rowScript(UNREACHABLE_NAME, { contains: "Diagnose", connectionId: state.unreachableConnectionId }));
        await sleep(1_500);
        await ctx.screenshot("mcp-rehearsal-setup-ready", {
          claim: "The replay begins with one deliberate synthetic failure target and no prior rehearsal rows.",
          requireText: ["Add a connection", UNREACHABLE_NAME, "Diagnose"],
          rejectText: ["rehearsal-servicenow-", MOCK_CLIENT_SECRET, "mock-access-token"],
        });
      },
    },
    {
      name: "Step 1 — isolate an unreachable endpoint to its owned network phase",
      run: async (ctx) => {
        await ctx.prove("The first failure is a named network layer with an owner and only safe evidence", {
          voiceover: vo[0],
          action: async () => {
            await openAdminConnections(ctx);
            await ctx.waitForText(UNREACHABLE_NAME, { timeoutMs: 30_000 });
            const clicked = await ctx.eval(rowScript(UNREACHABLE_NAME, { button: "Diagnose", connectionId: state.unreachableConnectionId }));
            witness(ctx, clicked, "The unreachable MCP row exposes the admin-only Diagnose action.");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]'))", {
              timeoutMs: 10_000,
              label: "unreachable diagnostic dialog",
            });
            await ctx.clickText("Run diagnostic", { timeoutMs: 10_000 });
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"mcp-diagnostic-first-failure\"]')?.textContent?.includes('Network Tcp')",
              { timeoutMs: 30_000, label: "network TCP failure" },
            );
          },
          assert: async () => {
            await ctx.expectText("Network Tcp");
            await ctx.expectText("Owner: Network Admin");
            await ctx.expectText("Action: Check Provider Allowlist And Listener");
            await ctx.expectNoText("fetch failed");
            await assertDiagnosticRedaction(ctx, "The network diagnostic contains no credential, session, or provider payload.");
            const timeline = await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-timeline\"]')?.textContent ?? ''");
            witness(
              ctx,
              /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)/i.test(timeline),
              "The redacted timeline retains a safe machine reference code for support correlation.",
              timeline,
            );
          },
          screenshot: {
            name: "mcp-rehearsal-network-owned-failure",
            claim: "An unreachable endpoint names Network TCP, assigns the network administrator, and shows redacted support evidence.",
            requireText: ["Network Tcp", "Owner: Network Admin", "Support evidence is strictly redacted"],
            rejectText: ["fetch failed", "mock-access", "MCP-Session-Id", "Bearer"],
          },
        });

        await ctx.trustedClick('button[aria-label="Close diagnostics"]', { timeoutMs: 10_000 });
        await deleteConnection(state.unreachableConnectionId, ctx, "The unreachable fixture connection");
        state.unreachableConnectionId = null;
        await refreshConnectionsPage(ctx);
      },
    },
    {
      name: "Step 2 — connect the ServiceNow-style OAuth server",
      run: async (ctx) => {
        await ctx.prove("The ordinary connection form completes the realistic ServiceNow-style OAuth path", {
          voiceover: vo[1],
          action: async () => {
            state.mockRequestBaseline = (await mockRequests()).length;
            await ctx.clickText("MCP server", { selector: "button", timeoutMs: 20_000 });
            await ctx.fill('input[placeholder="notion"]', SERVICENOW_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', state.mockHealth.resource);
            const selected = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')]
                .find((entry) => (entry.textContent ?? '').trim() === 'One org account');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, selected, "The ServiceNow-style connection is configured as one organization account.");
            await ctx.clickText("This server needs a pre-registered OAuth app", { timeoutMs: 10_000 });
            await ctx.fill('input[placeholder="1234567890.1234567890123"]', MOCK_CLIENT_ID);
            await ctx.fill('input[placeholder="Client secret"]', MOCK_CLIENT_SECRET);
            await submitAddConnection(ctx, "Create and show redirect URL");
            await ctx.waitForText("Almost done — add this redirect URL to your app", { timeoutMs: 20_000 });
            const callback = await ctx.eval(`(() => {
              const values = [...document.querySelectorAll('p')]
                .map((element) => (element.textContent ?? '').trim())
                .filter((text) => text.startsWith('http') && text.includes('/connect/callback'));
              return values[0] ?? null;
            })()`);
            witness(ctx, typeof callback === "string", "OpenWork shows the exact Den callback for the pre-registered provider app.", callback);
            state.serviceNowConnectionId = await connectionIdNamed(SERVICENOW_NAME);
            witness(ctx, Boolean(state.serviceNowConnectionId), "Den persists the pre-registered connection before provider authorization.");
            const callbackUrl = new URL(callback);
            witness(
              ctx,
              callbackUrl.pathname.endsWith(`/v1/mcp-connections/${state.serviceNowConnectionId}/connect/callback`)
                && callbackUrl.search === "",
              "The displayed callback is exact, connection-bound, and contains no query credential.",
              { origin: callbackUrl.origin, path: callbackUrl.pathname },
            );
            await configureMock("/__mock/preregistered-client-redirect", { redirectUri: callback });
            await ctx.screenshot("mcp-rehearsal-servicenow-callback-ready", {
              claim: "OpenWork displays the exact connection-bound Den callback before provider authorization starts.",
              requireText: ["Almost done — add this redirect URL to your app", "/connect/callback"],
              rejectText: [MOCK_CLIENT_SECRET, "mock-access-token", "mock-refresh-token"],
            });
            await ctx.clickText("Done", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitForText(SERVICENOW_NAME, { timeoutMs: 20_000 });
            const connectClicked = await ctx.eval(rowScript(SERVICENOW_NAME, { button: "Connect", connectionId: state.serviceNowConnectionId }));
            witness(ctx, connectClicked, "The admin starts the pre-registered ServiceNow authorization from its exact row.");
            await ctx.waitFor(rowScript(SERVICENOW_NAME, { contains: "Connected", connectionId: state.serviceNowConnectionId }), {
              timeoutMs: 45_000,
              label: "ServiceNow OAuth callback persisted",
            });
            const paths = (await mockRequests())
              .slice(state.mockRequestBaseline)
              .map((entry) => entry?.path)
              .filter(Boolean);
            witness(
              ctx,
              paths.includes("/oauth_token.do") && !paths.includes("/register"),
              "The browser journey used ServiceNow's confidential token endpoint and never used dynamic client registration.",
              paths,
            );
          },
          assert: async () => {
            witness(ctx, Boolean(state.serviceNowConnectionId), "Den persisted the connected ServiceNow-style MCP record.");
            await ctx.expectText(SERVICENOW_NAME);
            await ctx.expectText("Connected");
            await ctx.expectNoText("Connection failed");
            const visibleText = await ctx.eval("document.body.innerText");
            witness(ctx, !visibleText.includes(MOCK_CLIENT_SECRET), "The saved confidential client secret is never rendered back into the dashboard.");
          },
          screenshot: {
            name: "mcp-rehearsal-servicenow-oauth-connected",
            claim: "The realistic ServiceNow endpoint completes OAuth and is durably Connected in the ordinary Den screen.",
            requireText: [SERVICENOW_NAME, "Connected", "Test connection", "Diagnose"],
            rejectText: ["Connection failed", "mock-access", "client_secret", MOCK_CLIENT_SECRET],
          },
        });
      },
    },
    {
      name: "Step 3 — prove protocol and complete catalog readiness without a tool call",
      run: async (ctx) => {
        await ctx.prove("Test connection exhausts the paged catalog and invokes no provider operation", {
          voiceover: vo[2],
          action: async () => {
            state.connectionTestRequestBaseline = (await mockRequests()).length;
            const clicked = await ctx.eval(rowScript(SERVICENOW_NAME, { button: "Test connection", connectionId: state.serviceNowConnectionId }));
            witness(ctx, clicked, "The connected row exposes its read-only Test connection action.");
            await ctx.waitForText("Protocol ready · 2025-06-18 · 4 tools across 2 pages", { timeoutMs: 45_000 });
            state.connectionTestRequests = (await mockRequests()).slice(state.connectionTestRequestBaseline);
            await ctx.eval(`(() => {
              const row = document.querySelector('[data-connection-id="${state.serviceNowConnectionId}"]');
              row?.scrollIntoView({ block: 'center', behavior: 'instant' });
              return Boolean(row);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("look_up_incident_records");
            await ctx.expectText("session established");
            await ctx.expectNoText("mock-access-token");
            witness(
              ctx,
              state.mockHealth.operationFault === "none",
              "Catalog readiness is proven before any provider-operation fault is enabled.",
              { operationFault: state.mockHealth.operationFault },
            );
            const endpointRequests = state.connectionTestRequests.filter((request) => (
              request?.path === new URL(state.mockHealth.resource).pathname
            ));
            const rpcMethods = endpointRequests.flatMap((request) => (
              Array.isArray(request.rpcMethods) ? request.rpcMethods : []
            ));
            witness(
              ctx,
              rpcMethods.includes("initialize")
                && rpcMethods.includes("notifications/initialized")
                && rpcMethods.filter((method) => method === "tools/list").length === 2,
              "The one-shot test initializes MCP, sends initialized, and exhausts exactly two catalog pages.",
              rpcMethods,
            );
            witness(
              ctx,
              endpointRequests.some((request) => request.method === "DELETE")
                && !rpcMethods.includes("tools/call"),
              "The one-shot test shuts down its session and never invokes a provider tool.",
              endpointRequests.map((request) => ({ method: request.method, rpcMethods: request.rpcMethods ?? [] })),
            );
          },
          screenshot: {
            name: "mcp-rehearsal-read-only-catalog-test",
            claim: "The one-shot test proves protocol 2025-06-18 and all four tools across two pages without invoking one.",
            requireText: ["Protocol ready", "2025-06-18", "4 tools", "2 pages", "look_up_incident_records"],
            rejectText: ["Connection test failed", "mock-access", "Synthetic printer"],
          },
        });
      },
    },
    {
      name: "Step 4 — preserve Authorized while naming the injected MCP version fault",
      run: async (ctx) => {
        await ctx.prove("Live diagnostics isolate MCP Version after authorization has already succeeded", {
          voiceover: vo[3],
          action: async () => {
            await configureMock("/__mock/protocol-version", { protocolVersion: "2099-01-01" });
            const clicked = await ctx.eval(rowScript(SERVICENOW_NAME, { button: "Diagnose", connectionId: state.serviceNowConnectionId }));
            witness(ctx, clicked, "The connected ServiceNow-style row opens live diagnostic mode.");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]'))", {
              timeoutMs: 10_000,
              label: "ServiceNow diagnostic dialog",
            });
            await ctx.clickText("Run diagnostic", { timeoutMs: 10_000 });
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"mcp-diagnostic-health\"]')?.textContent?.includes('Authorized')",
              { timeoutMs: 45_000, label: "Authorized highest health" },
            );
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"mcp-diagnostic-first-failure\"]')?.textContent?.includes('Mcp Version')",
              { timeoutMs: 20_000, label: "MCP version first failure" },
            );
          },
          assert: async () => {
            await ctx.expectText("Authorized");
            await ctx.expectText("Mcp Version");
            await ctx.expectText("Owner: Provider Admin");
            await ctx.expectText("Action: Align Provider And Client Mcp Versions");
            await ctx.expectText("did not agree on a supported stable MCP revision");
            await assertDiagnosticRedaction(ctx, "The version-failure timeline remains metadata-only and redacted.");
          },
          screenshot: {
            name: "mcp-rehearsal-version-first-failure",
            claim: "Authorization remains proven while MCP Version is the first failure and the provider administrator owns the repair.",
            requireText: ["Authorized", "Mcp Version", "Owner: Provider Admin", "Align Provider And Client Mcp Versions"],
            rejectText: ["Invalid credentials", "mock-access", "mock-code", "MCP-Session-Id"],
          },
        });
      },
    },
    {
      name: "Step 5 — repair and retry to Catalog Ready",
      run: async (ctx) => {
        await ctx.prove("The same live panel reaches Catalog Ready after the mock is repaired", {
          voiceover: vo[4],
          action: async () => {
            await configureMock("/__mock/protocol-version", { protocolVersion: state.stableProtocolVersion });
            await ctx.clickText("Run again", { timeoutMs: 10_000 });
            await ctx.waitFor(
              "document.querySelector('[data-testid=\"mcp-diagnostic-health\"]')?.textContent?.includes('Catalog Ready')",
              { timeoutMs: 45_000, label: "Catalog Ready after repair" },
            );
            await ctx.eval("(() => { const dialog = document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]'); if (dialog) dialog.scrollTop = 0; return true; })()");
          },
          assert: async () => {
            await ctx.expectText("Catalog Ready");
            await ctx.expectText("The complete tool catalog is available");
            await ctx.expectText("Catalog Ready proves the complete tool catalog. Provider operations and mutations were not tested.");
            const firstFailure = await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-first-failure\"]')?.textContent?.trim() ?? ''");
            witness(ctx, firstFailure === "None", "The repaired diagnostic has no first failing phase.", firstFailure);
          },
          screenshot: {
            name: "mcp-rehearsal-catalog-ready-after-repair",
            claim: "The repaired endpoint reaches Catalog Ready and explicitly stops short of claiming provider-operation health.",
            requireText: ["Catalog Ready", "complete tool catalog", "Provider operations and mutations were not tested"],
            rejectText: ["Connection failed", "mock-access", "Synthetic printer"],
          },
        });
      },
    },
    {
      name: "Step 6 — execute one safe read through Den and keep provider health separate",
      run: async (ctx) => {
        await ctx.prove("A provider denial is reported separately from the still-healthy MCP connection and catalog", {
          voiceover: vo[5],
          action: async () => {
            const configuredFault = await configureMock("/__mock/operation-fault", { fault: "provider_denied" });
            witness(
              ctx,
              configuredFault.operationFault === "provider_denied",
              "The provider authorization denial is injected only after connection and catalog health have succeeded.",
              configuredFault,
            );
            state.mcpToken = await mintMcpToken(state.adminSession, ctx);
            const search = await mcpAgentCall(state.mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: `${SERVICENOW_NAME} incident records`, type: "mcp", limit: 20 },
            }, ctx);
            const searchPayload = toolJson(search);
            const matches = Array.isArray(searchPayload.body.matches) ? searchPayload.body.matches : [];
            const match = matches.find((candidate) => (
              typeof candidate?.name === "string"
              && candidate.name.endsWith(`:${SAFE_READ_TOOL}`)
              && candidate.summary?.includes(SERVICENOW_NAME)
            ));
            witness(
              ctx,
              Boolean(match),
              `search_capabilities finds the fixture's bounded read-only ${SAFE_READ_TOOL} operation.`,
              matches.map((candidate) => candidate?.name).filter(Boolean),
            );
            witness(
              ctx,
              state.mockHealth.fixtureContract?.readOnlyTools?.includes(SAFE_READ_TOOL)
                && SAFE_READ_ARGS.limit === 1,
              "The fixture contract marks the selected operation read-only, and the call is bounded to one synthetic record.",
              {
                tool: SAFE_READ_TOOL,
                readOnlyTools: state.mockHealth.fixtureContract?.readOnlyTools,
                limit: SAFE_READ_ARGS.limit,
              },
            );

            const executed = await mcpAgentCall(state.mcpToken, "tools/call", {
              name: "execute_capability",
              arguments: { name: match.name, body: SAFE_READ_ARGS },
            }, ctx);
            const execution = toolJson(executed);
            const diagnostic = isRecord(execution.body.diagnostic) ? execution.body.diagnostic : {};
            witness(
              ctx,
              executed.isError === true && execution.body.error === "provider_error",
              "The real Den execute_capability path reports the provider denial as an operation error.",
              { isError: executed.isError, error: execution.body.error },
            );
            witness(
              ctx,
              diagnostic.highestPassed === "protocol_ready",
              "The operation denial preserves protocol readiness instead of downgrading connection health.",
              { highestPassed: diagnostic.highestPassed },
            );
            witness(
              ctx,
              execution.body.actionOwner === "provider_admin" && diagnostic.actionOwner === "provider_admin",
              "The denied provider operation is owned by the provider administrator.",
              { actionOwner: execution.body.actionOwner, diagnosticActionOwner: diagnostic.actionOwner },
            );

            const category = diagnostic.category;
            const operatorAction = execution.body.operatorAction ?? diagnostic.operatorAction ?? "";
            witness(
              ctx,
              category === "provider_policy_denied"
                && diagnostic.phase === "PROVIDER_AUTHORIZATION"
                && /grant.*(?:role|acl|application permission)/i.test(operatorAction),
              "Den converts the provider's structured denial into provider_policy_denied and directs the provider admin to grant the required role, ACL, or application permission.",
              { category, phase: diagnostic.phase, operatorAction },
            );
            witness(
              ctx,
              !/mock-(?:access|refresh|code)|MCP-Session-Id|Synthetic printer|active=true/i.test(execution.text),
              "The Den operation error returns neither credentials, session identifiers, provider content, nor the tool arguments.",
              { responseCharacterCount: execution.text.length },
            );
            const visibleHealth = await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-health\"]')?.textContent ?? ''");
            witness(
              ctx,
              visibleHealth.includes("Catalog Ready"),
              "The provider-operation denial does not downgrade the already proven catalog health.",
              visibleHealth,
            );
            await ctx.trustedClick('button[aria-label="Close diagnostics"]', { timeoutMs: 10_000 });
            await ctx.waitFor(rowScript(SERVICENOW_NAME, { contains: "Connected", connectionId: state.serviceNowConnectionId }), {
              timeoutMs: 10_000,
              label: "connection remains connected after provider denial",
            });
          },
          assert: async () => {
            await ctx.expectText(SERVICENOW_NAME);
            await ctx.expectText("Connected");
            await ctx.expectText("Protocol ready · 2025-06-18 · 4 tools across 2 pages");
            await ctx.expectNoText("Connection failed");
          },
          screenshot: {
            name: "mcp-rehearsal-provider-denial-keeps-connection-ready",
            claim: "A provider policy denial remains an operation-level failure while the connection and complete catalog stay healthy.",
            requireText: [SERVICENOW_NAME, "Connected", "Protocol ready", "4 tools", "2 pages"],
            rejectText: ["Connection failed", MOCK_CLIENT_SECRET, "mock-access-token", "MCP-Session-Id"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await configureMock("/__mock/auto-approve", { autoApprove: true });
        await configureMock("/__mock/operation-fault", { fault: "none" });
        if (state.stableProtocolVersion) {
          await configureMock("/__mock/protocol-version", { protocolVersion: state.stableProtocolVersion });
        }
        const restoredHealth = await fetch(`${MOCK_ORIGIN}/health`).then((response) => response.json());
        witness(
          ctx,
          restoredHealth.fault === "none"
            && restoredHealth.operationFault === "none"
            && restoredHealth.protocolVersion === state.stableProtocolVersion,
          "Cleanup restores the deterministic fixture to its healthy protocol and operation settings.",
          {
            fault: restoredHealth.fault,
            operationFault: restoredHealth.operationFault,
            protocolVersion: restoredHealth.protocolVersion,
          },
        );
        await deleteConnection(state.unreachableConnectionId, ctx, "The unreachable fixture connection");
        await deleteConnection(state.serviceNowConnectionId, ctx, "The ServiceNow fixture connection");
        state.unreachableConnectionId = null;
        state.serviceNowConnectionId = null;
        await refreshConnectionsPage(ctx);
        await ctx.eval("(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()");
        await sleep(200);
        await ctx.eval("(() => { window.scrollTo(0, 0); return true; })()");
        await sleep(1_500);
        await ctx.screenshot("mcp-rehearsal-cleanup-complete", {
          claim: "The replay removes every synthetic connection and resets the deterministic fixture after collecting evidence.",
          requireText: ["Connections", "Add a connection", "MCP server"],
          rejectText: ["rehearsal-unreachable-", "rehearsal-servicenow-", MOCK_CLIENT_SECRET, "mock-access-token"],
        });
      },
    },
  ],
};
