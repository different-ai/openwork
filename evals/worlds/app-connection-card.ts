import { setTimeout as delay } from "node:timers/promises";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";
import { reconcileDraftHost } from "../fixtures/cloud-draft-host.ts";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { field, payload, record } from "./mcp-app-servers.ts";

export const appTitle = "PostHog DAU";
export const connectionName = "PostHog";
export const dauToolName = "query_dau";
export const dailyActiveUsers = 1234;
export const openPrompt = "Open the PostHog DAU app.";
export const openReply = "The PostHog DAU app is open.";

const dauTool: MockMcpTool = {
  name: dauToolName,
  description: "Daily active users for the current project.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
  result: { content: [{ type: "text", text: `DAU ${dailyActiveUsers}` }], structuredContent: { dau: dailyActiveUsers }, isError: false },
};

/** What the provider serves once it drops the DAU query, so the saved Workflow's tool is gone. */
const remainingTool: MockMcpTool = {
  name: "query_wau",
  description: "Weekly active users for the current project.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
  result: { content: [{ type: "text", text: "WAU 4321" }], structuredContent: { wau: 4321 }, isError: false },
};

/**
 * An App written the way generated Apps often are: it loads one number from a
 * Workflow and prints whatever comes back when that fails.
 */
function appSource() {
  return {
    title: appTitle,
    textFallback: `${appTitle} is ready. Open the App to load today's daily active users.`,
    reactSource: `export default function Dau({ app }) {
      const [dau, setDau] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      async function load() {
        setBusy(true); setFailure("");
        try {
          const reply = await app.callServerTool({ name: "load_dau", arguments: {} });
          const text = reply.content.find(part => part.type === "text")?.text ?? "";
          if (reply.isError) throw new Error(text);
          setDau((reply.structuredContent ?? JSON.parse(text)).value.dau);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      }
      return <main>
        <h1>${appTitle}</h1>
        {dau !== null && <output data-testid="dau" aria-label="Daily active users">{dau.toLocaleString("en-US")}</output>}
        {failure && <p role="alert">Couldn't load DAU: {failure}</p>}
        <button type="button" disabled={busy} onClick={load}>{failure ? "Try again" : "Load DAU"}</button>
      </main>;
    }`,
    cssSource: `:root { font: 13px/1.5 system-ui, sans-serif; } body { margin: 0; } main { padding: 16px; }
      h1 { font-size: 18px; font-weight: 600; } output { display: block; font-size: 28px; font-weight: 600; padding: 8px 0; }
      [role=alert] { color: #b42318; overflow-wrap: anywhere; } button { font: inherit; padding: 8px 12px; }`,
  };
}

/**
 * An owner's chat opens an App built in OpenWork whose one tool runs a saved
 * Workflow over a PostHog-shaped MCP connection. The provider can later stop
 * offering the tool the Workflow was saved with.
 */
