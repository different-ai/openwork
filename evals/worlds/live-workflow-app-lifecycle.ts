import type { Seed } from "@openwork/env";
import { denFetch, go, waitFor } from "@openwork/behaviors";
import { browserScript } from "@openwork/cdp";
import { field, record, inAppDocuments } from "./saved-apps.ts";

export async function localLiveApp(seed: Seed) {
  const den = await seed.den({
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true", DEN_DASHBOARDS_ENABLED: "true" },
    org: { name: "Synthetic live validation", admin: { name: "Test Operator" } },
  });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = field(record(org.body).organization, "id");
  const tokenResponse = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = field(tokenResponse.body, "token");
  let id = 0;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Local MCP request failed (${response.status}): ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find(line => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : raw));
    if (message.error) throw new Error(JSON.stringify(message.error));
    const result = record(message.result);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  };
  const app = await seed.desktop({ den, name: "live-workflow-app-lifecycle" });
  return { app, den, rpc,
    request: (path: string, body: Record<string, unknown>) => denFetch(den.admin, path, { method: "POST", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify(body) }),
    previewText: async () => {
      await waitFor(app, browserScript(() => [...document.querySelectorAll("iframe")].some(frame => {
        const rect = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        return rect.width > 100 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight && style.visibility === "visible" && style.display !== "none";
      }), []), { timeoutMs: 30_000, label: "visible generated app iframe" });
      return (await inAppDocuments(app, "visible")).join("\n");
    },
    async open(path: string) {
      await go(app, path);
      await waitFor(app, browserScript(() => document.querySelector("[data-app-header]") !== null, []), { timeoutMs: 30_000, label: "app header" });
    },
  };
}
