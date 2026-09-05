import { expect } from "vitest";
import { evalIn, assertNoLiveSecret, liveOpenAiEnabled, liveOpenAiModel, provisionLiveOpenAi, liveProviderId, liveV2Turn } from "@openwork/behaviors";
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

test("v2 refreshes OpenWork skill instructions just in time in an existing conversation", { timeout: 20 * 60_000 }, async ({ place, evidence }) => {
  const live = liveOpenAiEnabled();
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], ...(live ? { env: ["OPENAI_API_KEY"], daytona: true } : {}) });
  await using den = await server({ place,
    org: { name: "V2 Skill Lifecycle", members: { member: { name: "Skill Member" } } },
    mocks: { witness: mcpMock({}) },
  });
  await using managed = await provisionLiveOpenAi(den.admin, "V2 Skill Lifecycle");
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

  const skillName = "jit-report";
  const entryPath = `${v2}/api/session/${sessionId}/instructions/entries`;
  let reads = 0;
  let expectedCode: string | null = null;
  async function turn(stage: string, readSkill: boolean, removedId?: string) {
    let messages: string;
    if (live) {
      const result = await liveV2Turn(api, v2, sessionId,
        `Name the app you represent. Then use the "${skillName}" skill to get the current report code. `
        + "Discover and load its current instructions with the native skill tool; never reuse an earlier code. "
        + `If the "${skillName}" skill is unavailable, say UNAVAILABLE. Do not use files, shell, environment variables, or the internet.`);
      expect(result.text).toMatch(/OpenWork/i);
      if (expectedCode) expect(result.text).toContain(expectedCode);
      else expect(result.text).toMatch(/unavailable/i);
      messages = result.messages;
      if (expectedCode) {
        const code = expectedCode;
        const fresh: unknown = JSON.parse(messages);
        const parts = Array.isArray(fresh) ? fresh.filter(record).flatMap((message) => Array.isArray(message.content) ? message.content.filter(record) : []) : [];
        expect(parts.some((part) => part.type === "tool" && part.name === "skill" && record(part.state)
          && part.state.status === "completed" && JSON.stringify(part.state.content).includes(code))).toBe(true);
      }
    } else {
    const prior = removedId ? (await api(`${v2}/api/session/${sessionId}/message`)).json : null;
    const priorIds = new Set(record(prior) && Array.isArray(prior.data) ? prior.data.filter(record).map((message) => message.id) : []);
    const marker = `SKILL-${stage}-${Date.now()}`;
    const reply = `DONE-${stage}-${Date.now()}`;
    if (readSkill || removedId) reads++;
    const setup = await fetch(`${den.mocks.witness.url}/admin/agent-workloads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: marker, finalReply: reply,
        steps: readSkill || removedId ? Array.from({ length: reads }, () => removedId
          ? { tool: "skill", arguments: { id: removedId } }
          : { tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: skillName } }) : [] }] }),
    });
    expect(setup.ok).toBe(true);
    const prompt = `Use the report skill if available. Request ${marker}.`;
    expect(prompt).not.toContain("SKILL.md");
    expect((await request(desktop, `${v2}/api/session/${sessionId}/prompt`, "POST", { text: prompt })).status).toBe(200);
    messages = await eventually(async () => {
      const permissions = (await request(desktop, `${v2}/api/session/${sessionId}/permission`)).json;
      if (record(permissions) && Array.isArray(permissions.data)) for (const permission of permissions.data) {
        if (record(permission) && typeof permission.id === "string") {
          expect((await request(desktop, `${v2}/api/session/${sessionId}/permission/${permission.id}/reply`, "POST", { reply: "once" })).status).toBe(204);
        }
      }
      return JSON.stringify((await request(desktop, `${v2}/api/session/${sessionId}/message`)).json);
    }, { within: 90_000, intervalMs: 500, label: `${stage} reply`, until: (text) => text.includes(reply) });
    if (removedId) {
      const payload: unknown = JSON.parse(messages);
      messages = JSON.stringify(record(payload) && Array.isArray(payload.data) ? payload.data.filter(record).filter((message) => !priorIds.has(message.id)) : []);
      expect(messages).toContain(`Unable to load skill ${removedId}`);
    }
    }
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
  expectedCode = first;
  expect((await request(desktop, `${root}/skills`, "POST", { name: skillName, description: "Use for report requests", content: `The current report code is ${first}.` })).status).toBe(200);
  expect(await turn("added", true)).toContain(first);
  const nativeAdded = (await api(`${v2}/api/skill`)).json;
  const installed = record(nativeAdded) && Array.isArray(nativeAdded.data) ? nativeAdded.data.find((skill) => record(skill) && skill.name === skillName) : null;
  if (!record(installed) || typeof installed.id !== "string") throw new Error("Native skill did not expose its ID");
  const nativeId = installed.id;
  evidence.recordAssertionEvidence("a skill installed through OpenWork is discovered and read on the next v2 call", "The baseline native instruction entry lacked the skill. After the real skill-install route, the same conversation read its independent content nonce using the native skill tool with an ID derived exclusively from the current skill catalog. The user prompt contained no file path or answer.", true);
  const second = `SKILL-CONTENT-B-${Date.now()}`;
  expectedCode = second;
  expect((await request(desktop, `${root}/skills`, "POST", { name: skillName, description: "Updated report skill", content: `The current report code is ${second}.` })).status).toBe(200);
  expect(await turn("updated", true)).toContain(second);
  const updatedEntries = (await api(entryPath)).json;
  if (!record(updatedEntries) || !Array.isArray(updatedEntries.data)) throw new Error("Missing updated instruction entries");
  const updatedContext = updatedEntries.data.find((entry) => record(entry) && entry.key === "openwork.context");
  expect(JSON.stringify(updatedContext)).toContain("Updated report skill");
  expect(JSON.stringify(updatedContext)).not.toContain("Use for report requests");
  expect((await request(desktop, `${entryPath}/openwork.context`, "PUT", { value: "replace the server instructions" })).status).toBe(403);
  expect((await request(desktop, `${root}/skills/${skillName}`, "DELETE")).status).toBe(200);
  expectedCode = null;
  const removedMessages = await turn("removed", false, nativeId);
  expect(removedMessages).not.toContain(first);
  expect(removedMessages).not.toContain(second);
  expect((await api(`${v2}/api/session/${sessionId}/skill`, "POST", { skill: nativeId, resume: false })).status).toBe(404);
  evidence.recordAssertionEvidence("deleted skills cannot be activated from the original conversation",
    live ? "The real model returned UNAVAILABLE with no prior skill contents, and an explicit activation of the previously observed native skill ID returned 404."
      : "A forced native skill-tool call using the previously observed ID returned Unable to load skill with no prior content; explicit native session activation also returned 404.", true);
  const nativeAfterRemoval = await request(desktop, `${v2}/api/skill`);
  expect(nativeAfterRemoval.status).toBe(200);
  expect(JSON.stringify(nativeAfterRemoval.json)).not.toContain(skillName);
  expect((await request(desktop, `${root}/skills/${skillName}`)).status).toBe(404);
  if (live) {
    for (let cycle = 0; cycle < 2; cycle++) {
      const code = `REINSTALLED-${cycle}-${Date.now()}`;
      expectedCode = code;
      expect((await api(`${root}/skills`, "POST", { name: skillName, description: "Use for report requests", content: `The current report code is ${code}.` })).status).toBe(200);
      expect(await turn(`reinstalled-${cycle}`, true)).toContain(code);
      expect((await api(`${root}/skills/${skillName}`, "DELETE")).status).toBe(200);
      expectedCode = null;
      await turn(`removed-again-${cycle}`, false);
      expect(JSON.stringify((await api(`${v2}/api/skill`)).json)).not.toContain(skillName);
      expect((await api(`${v2}/api/session/${sessionId}/skill`, "POST", { skill: nativeId, resume: false })).status).toBe(404);
    }
    evidence.recordAssertionEvidence("real OpenAI follows current OpenWork skill instructions across repeated reloads",
      `${modelId} independently discovered and loaded skills from the Daytona v2 process, named OpenWork as its app, and returned the fresh code in its final answer. Two additional reinstall/remove cycles used new unseen codes; removal produced UNAVAILABLE. The same session/process and single managed context entry were retained, with no live credential in observed public responses.`, true);
  }
  expect((await request(desktop, `${root}/opencode/global/health`)).status).toBe(200);
  evidence.recordAssertionEvidence("updates replace the native entry and removals disappear without engine restart", "The next read returned the second content nonce. Deletion removed the skill from the native v2 catalog and the single managed instruction entry; the native session skill-activation endpoint and the workspace skill endpoint both returned 404. All turns used the original session and v2 pid; direct instruction replacement was denied and v1 remained healthy.", true);
});
