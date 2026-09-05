import { expect } from "vitest";
import { evalIn } from "@openwork/behaviors";
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
  return { status: result.status, json: result.json };
}

test("v2 uses an MCP added through OpenWork on the next call and removes it in the same conversation", { timeout: 20 * 60_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const nonce = `REPORT-${Date.now()}`;
  await using den = await server({
    place,
    org: { name: "V2 MCP Lifecycle", members: { member: { name: "MCP Member" } } },
    mocks: { witness: mcpMock({ allowUnauthenticatedMcp: true, tools: [{
      name: "read_report", description: "Read the current test report", inputSchema: { type: "object", properties: {} },
      result: { content: [{ type: "text", text: nonce }] },
    }] }) },
  });
  await using desktop = await app({ den, as: "member", place });
  const workspaceId = desktop.workspaceId;
  const root = `/workspace/${workspaceId}`;
  const v2 = `${root}/opencode2`;
  expect((await request(desktop, `${root}/config`, "PATCH", { opencode: { provider: {
    "reload-witness": { npm: "@ai-sdk/openai-compatible", name: "Reload Witness",
      options: { baseURL: `${den.mocks.witness.url}/v1`, apiKey: "eval-only-key" },
      models: { "mock-agent-workload-model": { name: "Reload Witness", tool_call: true } } },
  } } })).status).toBe(200);
  expect((await request(desktop, "/experimental/engine-v2-preview", "PUT", { enabled: true, chatRouting: true })).status).toBe(200);
  const status = await eventually(async () => (await request(desktop, "/experimental/engine-v2-preview/status")).json, {
    within: 180_000, intervalMs: 1_000, label: "v2 provider and process ready",
    until: (value) => record(value) && value.running === true && Array.isArray(value.mirroredProviderIds) && value.mirroredProviderIds.includes("reload-witness"),
  });
  if (!record(status) || typeof status.pid !== "number") throw new Error("Missing v2 process identity");
  const pid = status.pid;
  const created = await request(desktop, `${v2}/api/session`, "POST", { model: { providerID: "reload-witness", id: "mock-agent-workload-model" } });
  expect(created.status).toBe(200);
  const data = record(created.json) ? created.json.data : undefined;
  if (!record(data) || typeof data.id !== "string") throw new Error("Missing v2 session");
  const sessionId = data.id;
  let executions = 0;
  const toolCode = 'return await tools["reload-witness"].read_report({});';
  async function turn(stage: string, useTool: boolean) {
    const marker = `RELOAD-${stage}-${Date.now()}`;
    const reply = `DONE-${stage}-${Date.now()}`;
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
    const next = (await request(desktop, "/experimental/engine-v2-preview/status")).json;
    expect(record(next) ? next.pid : null).toBe(pid);
    return { messages, sinceIso };
  }
  await turn("before", false);
  const mcpConfig = { type: "remote", url: den.mocks.witness.mcpUrl, oauth: false };
  expect((await request(desktop, `${root}/mcp`, "POST", { name: "reload-witness", config: mcpConfig })).status).toBe(200);
  const used = await turn("added", true);
  expect(used.messages).toContain(nonce);
  expect((await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: used.sinceIso, atLeast: 1 })).length).toBeGreaterThan(0);
  evidence.recordAssertionEvidence("a real OpenWork connection becomes executable on the next v2 call without restarting", "The same session executed the report through native Code Mode and the mock MCP served its independent report nonce after POST /workspace/:id/mcp. The v2 pid remained unchanged.", true);
  expect((await request(desktop, `${v2}/api/mcp/reload-witness`, "PUT", { config: mcpConfig })).status).toBe(403);
  expect((await request(desktop, `${root}/mcp/reload-witness`, "DELETE")).status).toBe(200);
  const removed = await turn("removed", true);
  expect(await den.mocks.witness.toolCalls({ name: "read_report", sinceIso: removed.sinceIso })).toHaveLength(0);
  expect(JSON.stringify((await request(desktop, `${v2}/api/mcp`)).json)).not.toContain("reload-witness");
  expect((await request(desktop, `${root}/opencode/global/health`)).status).toBe(200);
  evidence.recordAssertionEvidence("removal reaches the next call and v1 remains available", "After DELETE through OpenWork, the native catalog no longer contained the connection and an attempted Code Mode execution in the original conversation served no new MCP calls. The same v2 process and the v1 health endpoint remained available. Direct v2 MCP mutation was denied.", true);
});
