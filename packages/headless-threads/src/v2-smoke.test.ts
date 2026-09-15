import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHeadlessThreadClientV2, createNativeV2Client, type HeadlessFetch } from "./v2.ts";

const binary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
const smokeTest = binary ? test : test.skip;
smokeTest("isolated beta19271 attaches a selected skill in the first model request and enforces native permission", { timeout: 90_000 }, async (t) => {
  assert.ok(binary);
  let phase = "startup";
  t.after(() => t.diagnostic(`Native smoke phase: ${phase}`));
  const root = await mkdtemp(join(tmpdir(), "opencode", "headless-v2-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  await mkdir(workspace); await mkdir(config);
  const skillDirectory = join(config, "skills", "fixture-guidance");
  await mkdir(skillDirectory, { recursive: true });
  const skillBody = "Selected fixture instruction: preserve the blue cedar marker.";
  await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: fixture-guidance\ndescription: Isolated selected skill fixture\n---\n${skillBody}\n`);
  const requests: string[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [{ delta: { role: "assistant" }, finish_reason: null }, { delta: { content: "Native fixture answer" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }]) {
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }], ...(choice.finish_reason ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}) })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { provider.close(() => resolve()); provider.closeAllConnections(); }));
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const providerUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    model: "fixture/fixture", skills: [join(config, "skills")], agents: {
      fixture: { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "skill", resource: "*", effect: "allow" }] },
      denied: { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      approval: { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "skill", resource: "*", effect: "ask" }] },
    },
    providers: {
      fixture: {
        name: "Fixture", package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `${providerUrl}/v1`, apiKey: "fixture-not-a-secret", name: "fixture" },
        models: { fixture: { name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 200 } } },
      },
    },
  }));
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace, env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(),
      XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "opencode.db"), OPENCODE_PASSWORD: "fixture-password", OPENCODE_MODELS_URL: providerUrl,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed; clearTimeout(timer);
  });
  // Logs remain in memory, never printed or copied to evidence.
  child.stderr.resume();
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Native listener did not start")), 30_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Native engine exited before startup")); });
    child.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-4000);
      const found = output.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      if (found) { clearTimeout(timeout); resolve(found); }
    });
  });
  const paths: string[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  const transport: HeadlessFetch = async (input, init) => {
    const path = new URL(input).pathname.replace("/workspace/ws_fixture/opencode2", "");
    paths.push(path);
    const target = new URL(`${url}${path}${new URL(input).search}`);
    target.searchParams.set("location[directory]", workspace);
    let body = init?.body;
    if (path === "/api/session" && init?.method === "POST") body = JSON.stringify({ ...JSON.parse(body ?? "{}"), location: { directory: workspace } });
    if (init?.method === "POST") writes.push({ path, body: body ? JSON.parse(body) : undefined });
    const response = await fetch(target, { ...init, body, headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` } });
    return response;
  };
  const options = { baseUrl: url, workspaceId: "ws_fixture", token: "fixture", fetch: transport, defaultModel: { providerId: "fixture", modelId: "fixture" }, defaultAgent: "fixture", requestTimeoutMs: 30_000 };
  phase = "catalog";
  const native = createNativeV2Client(options);
  for (let attempt = 0; attempt < 60; attempt++) {
    const catalog = await native.readCatalog();
    if (catalog.models.some((item) => item.providerID === "fixture")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const client = createHeadlessThreadClientV2(options);
  const selectedSkill = (await native.listSkills()).find((skill) => skill.name === "fixture-guidance");
  assert.ok(selectedSkill, "fixture skill is registered in the real native catalog");
  assert.ok(selectedSkill.content.includes(skillBody));
  const skills = [{ id: selectedSkill.id }];
  const streamController = new AbortController();
  const streamSignal = AbortSignal.any([streamController.signal, t.signal]);
  let streamError: unknown;
  const streamed: Array<{ type: string; messageId: unknown }> = [];
  let ready: () => void = () => {};
  const connected = new Promise<void>((resolve) => { ready = resolve; });
  const streaming = (async () => {
    try {
      for await (const event of native.events(streamSignal)) {
        if (event.type === "server.connected") ready();
        streamed.push({ type: event.type, messageId: event.data.assistantMessageID });
      }
    } catch (error) { if (!streamSignal.aborted) streamError = error; }
  })();
  t.after(async () => { streamController.abort(); await streaming; });
  phase = "event connection";
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connected, streaming.then(() => { throw new Error("Native event stream ended before connecting"); }),
      new Promise<never>((_, reject) => { connectionTimer = setTimeout(() => reject(new Error("Native event connection timed out")), 5000); })]);
  } finally { clearTimeout(connectionTimer); }
  phase = "parked input";
  const thread = await client.createThread({ title: "Native fixture" });
  const todoResponse = await transport(`${url}/workspace/ws_fixture/opencode2/api/session/${thread.id}/todo`);
  assert.equal(todoResponse.status, 404, "beta19271 has no native session todo route");
  await todoResponse.body?.cancel();
  assert.equal((await client.getThreadSnapshot(thread.id)).todos, null);
  // resume:false is parked inbox input, not v1 noReply history materialization.
  await native.admitInput(thread.id, { id: "msg_fixture_parked", type: "user", text: "Parked fixture", resume: false });
  assert.equal((await native.readInbox(thread.id))[0]?.id, "msg_fixture_parked");
  assert.ok(!(await native.readHistory(thread.id)).some((item) => item.id === "msg_fixture_parked"));
  assert.equal(requests.length, 0);
  await client.abortThread(thread.id);
  phase = "first skill prompt";
  const acceptance = await client.sendTurn(thread.id, { prompt: "First fixture turn", context: "Untrusted fixture reference", messageId: "msg_fixture_first", skills });
  const settled = await client.waitForThread(thread.id, { since: acceptance, timeoutMs: 20_000, pollIntervalMs: 100 });
  assert.equal(settled.outcome, "settled");
  assert.equal(settled.snapshot.messages.filter((item) => item.role === "assistant").length, 1, "context must not start its own provider turn");
  const beforeRecovery = requests.length;
  phase = "skill recovery";
  const recovered = await createHeadlessThreadClientV2(options).retryTurn(thread.id, { messageId: "msg_fixture_first", prompt: "First fixture turn", context: "Untrusted fixture reference", skills });
  assert.equal(recovered.alreadyPresent, true);
  assert.equal(requests.length, beforeRecovery, "recovering native history must not call the provider again");
  phase = "second prompt";
  const next = await client.sendTurn(thread.id, { prompt: "Second fixture turn", messageId: "msg_fixture_second" });
  assert.equal((await client.waitForThread(thread.id, { since: next, timeoutMs: 20_000, pollIntervalMs: 100 })).outcome, "settled");
  const transcript = await client.exportTranscript(thread.id);
  assert.equal(transcript.finalAssistantText, "Native fixture answer");
  assert.deepEqual(transcript.messages.filter((item) => item.role === "assistant").map((item) => item.parentId), [acceptance.messageId, next.messageId]);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((body) => JSON.parse(body).model === "fixture"));
  assert.ok(requests[0]?.includes("Untrusted fixture reference"));
  assert.ok(requests[0]?.includes(skillBody), "selected skill body is present in the FIRST model request");
  const promptWrite = writes.find((write) => write.path.endsWith("/prompt") && write.body && typeof write.body === "object" && "id" in write.body && write.body.id === acceptance.messageId);
  assert.ok(promptWrite?.body && typeof promptWrite.body === "object" && "skills" in promptWrite.body);
  assert.deepEqual(promptWrite.body.skills, skills);
  assert.ok(!JSON.stringify(promptWrite.body).includes(skillBody), "only native IDs, not skill prose, cross prompt admission");
  assert.ok(writes.slice(0, writes.indexOf(promptWrite)).some((write) => write.path === `/api/session/${thread.id}/permission`));
  assert.ok(transcript.messages.every((message) => message.toolCalls.every((tool) => tool.name !== "skill")), "no native skill tool call is required");
  const admitted = (await native.readHistory(thread.id)).find((message) => message.id === acceptance.messageId);
  assert.ok(admitted?.type === "user" && admitted.skills?.[0]?.text?.includes(skillBody), "native receipt freezes the selected body");
  for (const agent of ["denied", "approval"]) {
    phase = `${agent} skill permission`;
    const blocked = await client.createThread({ title: "Blocked skill", agent });
    const writeCount = writes.length;
    const requestCount: number = requests.length;
    await assert.rejects(client.sendTurn(blocked.id, { prompt: "Blocked fixture turn", skills, agent }), { code: agent === "denied" ? "skill_denied" : "skill_permission_required" });
    assert.ok(!writes.slice(writeCount).some((write) => /\/(prompt|synthetic|reply)$/.test(write.path)));
    assert.equal(requests.length, requestCount, "denied or pending permission must not reach the provider");
    if (agent === "approval") assert.ok((await native.listPermissions(blocked.id)).some((request) => request.action === "skill" && request.resources.includes(selectedSkill.id)));
  }
  const firstReply = transcript.messages.find((item) => item.parentId === acceptance.messageId);
  assert.ok(streamed.some((event) => event.type === "session.text.started" && event.messageId === firstReply?.id));
  assert.ok(streamed.some((event) => event.type === "session.text.delta" && event.messageId === firstReply?.id));
  assert.ok(streamed.some((event) => event.type === "session.text.ended" && event.messageId === firstReply?.id));
  assert.ok(paths.every((path) => path.startsWith("/api/")));
  assert.equal(streamError, undefined);
  phase = "event shutdown";
  streamController.abort();
  await streaming;
  await client.abortThread(thread.id);
  phase = "complete";
});