export async function appConnectionCard(seed: Seed) {
  const den = await seed.den({
    env: { DEN_APP_MCP_SERVERS_ENABLED: "true" },
    org: { name: `App connection card ${Date.now()}` },
    mocks: { posthog: seed.mock({ allowUnauthenticatedMcp: true, tools: [dauTool] }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: connectionName, url: den.mocks.posthog.mcpUrl,
    authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  const organizationId = field(record((await seed.api(den.admin, "/v1/org")).body).organization, "id");
  await enableOrganizationCapabilities(seed, den.admin, { appMcpServers: true }, organizationId);
  const minted = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  if (!minted.response.ok) throw new Error(`MCP token setup failed: ${minted.response.status}`);
  const token = field(minted.body, "token");
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Den MCP ${name} returned HTTP ${response.status}`);
    const raw = await response.text();
    const data = raw.split("\n").find(line => line.startsWith("data:"));
    return record(record(JSON.parse(data ? data.slice(5) : raw)).result);
  };

  // The saved Workflow calls PostHog's DAU query through the connection's namespace.
  const inputSchema = { type: "object", properties: {}, additionalProperties: false };
  const outputSchema = { type: "object", properties: { dau: { type: "number" } }, required: ["dau"], additionalProperties: false };
  const code = "const result = await tools.posthog.query_dau({}); return { dau: result.dau };";
  const tested = await call("execute_capability_script", { code, input: {}, inputSchema, outputSchema });
  if (tested.isError) throw new Error(`DAU Workflow authoring failed: ${JSON.stringify(tested)}`);
  const metadata = record(payload(tested).metadata);
  const saved = await seed.api(den.admin, "/v1/workflows", {
    method: "POST", body: JSON.stringify({ name: "Daily active users", receiptId: field(metadata, "receiptId"), inputSchema, outputSchema, currentInput: {} }),
  });
  if (saved.response.status !== 201) throw new Error(`Saving the DAU Workflow failed: ${saved.response.status} ${saved.text.slice(0, 300)}`);
  const workflow = { pluginId: field(saved.body, "pluginId"), configObjectId: field(saved.body, "configObjectId") };
  const created = record(payload(await call("create_app", {
    ...appSource(),
    tools: [{ name: "load_dau", description: "Load today's daily active users from PostHog.", capability: `plugin:${workflow.pluginId}:${workflow.configObjectId}` }],
  })).app);
  const app = { appId: field(created, "appId"), pluginId: field(created, "pluginId") };

  const configured = await fetch(`${den.mocks.posthog.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [
      { promptMarker: openPrompt, finalReply: openReply, latestUserTurn: true, steps: [
        { tool: "execute_capability", arguments: { name: `plugin:${app.pluginId}:${app.appId}`, body: {} } },
      ] },
    ] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!configured.ok) throw new Error(`Chat model setup failed: ${configured.status}`);

  const workspacePath = seed.tmpPath("app-connection-card");
  const denOrigin = new URL(den.ref.apiUrl);
  const surface = await seed.appWeb({ name: "app-connection-card", workspacePath, headless: true,
    ...(denOrigin.protocol === "https:" ? { syntheticPreactivatedDenOrigin: denOrigin.origin } : {}) });
  const workspace = await seed.workspace(surface, workspacePath);
  await configureProvider(seed, surface, workspace.workspaceId, "app-card-model", "app-card-model", {
    provider: { "app-card-model": {
      npm: "@ai-sdk/openai-compatible", name: "App card model fixture",
      options: { baseURL: `${den.mocks.posthog.url}/v1`, apiKey: "sk-app-card-fixture" },
      models: { "app-card-model": { name: "App card model fixture", tool_call: true } },
    } },
    mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } },
  });
  const session = await seed.session(surface, { title: appTitle });
  // The private App host reads the Connect server index, which lists the App as its own server.
  const hostSetup = {
    name: surface.handle.name, openworkUrl: surface.openworkUrl, workspaceRoot: surface.workspaceRoot,
    workspaceId: workspace.workspaceId, cloudUrl: `${den.ref.apiUrl}/mcp/agent`, token, appHostToken: field(minted.body, "appHostToken"),
  };
  const reconciled = record(surface.handle.sandboxId
    ? JSON.parse((await execInSandbox(defaultDaytonaExec, surface.handle.sandboxId,
      `node /workspace/evals/fixtures/cloud-draft-host.ts ${Buffer.from(JSON.stringify(hostSetup)).toString("base64url")}`,
      { context: "Reconcile the App chat host", timeoutMs: 150_000 })).stdout.trim())
    : await reconcileDraftHost(hostSetup));
  if (reconciled.status !== 200 || reconciled.phase !== "ready" || reconciled.diagnostic !== "ready") throw new Error(`Cloud reconcile failed: ${JSON.stringify(reconciled)}`);

  return {
    app: surface, session, den, connectionId: connection.id,
    dauCalls: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.posthog.toolCalls({ name: dauToolName, atLeast: 0, ...options }),
    /** PostHog stops offering the DAU query the saved Workflow was built on. */
    async dropDauTool() {
      const response = await fetch(`${den.mocks.posthog.url}/admin/tools`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tools: [remainingTool] }), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Replacing PostHog's tools failed: ${response.status}`);
    },
    /** The App's isolated frame in the conversation, for trusted input. */
    async appFrame(): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const target of (await listTargets(surface.handle.cdpUrl)).filter(entry => entry.type === "iframe" && entry.url === "about:srcdoc")) {
          const client = await connect(debuggerUrlFor(surface.handle.cdpUrl, target));
          if (await evaluate(client, () => document.title).catch(() => "") === appTitle) {
            return { handle: surface.handle, client, [Symbol.asyncDispose]: async () => client.close() };
          }
          client.close();
        }
        await delay(250);
      }
      throw new Error(`${appTitle} did not open in the conversation`);
    },
  };
}
