import { browserScript } from "@openwork/cdp";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { denFetch, go, runWorkflow, saveWorkflow } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { configureProvider } from "./chat.ts";

export const creationPrompt = "Create a reusable app for my dashboard that shows a weekly briefing using my existing Weekly briefing workflow.";
export const creationReply = "Your briefing app draft is ready. Try the preview, then choose Save.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object response.");
  return value;
}
export function field(value: unknown, key: string): string {
  const found = record(value)[key];
  if (typeof found !== "string") throw new Error(`Expected ${key} in the response.`);
  return found;
}

export async function savedAppCreation(seed: Seed) {
  const den = await seed.den({
    env: {
      DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true", DEN_DASHBOARDS_ENABLED: "true",
      // Whitespace bypasses the dev script's empty-value Redis default, then
      // normalizes to unconfigured. SQL session aging must not hit a warm cache.
      DATABASE_REDIS_URL: " ",
    },
    org: { name: `Saved Apps ${Date.now()}`, members: { colleague: { name: "Colleague" } } },
    mocks: {
      tracker: seed.mock({ allowUnauthenticatedMcp: true, appToolName: "search_issues_using_jql" }),
    },
  });
  if (!den.placement || (den.placement.kind === "local" && !den.database)) {
    throw new Error("Session aging requires a disposable Den with its own database, not an attached server.");
  }
  const connection = await seed.orgConnection(den.admin, {
    name: "Issue tracker", url: den.mocks.tracker.mcpUrl,
    authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  const catalog = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`);
  const apps = record(catalog.body).apps;
  if (!Array.isArray(apps) || !apps[0]) throw new Error("The company app catalog is empty.");
  const companyApp = record(apps[0]);
  const dashboard = await seed.api(den.admin, "/v1/dashboards", { method: "POST", body: JSON.stringify({
    name: "Team tools", elements: [{ serverName: "Issue tracker", connectionId: connection.id,
      toolName: field(companyApp, "toolName"), projectedToolName: field(companyApp, "toolName"),
      resourceUri: field(companyApp, "resourceUri"), title: "Project updates", launchArguments: { jql: "project = DEMO" },
    }],
  }) });
  if (dashboard.response.status !== 201) throw new Error(`Company dashboard setup failed: ${dashboard.text}`);
  const dashboardId = field(record(dashboard.body).item, "id");
  const grant = await seed.api(den.admin, `/v1/dashboards/${dashboardId}/access`, { method: "POST", body: JSON.stringify({ orgWide: true, role: "viewer" }) });
  if (grant.response.status !== 201) throw new Error(`Company dashboard grant failed: ${grant.text}`);
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = field(record(org.body).organization, "id");
  const tokenResponse = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = field(tokenResponse.body, "token");
  let requestId = 0;
  const rpc = async (name: string, args: Record<string, unknown>, session = den.admin, method = "tools/call") => {
    const sessionToken = session === den.admin ? token : field((await seed.api(session, "/v1/mcp/token", {
      method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    })).body, "token");
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params: method === "tools/list" ? {} : { name, arguments: args } }),
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP request failed (${response.status}): ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : raw));
    if (message.error) throw new Error(JSON.stringify(message.error));
    const result = record(message.result);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  };
  const code = 'const roster = await tools.den.getWorkers({}); return { topic: input.topic, total: roster.workers.length };';
  const firstInput = { topic: "Launch briefing" };
  await rpc("execute_capability_script", { code, input: firstInput });
  const saved = await saveWorkflow(den.admin, {
    name: "Weekly briefing", code, currentInput: firstInput,
    inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    outputSchema: { type: "object", properties: { topic: { type: "string" }, total: { type: "number" } }, required: ["topic", "total"] },
  });
  if (saved.status !== 201) throw new Error(`Workflow setup failed: ${saved.text}`);
  const configObjectId = field(saved.body, "configObjectId");
  const run = (topic: string) => runWorkflow(den.admin, configObjectId, {
    pluginId: field(saved.body, "pluginId"), configObjectVersionId: field(saved.body, "configObjectVersionId"), input: { topic },
  });
  const firstRun = await run(firstInput.topic);
  const source = (heading: string) => `export default function Briefing({ data }) { const [expanded, setExpanded] = React.useState(false); return <article><h1>${heading}</h1><p>{data.topic}</p><button onClick={() => setExpanded(!expanded)}>{expanded ? "Hide details" : "Show details"}</button>{expanded && <p>Workers: {data.total}</p>}</article> }`;
  // Only the existing workflow is arranged. The desktop conversation must
  // execute the model tool call to create and display the first app draft.
  const configured = await fetch(`${den.mocks.tracker.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [{ promptMarker: creationPrompt, finalReply: creationReply, steps: [
      { tool: "save_artifact_view", arguments: {
        configObjectId, title: "Briefing app", reactSource: source("Weekly overview"),
        cssSource: "body{font-family:system-ui,sans-serif;padding:24px;margin:0}button{padding:8px 12px}",
      } },
    ] }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!configured.ok) throw new Error(`Model fixture setup failed: ${configured.status}`);
  const providerId = "saved-app-model";
  const modelId = "saved-app-model";
  const proxy = await seed.faultProxy(den);
  // Keep runtime API discovery on the same proxy as the simulated old server.
  const resetProxy = async () => {
    await proxy.faults.clear();
    await proxy.faults.status("/api/runtime-config", 200, { times: 1000, body: { denApiUrl: proxy.ref.apiUrl } });
  };
  await resetProxy();
  const app = await seed.desktop({ den: { ...den, ref: proxy.ref }, name: "saved-app-creation", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("saved-app-creation"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "App creation model fixture",
      options: { baseURL: `${den.mocks.tracker.url}/v1`, apiKey: "sk-app-fixture" },
      models: { [modelId]: { name: "App creation model fixture", tool_call: true } },
    } },
    mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } },
  });
  const inPreview = async (action: "read" | "details") => {
    const targets = await listTargets(app.handle.cdpUrl);
    const target = targets.find((entry) => entry.type === "iframe" && (entry.url === "about:srcdoc" || entry.url.includes("/mcp-apps/sandbox.html")));
    if (!target) return "";
    const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
    try {
      return await evaluate(client, browserScript((action) => {
        const appDocument = document.querySelector("iframe")?.contentDocument ?? document;
        if (action === "read") return appDocument.body.innerText;
        appDocument.querySelector("button")?.click();
        return "";
      }, [action]));
    } finally { client.close(); }
  };
  return {
    app, den, proxy, resetProxy, workspace, configObjectId, dashboardId, rpc, run,
    async desktopIdentity() {
      const token = await evaluate(app.client, () => localStorage.getItem("openwork.den.authToken"));
      if (typeof token !== "string" || !token) throw new Error("The desktop has no authenticated Den session.");
      const response = await denFetch(den.ref, "/v1/me", { headers: { authorization: `Bearer ${token}` } });
      if (response.response.status !== 200) throw new Error(`Desktop identity request failed (${response.response.status}).`);
      const body = record(response.body);
      return {
        sessionId: field(body.session, "id"), createdAt: field(body.session, "createdAt"),
        expiresAt: field(body.session, "expiresAt"), userId: field(body.user, "id"),
        email: field(body.user, "email"), usesAdminToken: token === den.admin.token,
      };
    },
    async ageSession(sessionId: string) {
      const id = `0x${Buffer.from(sessionId).toString("hex")}`;
      const statement = `UPDATE session SET created_at=DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE CAST(id AS BINARY)=${id};`;
      if (den.placement?.kind === "daytona") {
        await execInSandbox(defaultDaytonaExec, den.placement.sandboxId,
          `echo ${Buffer.from(statement).toString("base64")} | base64 -d | mysql -h127.0.0.1 -uroot -ppassword -N openwork_den`,
          { timeoutMs: 30_000, context: "Saved-app desktop session aging" });
      } else if (den.database) {
        await queryDenDatabase(den.database.url, statement);
      } else {
        throw new Error("Session aging requires the disposable Den database.");
      }
    },
    open: (path: string) => go(app, path),
    previewText: async () => String(await inPreview("read")),
    showDetails: () => inPreview("details"),
    receiptId: field(firstRun, "receiptId"),
    listTools: () => rpc("", {}, den.admin, "tools/list"),
    render: () => rpc("render_workflow_artifact", { configObjectId }),
    async revise(appId: string) {
      const result = await rpc("save_artifact_view", { artifactViewId: appId, configObjectId, title: "Uncommitted rename", reactSource: source("Updated overview") });
      const next = record(record(result.structuredContent).view);
      if (!Array.isArray(next.revisions) || !next.revisions[0]) throw new Error("Revision was not created.");
      return field(next.revisions[0], "id");
    },
  };
}

export async function savedAppSharing(seed: Seed) {
  const world = await savedAppCreation(seed);
  const built = await world.rpc("save_artifact_view", {
    configObjectId: world.configObjectId, title: "Team briefing",
    reactSource: 'export default function Briefing({data}) { return <p>{data.topic}</p> }',
  });
  const view = record(record(built.structuredContent).view);
  const appId = field(view, "id");
  if (!Array.isArray(view.revisions) || !view.revisions[0]) throw new Error("Sharing app has no revision.");
  const saved = await seed.api(world.den.admin, `/v1/apps/${appId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: field(view.revisions[0], "id"), title: "Team briefing", useInWorkflow: true, expectedActiveRevisionId: null }),
  });
  if (saved.response.status !== 200) throw new Error(`Sharing app setup failed: ${saved.text}`);
  return { ...world, appId };
}
