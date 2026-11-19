import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { isRecord, stringField } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Real built Apps: state lives only inside React, never in storage or a fixture setter. */
const checklistSource = `export default function Checklist() {
  const [reviewed, setReviewed] = React.useState(false);
  return <main><h1>{reviewed ? "Reviewed" : "Project checklist"}</h1>
    <p>Confirm the project handoff before the next review.</p>
    <button type="button" onClick={() => setReviewed(true)}>Mark reviewed</button>
  </main>;
}`;
const cssSource = "main { padding: 24px; font: 14px/1.5 system-ui; color: var(--color-text-primary, CanvasText); } h1 { font-size: 22px; } button { font: inherit; padding: 8px 12px; }";

export async function artifactsListFirstWorld(seed: Seed) {
  const engine = "v2";
  const providerId = "artifact-review-proof";
  const modelId = "review";
  // A real configured engine/model makes session creation available. The model
  // boundary is deterministic and local; building/opening Apps still uses Den.
  const mock = seed.mock({
    isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [],
    agentWorkloads: [{ promptMarker: "Review the project checklist.", latestUserTurn: true, finalReply: "The project checklist is ready to review.", steps: [] }],
  });
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Artifact review workspace", admin: { name: "Workspace owner" }, members: { author: { name: "Artifact author" } } },
    env: { DEN_APP_MCP_SERVERS_ENABLED: "true", DEN_DASHBOARDS_ENABLED: "true", DEN_AUTOMATIONS_ENABLED: "true" },
  });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, {
    appMcpServers: true, automationCalendar: true,
  });
  const author = den.members.author;
  if (!author) throw new Error("The artifact author was not provisioned");
  const mint = async (person: Parameters<Seed["api"]>[0]) => {
    const response = await seed.api(person, "/v1/mcp/token", {
      method: "POST", headers: { "x-openwork-org-id": orgId },
      body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    });
    const token = stringField(response.body, "token");
    if (!response.response.ok || !token) throw new Error(`Minting an App authoring token failed: HTTP ${response.response.status}`);
    return token;
  };
  const authorToken = await mint(author);
  const ownerToken = await mint(den.admin);
  let rpcId = 0;
  const build = async (token: string, title: string, reactSource: string) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: {
        name: "create_app", arguments: { title, description: `Review ${title.toLowerCase()}.`, textFallback: title, reactSource, cssSource, tools: [] },
      } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    const data = raw.split("\n").find(line => line.startsWith("data:"));
    const message: unknown = JSON.parse(data ? data.slice(5) : raw);
    if (!response.ok || !isRecord(message) || !isRecord(message.result) || message.result.isError) {
      throw new Error(`Building ${title} through create_app failed: HTTP ${response.status} ${raw.slice(0, 800)}`);
    }
    const result = message.result.structuredContent;
    const app = isRecord(result) && isRecord(result.app) ? result.app : null;
    const resourceUri = stringField(app, "resourceUri");
    const pluginId = stringField(app, "pluginId");
    if (!resourceUri || !pluginId) throw new Error(`Building ${title} returned no App launch`);
    return { title, resourceUri, pluginId };
  };
  const checklist = await build(authorToken, "Project checklist", checklistSource);
  const notes = await build(authorToken, "Release notes", 'export default function Notes() { return <main><h1>Release notes</h1><p>The next release is ready for review.</p></main>; }');
  const team = await build(ownerToken, "Team overview", 'export default function Overview() { return <main><h1>Team overview</h1><p>Three projects are ready.</p></main>; }');
  const shared = await seed.api(den.admin, `/v1/plugins/${team.pluginId}/access`, {
    method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  if (!shared.response.ok) throw new Error(`Sharing the team artifact failed: HTTP ${shared.response.status}`);
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "author", engine, name: "artifacts-list-first",
    workspacePath: seed.tmpPath("artifacts-list-first"),
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
    mocks: { agent: mock },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The artifact review model fixture did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Artifact review model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-artifact-review-proof" },
      models: { [modelId]: { name: "Artifact review model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Artifact review conversation" });
  return {
    app, workspace, session, checklist, notes, team,
    // Read-only CDP DOM identity witness: unchanged backend node + iframe frame id,
    // together with the App's unsaved React state, proves it was not remounted.
    async frames() {
      const document = await app.client.send("DOM.getDocument", { depth: 0 });
      if (!isRecord(document) || !isRecord(document.root)) throw new Error("The app document is unavailable");
      const matches = await app.client.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: "[data-mcp-app-resource] > iframe" });
      if (!isRecord(matches) || !Array.isArray(matches.nodeIds)) throw new Error("The frame witness is unavailable");
      return Promise.all(matches.nodeIds.map(async nodeId => {
        const described = await app.client.send("DOM.describeNode", { nodeId });
        if (!isRecord(described) || !isRecord(described.node)) throw new Error("The App iframe disappeared while reading it");
        return { node: described.node.backendNodeId, frame: described.node.frameId };
      }));
    },
  };
}
