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

test("v2 refreshes OpenWork skill instructions just in time in an existing conversation", { timeout: 20 * 60_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({ place,
    org: { name: "V2 Skill Lifecycle", members: { member: { name: "Skill Member" } } },
    mocks: { witness: mcpMock({}) },
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

  const skillName = "jit-report";
  const entryPath = `${v2}/api/session/${sessionId}/instructions/entries`;
  let reads = 0;
  async function turn(stage: string, readSkill: boolean) {
    const marker = `SKILL-${stage}-${Date.now()}`;
    const reply = `DONE-${stage}-${Date.now()}`;
    if (readSkill) reads++;
    const setup = await fetch(`${den.mocks.witness.url}/admin/agent-workloads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: marker, finalReply: reply,
        steps: readSkill ? Array.from({ length: reads }, () => ({ tool: "read", argumentsFrom: "skill-catalog", arguments: { skill: skillName } })) : [] }] }),
    });
    expect(setup.ok).toBe(true);
    const prompt = `Use the report skill if available. Request ${marker}.`;
    expect(prompt).not.toContain("SKILL.md");
    expect((await request(desktop, `${v2}/api/session/${sessionId}/prompt`, "POST", { text: prompt })).status).toBe(200);
    const messages = await eventually(async () => {
      const permissions = (await request(desktop, `${v2}/api/session/${sessionId}/permission`)).json;
      if (record(permissions) && Array.isArray(permissions.data)) for (const permission of permissions.data) {
        if (record(permission) && typeof permission.id === "string") {
          expect((await request(desktop, `${v2}/api/session/${sessionId}/permission/${permission.id}/reply`, "POST", { reply: "once" })).status).toBe(200);
        }
      }
      return JSON.stringify((await request(desktop, `${v2}/api/session/${sessionId}/message`)).json);
    }, { within: 90_000, intervalMs: 500, label: `${stage} reply`, until: (text) => text.includes(reply) });
    const entries = (await request(desktop, entryPath)).json;
    if (!record(entries) || !Array.isArray(entries.data)) throw new Error("Missing instruction entries");
    const own = entries.data.filter((entry) => record(entry) && entry.key === "openwork.context");
    expect(own).toHaveLength(1);
    expect(JSON.stringify(own)).toContain("You are OpenWork.");
    expect(JSON.stringify(own).includes(skillName)).toBe(readSkill);
    const next = (await request(desktop, "/experimental/engine-v2-preview/status")).json;
    expect(record(next) ? next.pid : null).toBe(pid);
    return messages;
  }
  await turn("before", false);
  const first = `SKILL-CONTENT-A-${Date.now()}`;
  expect((await request(desktop, `${root}/skills`, "POST", { name: skillName, description: "Use for report requests", content: `The current report code is ${first}.` })).status).toBe(200);
  expect(await turn("added", true)).toContain(first);
  evidence.recordAssertionEvidence("a skill installed through OpenWork is discovered and read on the next v2 call", "The baseline native instruction entry lacked the skill. After the real skill-install route, the same conversation read its independent content nonce using a path derived exclusively from the current system catalog. The user prompt contained no file path or answer.", true);
  const second = `SKILL-CONTENT-B-${Date.now()}`;
  expect((await request(desktop, `${root}/skills`, "POST", { name: skillName, description: "Updated report skill", content: `The current report code is ${second}.` })).status).toBe(200);
  expect(await turn("updated", true)).toContain(second);
  expect((await request(desktop, `${entryPath}/openwork.context`, "PUT", { value: "replace the server instructions" })).status).toBe(403);
  expect((await request(desktop, `${root}/skills/${skillName}`, "DELETE")).status).toBe(200);
  await turn("removed", false);
  expect((await request(desktop, `${root}/skills/${skillName}`)).status).toBe(404);
  expect((await request(desktop, `${root}/opencode/global/health`)).status).toBe(200);
  evidence.recordAssertionEvidence("updates replace the native entry and removals disappear without engine restart", "The next read returned the second content nonce. Deletion removed the skill from the single managed instruction entry and the real skill endpoint returned 404. All four turns used the original session and v2 pid; direct instruction replacement was denied and v1 remained healthy.", true);
});
