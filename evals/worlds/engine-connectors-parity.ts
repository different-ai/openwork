import { randomUUID } from "node:crypto";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";

function parityRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a response object");
  return Object.fromEntries(Object.entries(value));
}

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
  const reports = await seed.orgConnection(den.admin, { name: "Amber Reports", url: den.mocks.report.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
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
  let rpcId = 0;
  /** The member's agent calls one OpenWork Cloud MCP tool with its own token, as any MCP client would. */
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(200_000),
    });
    const raw = await response.text();
    if (response.status !== 200) throw new Error(`MCP ${name}: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const frame = parityRecord(JSON.parse(data ? data.slice(5) : raw));
    return parityRecord(frame.result);
  };
  const resources = setup.move();
  return {
    ...base, den, proof,
    /** The script path search_capabilities gives an agent for the amber report connector. */
    async scriptPath(): Promise<string> {
      const found = await callTool("search_capabilities", { query: "current amber report", type: "mcp", limit: 10 });
      const matches = parityRecord(found.structuredContent).matches;
      const match = Array.isArray(matches) ? matches.map(parityRecord).find((entry) => String(entry.name).endsWith(":current_amber_report")) : undefined;
      return typeof match?.scriptPath === "string" ? match.scriptPath : "";
    },
    /** One ad-hoc script run through execute_capability_script; failures keep the interpreter's kind and message. */
    async runScript(code: string): Promise<{ ok: true; value: unknown } | { ok: false; kind: string; message: string }> {
      const result = await callTool("execute_capability_script", { code });
      if (result.isError !== true && typeof result.structuredContent === "object" && result.structuredContent !== null) return { ok: true, value: parityRecord(result.structuredContent).value };
      const text = (Array.isArray(result.content) ? result.content : []).map((part) => String(parityRecord(part).text ?? "")).join("");
      let body: Record<string, unknown> = {};
      try { body = parityRecord(JSON.parse(text)); } catch { /* provider text */ }
      return { ok: false, kind: typeof body.kind === "string" ? body.kind : "", message: typeof body.message === "string" ? body.message : text.slice(0, 500) };
    }, workspace,
    /** The org admin deletes the Amber Reports connection in Den (DELETE /v1/mcp-connections/:id). */
    async retireReports() {
      return (await seed.api(den.admin, `/v1/mcp-connections/${encodeURIComponent(reports.id)}`, { method: "DELETE" })).response.status;
    },
    /** One turn that runs the Amber Reports capability by its exact name, without searching first. */
    async prepareDirectReport(prompt: string) {
      const call = { name: `mcp:${reports.id}:current_amber_report`, body: {} };
      const steps: MockAgentToolStep[] = [{ tool: "execute", arguments: { code: `
        try { return await tools["openwork-cloud"].execute_capability(${JSON.stringify(call)}); } catch (error) { return String(error); }
      ` } }];
      await base.prepareTurn(prompt, "The report was not returned", steps, "last-tool-text");
    },
    async connectHealth(repair = false) {
      return repair
        ? base.request(`/workspace/${workspace}/mcp/openwork-cloud/engine-refresh`, "POST", { provider: "opencode", model: "big-pickle" })
        : base.request(`/workspace/${workspace}/mcp/openwork-cloud/health?provider=opencode&model=big-pickle`);
    },
    async prepareReport(prompt: string, failed = false) {
      const search = { query: failed ? "unavailable_violet_status" : "current_amber_report", type: "mcp", limit: 1 };
      const steps: MockAgentToolStep[] = [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search)});
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
      ` } }];
      await base.prepareTurn(prompt, "The report was not returned", steps, "last-tool-text");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}

/**
 * A per-member Notion connection the member has not connected yet. The model
 * finds it and tries to use it inside one Code Mode `execute`. Den answers
 * with the real `needs_connection` status.
 */
export async function engineConnectorNeedsSignIn(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const den = await seed.den({ org: { name: "Connector sign-in" }, mocks: {
    notion: seed.mock({ tools: [
      { name: "search_pages", description: "Search Notion pages", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: "Roadmap" }] } },
    ] }),
  } });
  // The person is signed in to OpenWork Cloud, so the card's Connect starts Notion's own sign-in.
  const base = setup.use(await engineParity(seed, context, { env: {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } }));
  await seed.signIn(base.app, den.admin, "Notion member");
  await seed.orgConnection(den.admin, { name: "Notion", url: den.mocks.notion.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = parityRecord(parityRecord(org.body).organization).id;
  if (typeof orgId !== "string") throw new Error("Missing connector organization");
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = parityRecord(issued.body).token;
  if (!issued.response.ok || typeof token !== "string") throw new Error("Missing connector MCP token");
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
  if (!workspace) throw new Error("Missing connector workspace");
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "sign-in-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const resources = setup.move();
  return {
    ...base, den,
    async prepareNeedsSignIn(prompt: string, reply: string) {
      const search = { query: "Notion search pages", type: "mcp", limit: 1 };
      const steps: MockAgentToolStep[] = [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search)});
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        try {
          return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
        } catch (error) {
          return String(error);
        }
      ` } }];
      await base.prepareTurn(prompt, reply, steps);
    },
    async notionSignedIn() {
      const listed = parityRecord((await seed.api(den.admin, "/v1/mcp-connections?scope=usable")).body).connections;
      return Array.isArray(listed) && listed.some((entry) => parityRecord(entry).name === "Notion" && parityRecord(entry).connectedForMe === true);
    },
    /** Notion's sign-in opens in its own tab; bring the chat back in front. */
    async returnToOpenWork() {
      await base.app.client.send("Page.bringToFront");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
