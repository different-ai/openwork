import { randomUUID } from "node:crypto";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";
import { parityRecord } from "./engine-gateway-parity.ts";

/** Real capability search and execution in Den; external connector is an owned witness. */
export async function engineConnectorsParity(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const base = setup.use(await engineParity(seed, context));
  const proof = `Fresh report ${randomUUID()}`;
  const den = await seed.den({ web: false, org: { name: "Connector parity" }, mocks: {
    report: seed.mock({ allowUnauthenticatedMcp: true, tools: [
      { name: "current_amber_report", description: "Read the current amber report", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: proof }] } },
      { name: "unavailable_violet_status", description: "Read the unavailable violet status", inputSchema: { type: "object", properties: {} }, result: { isError: true, content: [{ type: "text", text: "Report service unavailable" }] } },
    ] }),
  } });
  await seed.orgConnection(den.admin, { name: "Amber Reports", url: den.mocks.report.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = parityRecord(parityRecord(org.body).organization).id;
  if (typeof orgId !== "string") throw new Error("Missing connector organization");
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = parityRecord(issued.body).token;
  if (!issued.response.ok || typeof token !== "string") throw new Error("Missing connector MCP token");
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
  if (!workspace) throw new Error("Missing connector workspace");
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "parity-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const resources = setup.move();
  return {
    ...base, den, proof,
    async connectHealth(repair = false) {
      return repair
        ? base.request(`/workspace/${workspace}/mcp/openwork-cloud/engine-refresh`, "POST", { provider: "opencode", model: "big-pickle" })
        : base.request(`/workspace/${workspace}/mcp/openwork-cloud/health?provider=opencode&model=big-pickle`);
    },
    async prepareReport(prompt: string, failed = false) {
      const search = { query: failed ? "unavailable_violet_status" : "current_amber_report", type: "mcp", limit: 1 };
      const steps: MockAgentToolStep[] = base.engine === "v2" ? [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search)});
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
      ` } }] : [
        { tool: "search_capabilities", arguments: search },
        { tool: "execute_capability", arguments: { body: {} }, argumentsFrom: "capability-search" },
      ];
      await base.prepareTurn(prompt, "The report was not returned", steps, "last-tool-text");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
