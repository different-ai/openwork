import { expect } from "vitest";
import { createHash } from "node:crypto";
import { control, evalIn, assertNoLiveSecret, liveOpenAiEnabled, liveOpenAiModel, provisionLiveOpenAi, liveProviderId, liveV2Turn } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { app, eventually, mcpMock, needs, server, test } from "@openwork/testkit";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Missing probe value");
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function request(surface: Surface, path: string, method = "GET", body?: unknown) {
  const result = await evalIn(surface, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + ${literal(path)}, {
      method: ${literal(method)}, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ${body === undefined ? "" : `body: ${literal(JSON.stringify(body))},`}
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = text; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json };
  })()`, { awaitPromise: true, timeoutMs: 65_000 });
  if (!record(result) || typeof result.status !== "number") throw new Error("Invalid server response");
  assertNoLiveSecret(result.json);
  return { status: result.status, json: result.json };
}

test("v2 uses an MCP added through OpenWork on the next call and removes it in the same conversation", { timeout: 20 * 60_000 }, async ({ place, evidence }) => {
  const live = liveOpenAiEnabled();
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], ...(live ? { env: ["OPENAI_API_KEY"], daytona: true } : {}) });
  const nonce = `REPORT-${Date.now()}`;
  await using den = await server({
    place,
    org: { name: "V2 MCP Lifecycle", members: { member: { name: "MCP Member" } } },
    mocks: { witness: mcpMock({ allowUnauthenticatedMcp: true, tools: [{
      name: "read_report", description: "Read the current test report", inputSchema: { type: "object", properties: {} },
      result: { content: [{ type: "text", text: nonce }] },
    }] }) },
  });
  await using managed = await provisionLiveOpenAi(den.admin, "V2 MCP Lifecycle");
  await using desktop = await app({ den, as: "member", place });
  const api = (path: string, method?: string, body?: unknown) => request(desktop, path, method, body);
  const providerId = live ? await liveProviderId(api, managed.id) : "reload-witness";
  const modelId = live ? liveOpenAiModel() : "mock-agent-workload-model";
  const workspaceId = desktop.workspaceId;
  const root = `/workspace/${workspaceId}`;
  const v2 = `${root}/opencode2`;
  if (!live) expect((await request(desktop, `${root}/config`, "PATCH", { opencode: { provider: {
    "reload-witness": { npm: "@ai-sdk/openai-compatible", name: "Reload Witness",
      options: { baseURL: `${den.mocks.witness.url}/v1`, apiKey: "eval-only-key" },
      models: { "mock-agent-workload-model": { name: "Reload Witness", tool_call: true } } },
  } } })).status).toBe(200);
  expect((await request(desktop, "/experimental/engine-v2-preview", "PUT", { enabled: true, chatRouting: true })).status).toBe(200);
  const status = await eventually(async () => (await request(desktop, "/experimental/engine-v2-preview/status")).json, {
    within: 180_000, intervalMs: 1_000, label: "v2 provider and process ready",
    until: (value) => record(value) && value.running === true && Array.isArray(value.mirroredProviderIds) && value.mirroredProviderIds.includes(providerId),
  });
  if (!record(status) || typeof status.pid !== "number") throw new Error("Missing v2 process identity");
  const pid = status.pid;
  const created = await request(desktop, `${v2}/api/session`, "POST", { model: { providerID: providerId, id: modelId } });
  expect(created.status).toBe(200);
  const data = record(created.json) ? created.json.data : undefined;
  if (!record(data) || typeof data.id !== "string") throw new Error("Missing v2 session");
  const sessionId = data.id;
  if (live) {
    const catalog = (await api(`${v2}/api/mcp`)).json;
    const cloud = record(catalog) && Array.isArray(catalog.data) ? catalog.data.find((item) => record(item) && item.name === "openwork-cloud") : null;
    expect(record(cloud) && record(cloud.status) ? cloud.status.status : null).toBe("connected");
    const discovery = await liveV2Turn(api, v2, sessionId,
      "Use OpenWork Cloud to discover whether connected Slack capabilities are available to me. "
      + "Report SLACK_CONNECTED only if discovery confirms access, otherwise report SLACK_NOT_CONNECTED, followed by a brief explanation. "
      + "Check the connected integration before answering. Do not read Slack messages, send anything, or use files or shell commands.");
    const messages: unknown = JSON.parse(discovery.messages);
    const parts = Array.isArray(messages) ? messages.filter(record).flatMap((message) => Array.isArray(message.content) ? message.content.filter(record) : []) : [];
    expect(parts.some((part) => part.type === "tool" && part.name === "execute" && record(part.state)
      && part.state.status === "completed" && record(part.state.metadata) && Array.isArray(part.state.metadata.toolCalls)
      && part.state.metadata.toolCalls.some((call) => record(call) && call.tool === "openwork-cloud.search_capabilities" && call.status === "completed"
        && record(call.input) && typeof call.input.query === "string" && /slack/i.test(call.input.query)))).toBe(true);
    // This fresh organization has no Slack connection or account credentials.
    expect(discovery.text).toContain("SLACK_NOT_CONNECTED");
    expect(discovery.text).not.toContain("SLACK_CONNECTED");
    evidence.recordAssertionEvidence("the real model discovers OpenWork Cloud capabilities through the managed connection",
      `${modelId} received openwork-cloud from normal sign-in, completed native Code Mode discovery with a Slack query, and correctly reported SLACK_NOT_CONNECTED for the fresh organization without a Slack account. This does not establish access to a real user's Slack; no Slack messages were read or sent.`, true);
  }
  let executions = 0;
  const toolCode = 'return await tools["reload-witness"].read_report({});';
  async function turn(stage: string, useTool: boolean) {
    if (live) {
      const result = await liveV2Turn(api, v2, sessionId,
        "Get the current verification report using the connected report tool. Discover the currently available tools yourself. "
        + "Fetch fresh data; never reuse a report from earlier messages. If the report tool is unavailable, say UNAVAILABLE. "
        + "Do not use files, shell, environment variables, or the internet. Return the report code briefly.");
      if (useTool && stage !== "removed") expect(result.text).toContain(nonce);
      else expect(result.text).toMatch(/unavailable/i);
      const next = (await api("/experimental/engine-v2-preview/status")).json;
      expect(record(next) ? next.pid : null).toBe(pid);
      return result;
    }
    const marker = `RELOAD-${stage}-${Date.now()}`;
    const reply = `DONE-${stage}-${Date.now()}`;
    const prior = stage === "removed" ? (await api(`${v2}/api/session/${sessionId}/message`)).json : null;
    const priorIds = new Set(record(prior) && Array.isArray(prior.data) ? prior.data.filter(record).map((message) => message.id) : []);
    if (useTool) executions++;
    const setup = await fetch(`${den.mocks.witness.url}/admin/agent-workloads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: marker, finalReply: reply,
        steps: useTool ? Array.from({ length: executions }, () => ({ tool: "execute", arguments: { code: toolCode } })) : [] }] }),
    });
    expect(setup.ok).toBe(true);
    const sinceIso = new Date().toISOString();
    expect((await request(desktop, `${v2}/api/session/${sessionId}/prompt`, "POST", { text: `Read the current report if available. Request ${marker}.` })).status).toBe(200);
    const messages = await eventually(async () => {
      const permissions = (await request(desktop, `${v2}/api/session/${sessionId}/permission`)).json;
      if (record(permissions) && Array.isArray(permissions.data)) for (const permission of permissions.data) {
        if (record(permission) && typeof permission.id === "string") {
          const approved = await request(desktop, `${v2}/api/session/${sessionId}/permission/${permission.id}/reply`, "POST", { reply: "once" });
          expect([200, 204]).toContain(approved.status);
        }
      }
      return JSON.stringify((await request(desktop, `${v2}/api/session/${sessionId}/message`)).json);
    }, {
      within: 90_000, intervalMs: 500, label: `${stage} reply`, until: (text) => text.includes(reply),
    });
    const calls = await den.mocks.witness.agentRequests({ promptMarker: marker, sinceIso, atLeast: 1 });
    expect(calls.some((call) => call.kind === "error")).toBe(false);
    expect(calls.some((call) => call.kind === "tool" && call.toolName?.endsWith("execute"))).toBe(useTool);
    if (stage === "removed") {
      const payload: unknown = JSON.parse(messages);
      const fresh = record(payload) && Array.isArray(payload.data) ? payload.data.filter(record).filter((message) => !priorIds.has(message.id)) : [];
      const executions = fresh.flatMap((message) => Array.isArray(message.content) ? message.content.filter(record) : [])
        .filter((part) => part.type === "tool" && part.name === "execute");
      expect(executions).toHaveLength(1);
      const state = executions[0]?.state;
      if (!record(state)) throw new Error("Missing post-removal Code Mode result");
      expect(state.status).toBe("completed");
      expect(record(state.metadata) && state.metadata.error === true).toBe(true);
      const output = Array.isArray(state.content) ? state.content.filter(record).filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
      expect(output).toContain("Unknown tool 'reload-witness.read_report'");
    }
    const next = (await request(desktop, "/experimental/engine-v2-preview/status")).json;
    expect(record(next) ? next.pid : null).toBe(pid);
    return { messages, sinceIso };
  }
  const before = await turn("before", false);
  if (live) expect(before.messages).not.toContain(nonce);
  const mcpConfig = { type: "remote", url: den.mocks.witness.mcpUrl, oauth: false,
    headers: { Authorization: "Bearer eval-mcp-first" } };
  expect((await request(desktop, `${root}/mcp`, "POST", { name: "reload-witness", config: mcpConfig })).status).toBe(200);
  const used = await turn("added", true);
  expect(used.messages).toContain(nonce);
  expect((await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: used.sinceIso, atLeast: 1 })).length).toBeGreaterThan(0);
  evidence.recordAssertionEvidence("a real OpenWork connection becomes executable on the next v2 call without restarting", "The same session executed the report through native Code Mode and the mock MCP served its independent report nonce after POST /workspace/:id/mcp. The v2 pid remained unchanged.", true);
  expect((await request(desktop, `${v2}/api/mcp/reload-witness`, "PUT", { config: mcpConfig })).status).toBe(403);
  expect((await request(desktop, `${root}/mcp`, "POST", { name: "reload-witness",
    config: { ...mcpConfig, headers: { Authorization: "Bearer eval-mcp-second" } } })).status).toBe(200);
  const updated = await turn("updated", true);
  expect(updated.messages).toContain(nonce);
  const updatedCalls = await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: updated.sinceIso, atLeast: 1 });
  const secondToken = createHash("sha256").update("eval-mcp-second").digest("hex").slice(0, 12);
  expect(updatedCalls.length).toBeGreaterThan(0);
  expect(updatedCalls.every((call) => call.tokenId === secondToken)).toBe(true);
  const workspaces = (await request(desktop, "/workspaces")).json;
  const current = record(workspaces) && Array.isArray(workspaces.items)
    ? workspaces.items.find((item) => record(item) && item.id === workspaceId) : undefined;
  if (!record(current) || typeof current.path !== "string") throw new Error("Missing workspace path");
  const otherPath = `${current.path}-unrelated`;
  await control(desktop, "workspace.create", { path: otherPath }, { timeoutMs: 90_000 });
  const otherId = await eventually(async () => {
    const listing = (await request(desktop, "/workspaces")).json;
    const other = record(listing) && Array.isArray(listing.items)
      ? listing.items.find((item) => record(item) && item.path === otherPath) : undefined;
    return record(other) && typeof other.id === "string" ? other.id : "";
  }, { within: 90_000, intervalMs: 500, label: "separate workspace created", until: Boolean });
  expect(otherId).not.toBe(workspaceId);
  const otherCatalog = await request(desktop, `/workspace/${otherId}/opencode2/api/mcp`);
  expect(otherCatalog.status).toBe(200);
  expect(JSON.stringify(otherCatalog.json)).not.toContain("reload-witness");
  expect(JSON.stringify((await request(desktop, `${v2}/api/mcp`)).json)).toContain("reload-witness");
  evidence.recordAssertionEvidence("credential replacement stays scoped to the original workspace", "Updating the existing connection through OpenWork caused the next call to use only the replacement credential fingerprint. A separately created workspace did not receive this MCP, while the original workspace retained it and the same v2 process.", true);
  expect((await request(desktop, `${root}/mcp/reload-witness`, "DELETE")).status).toBe(200);
  const removed = await turn("removed", true);
  expect(await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: removed.sinceIso })).toHaveLength(0);
  expect(JSON.stringify((await request(desktop, `${v2}/api/mcp`)).json)).not.toContain("reload-witness");
  if (live) {
    expect(removed.messages).toMatch(/unavailable/i);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await api(`${root}/mcp`, "POST", { name: "reload-witness", config: mcpConfig })).status).toBe(200);
      const recovered = await turn(`reconnected-${cycle}`, true);
      expect(recovered.messages).toContain(nonce);
      expect((await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: recovered.sinceIso, atLeast: 1 })).length).toBeGreaterThan(0);
      expect((await api(`${root}/mcp/reload-witness/enabled`, "POST", { enabled: false })).status).toBe(200);
      const disabled = await turn(`disabled-${cycle}`, false);
      expect(disabled.messages).toMatch(/unavailable/i);
      expect(await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: disabled.sinceIso })).toHaveLength(0);
      expect((await api(`${root}/mcp/reload-witness/enabled`, "POST", { enabled: true })).status).toBe(200);
      const enabled = await turn(`enabled-${cycle}`, true);
      expect((await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: enabled.sinceIso, atLeast: 1 })).length).toBeGreaterThan(0);
      expect((await api(`${root}/mcp/reload-witness`, "DELETE")).status).toBe(200);
    }
    evidence.recordAssertionEvidence("real OpenAI discovers live MCP changes across repeated lifecycle cycles",
      `${modelId} made unscripted model/tool calls from the Daytona v2 process after managed credential delivery. Two reconnect/disable/enable cycles served actual MCP calls only while enabled, with the original session and process. The credential was absent from all observed public responses.`, true);
  }
  expect((await request(desktop, `${root}/opencode/global/health`)).status).toBe(200);
  evidence.recordAssertionEvidence("removal reaches the next call and v1 remains available", (live ? "Real OpenAI reported UNAVAILABLE after DELETE; " : "A fresh Code Mode attempt to invoke the removed tool returned the explicit Unknown tool 'reload-witness.read_report' error after DELETE; ") + "the native catalog no longer contained the connection and the original conversation served no new MCP calls. The same v2 process and the v1 health endpoint remained available. Direct v2 MCP mutation was denied.", true);
});
