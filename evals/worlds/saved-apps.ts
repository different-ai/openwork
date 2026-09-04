import type { Seed } from "@openwork/env";
import { go, runWorkflow, saveWorkflow } from "@openwork/behaviors";

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
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: { name: `Saved Apps ${Date.now()}`, members: { colleague: { name: "Colleague" } } },
  });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = field(record(org.body).organization, "id");
  const tokenResponse = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = field(tokenResponse.body, "token");
  let requestId = 0;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
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
  const draft = await rpc("save_artifact_view", {
    configObjectId, title: "Briefing app", reactSource: source("Weekly overview"),
    cssSource: "body{font-family:system-ui,sans-serif;padding:24px;margin:0}button{padding:8px 12px}",
  });
  const view = record(record(draft.structuredContent).view);
  const appId = field(view, "id");
  if (!Array.isArray(view.revisions) || !view.revisions[0]) throw new Error("Draft has no revision.");
  const revisionId = field(view.revisions[0], "id");
  const app = await seed.desktop({ den, name: "saved-app-creation" });
  const workspace = await seed.workspace(app, seed.tmpPath("saved-app-creation"));
  return {
    app, den, workspace, appId, revisionId, rpc, run,
    open: (path: string) => go(app, path),
    async previewText() {
      const snapshot = record(await app.client.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }));
      const strings = snapshot.strings;
      const documents = snapshot.documents;
      if (!Array.isArray(strings) || !Array.isArray(documents)) return "";
      return documents.flatMap((document) => {
        const item = record(document);
        if (strings[Number(item.documentURL)] !== "about:srcdoc") return [];
        const nodes = record(item.nodes);
        const names = nodes.nodeName;
        const parents = nodes.parentIndex;
        const values = nodes.nodeValue;
        if (!Array.isArray(names) || !Array.isArray(parents) || !Array.isArray(values)) return [];
        return values.flatMap((value, index) => {
          if (strings[Number(names[index])] !== "#text") return [];
          const parentName = strings[Number(names[Number(parents[index])])];
          if (parentName === "SCRIPT" || parentName === "STYLE") return [];
          const text = strings[Number(value)];
          return typeof text === "string" ? [text] : [];
        });
      }).join(" ");
    },
    receiptId: field(firstRun, "receiptId"),
    render: () => rpc("render_workflow_artifact", { configObjectId }),
    async revise() {
      const result = await rpc("save_artifact_view", { artifactViewId: appId, configObjectId, title: "Uncommitted rename", reactSource: source("Updated overview") });
      const next = record(record(result.structuredContent).view);
      if (!Array.isArray(next.revisions) || !next.revisions[0]) throw new Error("Revision was not created.");
      return field(next.revisions[0], "id");
    },
  };
}
