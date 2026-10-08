import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineParity } from "../worlds/engine-parity.ts";

const test = spec.world(engineParity, { timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rows(value: unknown): Record<string, unknown>[] {
  const data = record(value) ? value.data : value;
  return Array.isArray(data) ? data.filter(record) : [];
}
function toolOutputs(value: unknown): string[] {
  return rows(value).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(record)
    .filter(part => part.type === "tool" && record(part.state) && part.state.status === "completed")
    .flatMap(part => record(part.state) && Array.isArray(part.state.content) ? part.state.content : []).filter(record)
    .filter(part => part.type === "text" && typeof part.text === "string").map(part => String(part.text));
}

test("V2-CONTEXT-ACTIVITY: query another chat and track a background child after its parent finishes", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "model ready", until: state => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  await user.type("composer", world.prompt);
  await user.click("Run task");
  await user.see({ text: world.reply });
  await user.see("Run task");
  const route = await world.route();
  const workspaceId = /\/workspace\/([^/]+)\/session/.exec(route)?.[1];
  const parentId = route.split("/").at(-1);
  if (!workspaceId || !parentId) throw new Error("Missing saved conversation");
  const base = `/workspace/${workspaceId}/opencode2/api`;
  // Use an explicit synthetic provider so moving outside the starter workspace
  // cannot fall back to a built-in provider's real endpoint.
  expect((await world.request(`/workspace/${workspaceId}/config`, "PATCH", { opencode: {
    provider: { "context-witness": { npm: "@ai-sdk/openai-compatible", name: "Context witness",
      options: { baseURL: `${world.mock.url}/v1`, apiKey: "synthetic-context-only" },
      models: { "context-model": { name: "Context witness" } },
    } },
  } })).status).toBeLessThan(300);
  expect((await world.request(`/workspace/${workspaceId}/engine/reload`, "POST")).status).toBeLessThan(300);
  await probe.eventually(async () => JSON.stringify((await world.request(`${base}/model`)).body), {
    within: 45_000, label: "synthetic context provider ready", until: text => text.includes("context-witness"),
  });
  const sourceTitle = `Context source ${randomUUID()}`;
  const fact = `The reference word is ${randomUUID()}`;
  const movedDirectory = `${world.workspacePath}-moved`;
  await mkdir(movedDirectory, { recursive: true });
  expect((await fetch(`${world.mock.url}/admin/agent-workloads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workloads: [{
    promptMarker: fact, finalReply: "Reference saved.", steps: [{ tool: "execute", arguments: { code: `return await tools.opencode.session_move({directory: ${JSON.stringify(movedDirectory)}})` } }],
  }] }) })).ok).toBe(true);
  const created = await world.request(`${base}/session`, "POST", { title: sourceTitle,
    location: { directory: world.workspacePath }, model: { providerID: "context-witness", id: "context-model" } });
  const source = record(created.body) && record(created.body.data) ? created.body.data : {};
  if (typeof source.id !== "string") throw new Error("Source conversation missing");
  expect((await world.request(`${base}/session/${source.id}/prompt`, "POST", { text: fact })).status).toBeLessThan(300);
  await probe.eventually(async () => JSON.stringify((await world.request(`${base}/session/${source.id}/message`)).body), {
    within: 45_000, label: "reference saved natively", until: text => text.includes("Reference saved."),
  });
  await step("The native model discovers context and reads a separate conversation", async () => {
    const prompt = `Read the reference from the other conversation ${randomUUID()}`;
    const answer = `Context query complete ${randomUUID()}`;
    await world.prepareTurn(prompt, answer, [
      { tool: "openwork_context", arguments: {} },
      { tool: "openwork_query", arguments: { id: "session.search", args: { query: sourceTitle } } },
      { tool: "openwork_query", arguments: { id: "session.read", args: { sessionId: source.id, workspaceId } } },
    ]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: answer }, { timeoutMs: 90_000 });
    const history = await world.request(`${base}/session/${parentId}/message?limit=50`);
    const outputs = toolOutputs(history.body);
    evidence.recordJsonArtifact("Native context tool results", outputs);
    expect(outputs.some(text => text.includes("session.search") && text.includes("session.read"))).toBe(true);
    expect(outputs.some(text => text.includes(sourceTitle))).toBe(true);
    expect(outputs.some(text => text.includes(fact))).toBe(true);
    expect(await world.route()).toBe(route);
    await user.screenshot();
  });
  await step("A completed delegation stays Working while its native child is running", async () => {
    const prompt = `Delegate a background review ${randomUUID()}`;
    const childPrompt = `BACKGROUND-HOLD-${randomUUID()}`;
    const parentReply = `The review continues in the background ${randomUUID()}`;
    const title = "Review the reference in background";
    const activityPrompt = `Check background activity ${randomUUID()}`;
    const activityReply = `Background activity checked ${randomUUID()}`;
    const completionReply = "The background review is now complete.";
    const response = await fetch(`${world.mock.url}/admin/agent-workloads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: parentReply, steps: [{ tool: "subagent", arguments: { description: title, prompt: childPrompt, agent: "general", background: true } }] },
      { promptMarker: activityPrompt, latestUserTurn: true, finalReply: activityReply, steps: [{ tool: "openwork_query", arguments: { id: "session.read", args: { sessionId: parentId, workspaceId, summary: true } } }] },
      { promptMarker: "Background review finished.", latestUserTurn: true, steps: [], finalReply: completionReply },
      { promptMarker: childPrompt, latestUserTurn: true, steps: [], finalReply: "Background review started. Background review finished.", finalReplyChunks: ["Background review started. ", "Background review finished."], finalReplyInitiallyReleasedChunks: 1 },
    ] }) });
    expect(response.ok).toBe(true);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: parentReply }, { timeoutMs: 60_000 });
    await user.see("Run task");
    const children = rows((await world.request(`${base}/session?limit=100`)).body).filter(row => row.parentID === parentId);
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child || typeof child.id !== "string") throw new Error("Missing child identity");
    const active = (await world.request(`${base}/session/active`)).body;
    expect(record(active) && record(active.data) && active.data[child.id]).toEqual({ type: "running" });
    expect(record(active) && record(active.data) && active.data[parentId]).toBeUndefined();
    await user.see({ text: "1 agent running" });
    await user.type("composer", activityPrompt);
    await user.click("Run task");
    await user.see({ text: activityReply });
    const activityOutputs = toolOutputs((await world.request(`${base}/session/${parentId}/message?limit=50`)).body).map(text => {
      try { const value: unknown = JSON.parse(text); return record(value) && record(value.result) ? value.result : null; } catch { return null; }
    });
    expect(activityOutputs.some(value => value?.sessionId === parentId && value.working === true
      && record(value.descendantActivity) && value.descendantActivity.busy === 1)).toBe(true);
    await probe.eventually(() => probe.eval(() => document.querySelector('[data-subagent-session-id]')?.getAttribute("data-subagent-activity")), {
      within: 15_000, label: "background row remains live", until: value => value === "shimmer",
    });
    await user.screenshot();
    await user.click({ role: "button", label: `${title}. Open sub-agent chat` });
    await user.see({ text: "Background review started." });
    expect((await world.mock.agentReplyState(childPrompt)).complete).toBe(false);
    await user.screenshot();
    // Reloading the parent must recover the running child from native state.
    const parentUrl = await probe.eval(() => location.origin) + route.replace(/^#/, "");
    await user.navigate(parentUrl);
    await user.see({ text: "1 agent running" });
    await world.mock.releaseAgentReply(childPrompt);
    await probe.eventually(() => probe.eval(() => document.querySelector('[data-subagent-session-id]')?.getAttribute("data-subagent-activity")), {
      within: 30_000, label: "background row completes", until: value => value === "completed",
    });
    await user.see({ text: completionReply }, { timeoutMs: 30_000 });
    await user.notSee({ text: "expected one workload marker" });
    await user.notSee({ text: "1 agent running" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Native context and background activity", "The model called real context/search/read tools and read another conversation. The parent became idle while its child stayed visibly working and could be opened.", true);
  });
});
