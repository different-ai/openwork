import assert from "node:assert/strict";
import test from "node:test";

import {
  MOCK_CLOUD_SKILL_INDEX_SCHEMA,
  MOCK_CLOUD_SKILL_INDEX_URI,
  mockCloudSkillMarkdown,
  startMockCloudSkills,
  type MockCloudSkillsHandle,
} from "../src/mock-cloud-skills.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same minimal Streamable HTTP client the desktop host uses for discovery reads. */
async function readPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return raw.trim() ? JSON.parse(raw) : null;
  const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return data.length ? JSON.parse(data.join("\n")) : null;
}

async function rpc(url: string, token: string | null, body: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return { response, payload: await readPayload(response) };
}

async function readResource(mock: MockCloudSkillsHandle, token: string | null, uri: string): Promise<{ status: number; text: string | null; error: unknown }> {
  const initialized = await rpc(mock.agentUrl, token, {
    id: 1, jsonrpc: "2.0", method: "initialize",
    params: { capabilities: {}, clientInfo: { name: "labs-test", version: "1.0.0" }, protocolVersion: "2025-06-18" },
  });
  if (!initialized.response.ok) return { status: initialized.response.status, text: null, error: null };
  const result = isRecord(initialized.payload) && isRecord(initialized.payload.result) ? initialized.payload.result : null;
  assert.equal(result?.protocolVersion, "2025-06-18");
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize returns a session id");
  const session = { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" };
  const notified = await rpc(mock.agentUrl, token, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session);
  assert.equal(notified.response.status, 202);
  assert.equal(notified.payload, null);
  const read = await rpc(mock.agentUrl, token, { id: 2, jsonrpc: "2.0", method: "resources/read", params: { uri } }, session);
  const payload = isRecord(read.payload) ? read.payload : {};
  const contents = isRecord(payload.result) && Array.isArray(payload.result.contents) ? payload.result.contents : [];
  const match = contents.find((item) => isRecord(item) && item.uri === uri && typeof item.text === "string");
  return { status: read.response.status, text: isRecord(match) && typeof match.text === "string" ? match.text : null, error: payload.error ?? null };
}

for (const transport of ["sse", "json"] as const) {
  test(`${transport}: identities read only their own index and bodies; the log names identities, never credentials`, async () => {
    await using mock = await startMockCloudSkills({ identities: ["account-a", "account-b"], transport });
    const tokenA = mock.credential("account-a");
    const tokenB = mock.credential("account-b");
    assert.notEqual(tokenA, tokenB);
    mock.publishSkill("account-a", { name: "amber-report", description: "Amber report for A", body: "Reply with CODE-A." });
    mock.publishSkill("account-b", { name: "amber-report", description: "Amber report for B", body: "Reply with CODE-B." });
    mock.publishSkill("account-a", { name: "only-a", description: "Only A has this.", body: "A only." });

    const indexA = await readResource(mock, tokenA, MOCK_CLOUD_SKILL_INDEX_URI);
    assert.equal(indexA.status, 200);
    const parsedA: unknown = JSON.parse(indexA.text ?? "null");
    assert.ok(isRecord(parsedA) && Array.isArray(parsedA.skills));
    assert.equal(parsedA.$schema, MOCK_CLOUD_SKILL_INDEX_SCHEMA);
    assert.deepEqual(parsedA.skills.map((skill) => isRecord(skill) ? skill.name : null).sort(), ["amber-report", "only-a"]);
    for (const skill of parsedA.skills) {
      assert.ok(isRecord(skill));
      assert.equal(skill.type, "skill-md");
      assert.match(String(skill.url), /^skill:\/\/[a-z0-9-]+\/SKILL\.md$/);
      assert.match(String(skill.capability), /^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/);
    }

    const indexB = await readResource(mock, tokenB, MOCK_CLOUD_SKILL_INDEX_URI);
    const parsedB: unknown = JSON.parse(indexB.text ?? "null");
    assert.ok(isRecord(parsedB) && Array.isArray(parsedB.skills));
    assert.deepEqual(parsedB.skills.map((skill) => isRecord(skill) ? skill.name : null), ["amber-report"]);

    const bodyA = await readResource(mock, tokenA, mock.skillUri("amber-report"));
    const bodyB = await readResource(mock, tokenB, mock.skillUri("amber-report"));
    assert.equal(bodyA.text, mockCloudSkillMarkdown({ name: "amber-report", description: "Amber report for A", body: "Reply with CODE-A." }));
    assert.ok(bodyA.text?.includes("CODE-A") && !bodyA.text.includes("CODE-B"));
    assert.ok(bodyB.text?.includes("CODE-B") && !bodyB.text.includes("CODE-A"));
    assert.match(bodyA.text ?? "", /^---\nname: amber-report\ndescription: "Amber report for A"\n---\n\n/);
    const missing = await readResource(mock, tokenB, mock.skillUri("only-a"));
    assert.equal(missing.text, null);
    assert.ok(isRecord(missing.error) && missing.error.code === -32002);

    const reads = mock.resourceReads();
    assert.deepEqual(reads.map((entry) => [entry.identity, entry.uri]), [
      ["account-a", MOCK_CLOUD_SKILL_INDEX_URI],
      ["account-b", MOCK_CLOUD_SKILL_INDEX_URI],
      ["account-a", "skill://amber-report/SKILL.md"],
      ["account-b", "skill://amber-report/SKILL.md"],
      ["account-b", "skill://only-a/SKILL.md"],
    ]);
    const serialized = JSON.stringify(mock.log());
    assert.ok(!serialized.includes(tokenA) && !serialized.includes(tokenB), "credentials never enter the request log");
    assert.ok(mock.log().every((entry) => entry.authorized && entry.status === 200 || entry.status === 202));
    assert.deepEqual(mock.toolCallNames(), []);
  });
}

test("body-only updates, revocation and de-authorization change what the next read returns", async () => {
  await using mock = await startMockCloudSkills({ identities: ["account-a"] });
  const token = mock.credential("account-a");
  mock.publishSkill("account-a", { name: "amber-report", description: "Amber", body: "first" });
  assert.equal((await readResource(mock, token, mock.skillUri("amber-report"))).text?.endsWith("\n\nfirst"), true);
  mock.updateSkillBody("account-a", "amber-report", "second");
  const updated = await readResource(mock, token, mock.skillUri("amber-report"));
  assert.equal(updated.text?.endsWith("\n\nsecond"), true);
  assert.ok(!updated.text?.includes("first"));
  assert.match(updated.text ?? "", /^---\nname: amber-report\ndescription: "Amber"\n---/);

  assert.equal(mock.revokeSkill("account-a", "amber-report"), true);
  assert.equal(mock.revokeSkill("account-a", "amber-report"), false);
  const index: unknown = JSON.parse((await readResource(mock, token, MOCK_CLOUD_SKILL_INDEX_URI)).text ?? "null");
  assert.ok(isRecord(index) && Array.isArray(index.skills) && index.skills.length === 0);
  assert.ok(isRecord((await readResource(mock, token, mock.skillUri("amber-report"))).error));

  mock.setAuthorization("account-a", false);
  const denied = await readResource(mock, token, MOCK_CLOUD_SKILL_INDEX_URI);
  assert.equal(denied.status, 401);
  const anonymous = await readResource(mock, null, MOCK_CLOUD_SKILL_INDEX_URI);
  assert.equal(anonymous.status, 401);
  const stranger = await readResource(mock, "mock-cloud-not-minted", MOCK_CLOUD_SKILL_INDEX_URI);
  assert.equal(stranger.status, 401);
  const refused = mock.log().filter((entry) => entry.status === 401);
  assert.deepEqual(refused.map((entry) => [entry.identity, entry.authorized]), [["account-a", false], ["anonymous", false], ["unknown", false]]);
  mock.setAuthorization("account-a", true);
  assert.equal((await readResource(mock, token, MOCK_CLOUD_SKILL_INDEX_URI)).status, 200);
});

test("advertises the Connect routing tools and records every tools/call by name", async () => {
  await using mock = await startMockCloudSkills({ identities: ["account-a"], transport: "json" });
  const token = mock.credential("account-a");
  const listed = await rpc(mock.agentUrl, token, { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} });
  const tools = isRecord(listed.payload) && isRecord(listed.payload.result) && Array.isArray(listed.payload.result.tools) ? listed.payload.result.tools : [];
  assert.deepEqual(tools.map((tool) => isRecord(tool) ? tool.name : null), ["search_capabilities", "execute_capability"]);
  const called = await rpc(mock.agentUrl, token, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { name: "search_capabilities", arguments: { query: "amber" } } });
  assert.equal(called.response.status, 200);
  assert.ok(isRecord(called.payload) && isRecord(called.payload.result));
  const unknown = await rpc(mock.agentUrl, token, { id: 3, jsonrpc: "2.0", method: "tools/call", params: { name: "not_a_tool" } });
  assert.ok(isRecord(unknown.payload) && isRecord(unknown.payload.error));
  assert.deepEqual(mock.toolCallNames(), ["search_capabilities", "not_a_tool"]);
  assert.deepEqual((await mock.toolCalls({ name: "search_capabilities" })).map((call) => [call.name, call.tokenId]), [["search_capabilities", "account-a"]]);
  const since = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(mock.toolCallNames({ sinceIso: since }), []);
  assert.equal((await mock.handshakes()).length, 0);
  const batch = await rpc(mock.agentUrl, token, [
    { id: 4, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { id: 5, jsonrpc: "2.0", method: "ping" },
  ]);
  assert.ok(Array.isArray(batch.payload) && batch.payload.length === 2);
  assert.equal(isRecord(batch.payload[0]) && isRecord(batch.payload[0].result) ? batch.payload[0].result.protocolVersion : null, "2025-03-26");
  assert.equal((await mock.handshakes()).length, 1);
  const stream = await fetch(mock.agentUrl, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 405);
  const health = await fetch(`${mock.url}/health`);
  assert.equal(health.status, 200);
  assert.throws(() => mock.publishSkill("account-a", { name: "Not Kebab", description: "x", body: "y" }));
  assert.throws(() => mock.publishSkill("account-z", { name: "ok", description: "x", body: "y" }));
});
