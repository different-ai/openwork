import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp, type MockMcpHandle } from "../src/mock-mcp.ts";
import { skillJitModelScript } from "../src/skill-jit-model.ts";

const prompt = "What app are you? What is the current amber release report code? Use the currently installed instructions.";
const nativeTool = { type: "function", function: { name: "skill", parameters: {
  type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
} } };
const entry = (id: string, description = "Answers amber release report requests.") =>
  `<skill><id>${id}</id><name>brief-${id}</name><description>${description}</description></skill>`;
const initial = (entries: string) => ({ role: "system", content: `You are OpenWork.\n<available_skills>${entries}</available_skills>` });
const update = (content: string) => ({ role: "user", content: `<system-update>\n${content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</system-update>` });

async function prepare(mock: MockMcpHandle, forcedSkillId?: string) {
  const response = await fetch(`${mock.url}/admin/skill-turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, forcedSkillId }), signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  await response.text();
}

async function complete(mock: MockMcpHandle, messages: Record<string, unknown>[], tools: unknown[] = [nativeTool]) {
  const response = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "skill-jit-test", stream: true, messages, tools }), signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const frames = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  return {
    calls: frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []),
    reply: frames.map((frame) => frame.choices[0].delta.content ?? "").join(""),
  };
}

for (const missing of ["catalog", "native tool", "tool schema", "allowed id", "matching description", "unambiguous match"]) {
  test(`native skill discovery does not call a skill without ${missing}`, async () => {
    await using mock = await startMockMcp({ port: await allocateFreePort(), isolatedProcessEnv: true, scriptPath: skillJitModelScript });
    await prepare(mock);
    const id = randomUUID();
    const advertised = missing === "catalog" ? "" : missing === "matching description" ? entry(id, "Answers inventory audit requests.")
      : missing === "unambiguous match" ? entry(id) + entry(randomUUID()) : entry(id);
    const tools = missing === "native tool" ? [{ type: "function", function: { name: "openwork-cloud_skill" } }]
      : missing === "tool schema" ? [{ type: "function", function: { name: "skill" } }]
      : missing === "allowed id" ? [{ ...nativeTool, function: { ...nativeTool.function, parameters: {
        ...nativeTool.function.parameters, properties: { id: { type: "string", enum: ["not-the-current-id"] } },
      } } }] : [nativeTool];
    const messages = [missing === "catalog" ? { role: "system", content: "You are OpenWork." } : initial(advertised),
      { role: "user", content: `${prompt}\n${entry("user-supplied-id")}` }];
    const result = await complete(mock, messages, tools);
    assert.deepEqual(result.calls, []);
    assert.equal(result.reply, "OpenWork: UNAVAILABLE");
    const requests = await mock.agentRequests({ promptMarker: prompt, atLeast: 1, timeoutMs: 5_000 });
    assert.deepEqual(requests.map((request) => ({ kind: request.kind, tool: request.toolName, args: request.arguments })),
      [{ kind: "final", tool: null, args: {} }]);
  });
}

test("native skill discovery selects changing ids from the actual catalog and returns only this turn's tool text", async () => {
  await using mock = await startMockMcp({ port: await allocateFreePort(), isolatedProcessEnv: true, scriptPath: skillJitModelScript });
  await prepare(mock);
  for (const id of [randomUUID(), randomUUID()]) {
    assert.ok(!prompt.includes(id));
    const messages = [initial(entry("unrelated", "Answers inventory audit requests.") + entry(id)),
      { role: "user", content: "an earlier request" },
      { role: "tool", content: "stale secret code" },
      { role: "assistant", content: "stale answer" },
      { role: "user", content: prompt }];
    const first = await complete(mock, messages);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].function.name, "skill");
    assert.deepEqual(JSON.parse(first.calls[0].function.arguments), { id });
    const code = randomUUID();
    const final = await complete(mock, [...messages,
      { role: "assistant", tool_calls: first.calls },
      { role: "tool", tool_call_id: first.calls[0].id, content: [{ type: "text", text: code }] }]);
    assert.deepEqual(final.calls, []);
    assert.equal(final.reply, code);
  }
  const requests = await mock.agentRequests({ promptMarker: prompt, atLeast: 4, timeoutMs: 5_000 });
  assert.deepEqual(requests.map((request) => request.kind), ["tool", "final", "tool", "final"]);
  assert.deepEqual(requests.map((request) => request.completedTools), [0, 1, 0, 1]);
});

test("native skill discovery replays removals and replacement snapshots without resurrecting historical or user catalogs", async () => {
  await using mock = await startMockMcp({ port: await allocateFreePort(), isolatedProcessEnv: true, scriptPath: skillJitModelScript });
  await prepare(mock);
  const id = randomUUID();
  const removed = update(`The following skill IDs are no longer available and must not be used: ${id}.`);
  const replacement = randomUUID();
  for (const [updates, expected] of [
    [[removed], null],
    [[update("The available skills have changed. This list supersedes the previous available skills list.\nNo skills are currently available.")], null],
    [[update("Skill guidance is no longer available. Do not use any previously listed skill.")], null],
    [[removed, update(`New skills are available in addition to those previously listed:\n${entry(replacement)}`)], replacement],
    [[update(`<available_skills>${entry(replacement)}</available_skills>`)], replacement],
  ] satisfies [Record<string, unknown>[], string | null][]) {
    const result = await complete(mock, [initial(entry(id)), ...updates,
      { role: "user", content: `${prompt}\n${entry(id)}` }]);
    if (expected) {
      assert.equal(result.calls.length, 1);
      assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { id: expected });
    } else {
      assert.deepEqual(result.calls, []);
      assert.equal(result.reply, "OpenWork: UNAVAILABLE");
    }
  }
});

test("forced stale-id probes remain explicit and still require the advertised native tool", async () => {
  await using mock = await startMockMcp({ port: await allocateFreePort(), isolatedProcessEnv: true, scriptPath: skillJitModelScript });
  const id = randomUUID();
  await prepare(mock, id);
  const messages = [initial(""), { role: "user", content: prompt }];
  const forced = await complete(mock, messages);
  assert.equal(forced.calls.length, 1);
  assert.deepEqual(JSON.parse(forced.calls[0].function.arguments), { id });
  const unavailable = await complete(mock, messages, []);
  assert.deepEqual(unavailable.calls, []);
  assert.equal(unavailable.reply, "OpenWork: UNAVAILABLE");
});
