import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { OPENWORK_SESSION_DETAIL_LIMITS, openworkSessionActivityResultSchema, openworkSessionPartPageSchema, openworkSessionToolProjectionSchema } from "../../packages/types/src/openwork-affordance";
import { appWeb, eventually, needs, SkipError, test } from "@openwork/testkit";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { buildOpenworkProviderContributions, sessionActivityArgsSchema, sessionReadArgsSchema, sessionSearchArgsSchema } from "../../apps/server/src/opencode-plugins/openwork-provider-adapters";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object response");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an array response");
  return value.map(record);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string response");
  return value;
}

test("session tool descriptors advertise accepted enums, text defaults, caps and read-only activity", async ({ evidence }) => {
  const affordances = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances);
  const read = affordances.find((entry) => entry.id === "session.read");
  const search = affordances.find((entry) => entry.id === "session.search");
  const activity = affordances.find((entry) => entry.id === "session.activity");
  const parts = read?.arguments.find((argument) => argument.name === "parts")?.description;
  const scope = search?.arguments.find((argument) => argument.name === "in")?.description;
  const readEnums = sessionReadArgsSchema.shape.parts.unwrap().element.options;
  const searchEnums = sessionSearchArgsSchema.shape.in.unwrap().element.options;
  expect(readEnums).toEqual(["text", "tool", "reasoning"]);
  expect(searchEnums).toEqual(["text", "tool"]);
  for (const value of readEnums) expect(parts).toContain(value);
  for (const value of searchEnums) expect(scope).toContain(value);
  for (const description of [parts, scope]) {
    expect(description).toContain("default [text]");
    expect(description).toContain("2000");
    expect(description).toContain("redacted");
  }
  expect(sessionReadArgsSchema.parse({ sessionId: "ses_fixture" }).parts).toEqual(["text"]);
  expect(sessionSearchArgsSchema.parse({ query: "needle" }).in).toEqual(["text"]);
  expect(sessionReadArgsSchema.safeParse({ sessionId: "ses_fixture", parts: ["unknown"] }).success).toBe(false);
  expect(sessionSearchArgsSchema.safeParse({ query: "needle", in: ["reasoning"] }).success).toBe(false);
  expect(sessionActivityArgsSchema.safeParse({ sessionId: "ses_fixture", since: "invalid" }).success).toBe(false);
  expect(activity?.arguments.map((argument) => argument.name).sort()).toEqual(Object.keys(sessionActivityArgsSchema.shape).sort());
  expect(activity).toMatchObject({ kind: "query", effects: { data: "read", ui: "none", external: false }, executor: { kind: "openwork" } });
  for (const value of ["300", "byAffordanceId", "ok: false", "callId", "scope.complete", "fixed labels"]) expect(activity?.description).toContain(value);
  for (const value of [OPENWORK_SESSION_DETAIL_LIMITS.activityMessages, OPENWORK_SESSION_DETAIL_LIMITS.activityParts, OPENWORK_SESSION_DETAIL_LIMITS.activityErrors, OPENWORK_SESSION_DETAIL_LIMITS.outcomeChars, OPENWORK_SESSION_DETAIL_LIMITS.responseBytes]) expect(activity?.description).toContain(String(value));
  for (const value of ["partPage", "nextOffset", "nextBefore", "including start/summary"]) expect(parts).toContain(value);
  evidence.recordAssertionEvidence("Tool opt-in and activity contracts are discoverable", "Descriptors match accepted enum values and text defaults, advertise redaction and field caps, reject unsupported scopes and invalid timestamps, and declare activity read-only.", true);
});

for (const { name, command, args } of [
  { name: "prompt isolation, shared redaction, 1301-part continuation, native before pagination and bounded incomplete scans", command: "bun", args: ["--conditions=development", "test", "apps/server/src/opencode-plugins/openwork-extensions-preview.test.ts"] },
  { name: "shared result bounds, cursor schema identity and descriptor drift", command: "bun", args: ["--conditions=development", "test", "apps/server/src/opencode-plugins/openwork-provider-adapters.test.ts"] },
  { name: "shared credential redaction compatibility and bounded long-uppercase normalization", command: "pnpm", args: ["--filter", "@openwork/enterprise-mcp-client", "exec", "tsx", "--test", "test/slack-mcp-compat.test.ts"] },
]) {
  test(`session detail regressions prove ${name}`, async ({ evidence }) => {
    needs({ commands: [command], placement: "local" });
    const result = spawnSync(command, args, {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8", timeout: 30_000, env: { ...process.env, NO_COLOR: "1" },
    });
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/(?:[1-9]\d* pass|\bpass [1-9]\d*)/);
    expect(output).toMatch(/(?:\b0 fail|\bfail 0)/);
    expect(output).not.toMatch(/(?:\b[1-9]\d* (?:skip|todo)|\b(?:skipped|todo) [1-9]\d*)/);
    evidence.recordAssertionEvidence(name, `${command} ${args.join(" ")}\nExit: ${result.status}\n${output}`, true);
  });
}

test("HTTP transcript fixture preserves the prior reply and counts three session.create calls with one too_big outcome", async ({ evidence }) => {
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  const session = { id: "ses_fixture", title: "Synthetic transcript", directory: "/tmp/session-tool-parts-fixture", time: { created: 100, updated: 400 } };
  const needle = "input-only-fixture-needle";
  const failure = "too_big: prompt exceeds 100000 characters";
  const tools = [1, 2, 3].map((index) => ({
    type: "tool", tool: "openwork_execute", callID: `call_${index}`,
    state: {
      status: "completed", input: { id: "session.create", sessions: [{ title: `Fixture ${index}`, prompt: index === 1 ? needle : "Synthetic task" }] },
      output: JSON.stringify(index === 3 ? { ok: true, result: { ok: false, code: "too_big", error: failure } } : { ok: true }),
      time: { start: 300 + index * 10, end: 301 + index * 10 },
    },
  }));
  const reply = "The investigation is complete.";
  const preTool = "I will now create the follow-up tasks.";
  const messages = [
    { info: { id: "msg_user", role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "Investigate this synthetic issue." }] },
    { info: { id: "msg_reply", role: "assistant", time: { created: 200 } }, parts: [{ type: "text", text: reply }] },
    { info: { id: "msg_pretool", role: "assistant", time: { created: 300 } }, parts: [{ type: "step-start" }, { type: "text", text: preTool }, ...tools, { type: "step-finish" }] },
  ];
  const base = "/workspace/ws/opencode";
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers.authorization !== "Bearer transcript-fixture-token") return json(401, { error: "Unauthorized" });
    if (request.method !== "GET") return json(405, { error: "Read-only fixture" });
    if (url.pathname === "/workspaces") return json(200, { items: [{ id: "ws", name: "Fixture", path: session.directory }] });
    if (url.pathname === `${base}/session`) return json(200, [session]);
    if (url.pathname === `${base}/session/ses_fixture`) return json(200, session);
    if (url.pathname === `${base}/session/ses_fixture/message`) {
      const limit = url.searchParams.get("limit");
      return json(200, limit === null ? messages : messages.slice(-Number(limit)));
    }
    if (url.pathname === `${base}/provider`) return json(200, { connected: [], all: [] });
    if (url.pathname === `${base}/session/status`) return json(200, {});
    if ([`${base}/session/ses_fixture/children`, `${base}/permission`, `${base}/question`].includes(url.pathname)) return json(200, []);
    unexpected.push(url.pathname);
    return json(404, { error: "Unknown fixture route" });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Transcript fixture did not bind a port");
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "transcript-fixture-token";
    const plugin = await OpenWorkExtensionsPreview();
    const query = async (id: string, args: Record<string, unknown>) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({ id, args: { workspaceId: "ws", ...args } })));
      expect(output).toMatchObject({ ok: true, id });
      const result = record(output.result);
      expect(result.ok).toBe(true);
      return result;
    };
    const normal = await query("session.read", { sessionId: session.id });
    expect(records(normal.messages).at(-1)).toMatchObject({ id: "msg_pretool", text: preTool });
    for (const parts of [["text"], ["text", "tool"]]) {
      const summary = await query("session.read", { sessionId: session.id, summary: true, parts });
      expect(summary.lastAssistant).toMatchObject({ id: "msg_reply", text: reply });
      expect(record(summary.lastAssistant).text).not.toBe(preTool);
    }
    evidence.recordAssertionEvidence("HTTP fixture summary prefers the prior reply over trailing sole pre-tool text", "The production session.read adapter read a synthetic HTTP transcript: normal read retained the trailing pre-tool text, while text-only and text+tool summaries selected msg_reply instead of msg_pretool. No inference or real session creation is claimed.", true);
    const toolRead = await query("session.read", { sessionId: session.id, parts: ["tool"] });
    const readTools = records(toolRead.messages).flatMap((message) => records(message.tools)).map((tool) => openworkSessionToolProjectionSchema.parse(tool));
    expect(openworkSessionPartPageSchema.parse(toolRead.partPage)).toMatchObject({ returned: 3, nextOffset: null, truncated: false });
    expect(readTools.map((tool) => tool.callId)).toEqual(["call_1", "call_2", "call_3"]);
    expect(text(readTools[0]?.input)).toContain(needle);
    expect(JSON.stringify(normal)).not.toContain(needle);
    expect((await query("session.search", { query: needle })).results).toEqual([]);
    const searched = await query("session.search", { query: needle, in: ["tool"] });
    expect(records(searched.results)).toHaveLength(1);
    expect(records(searched.results)[0]).toMatchObject({ sessionId: session.id, kind: "tool", tool: "openwork_execute", callId: "call_1", snippet: { match: needle } });
    const activity = openworkSessionActivityResultSchema.parse(await query("session.activity", { sessionId: session.id }));
    expect(activity.toolCalls).toEqual({ total: 3, byTool: { openwork_execute: 3 }, byAffordanceId: { "session.create": 3 } });
    expect(activity.errors).toEqual({ total: 1, list: [{ callId: "call_3", tool: "openwork_execute", affordanceId: "session.create", code: "too_big", message: "Tool input exceeded a size limit", at: 331 }], truncated: false, nextOffset: null });
    for (const value of [needle, failure, preTool, reply]) expect(JSON.stringify(activity)).not.toContain(value);
    expect(activity.scope.complete).toBe(true);
    expect(requests).toContain(`GET ${base}/session/ses_fixture/message?limit=100`);
    expect(activity.messages).toEqual({ user: 1, assistant: 2 });
    expect(unexpected).toEqual([]);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(requests).toContain(`GET ${base}/session/ses_fixture/message`);
    evidence.recordAssertionEvidence("HTTP fixture tool search and activity expose three calls and one failed outcome", "Synthetic tool input was hidden by default read/search and found by tool-only search. Production activity grouped three openwork_execute calls under session.create and counted only call_3's nested ok:false too_big outcome; both successful calls were excluded from errors. All witness requests were read-only and used declared routes.", true);
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP credential witness redacts unstructured secrets before tool caps and search", async ({ evidence }) => {
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  const session = { id: "ses_credentials", title: "Synthetic credential witness", directory: "/tmp/session-credential-witness", time: { created: 100, updated: 400 } };
  const synthetic = (length: number) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789".repeat(8).slice(0, length);
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "synthetic-user", iat: 1234567890 })).toString("base64url"),
    synthetic(43),
  ].join(".");
  const opaqueCredential = "opaque-key-fixture-private-7p9";
  const rawCredential = "opaque7";
  const benignKeys = { monkey: "useful-control", statusCode: 422, exitCode: 1, tokenCount: 3, client_assertion_type: "jwt-bearer", code_challenge: "public-challenge", code_challenge_method: "S256", assertionCount: 2, codeVerifierLength: 43, access_token_value_count: 2, client_secret_value_type: "string", code_verifier_value_length: 43, signing_key_method: "RSA", primary_key_value: "row-7", tokenizer_value: "word" };
  const credentialContainers = ["auth", "credential", "credentials", "authentication"];
  const credentialKeys = [...credentialContainers, "AWS_SECRET_ACCESS_KEY", "SecretAccessKey", "SessionToken", "code_verifier", "codeVerifier", "pkce_verifier", "client_assertion", "clientAssertion", "jwt_assertion", "saml_assertion", "SAMLResponse", "access_token_value", "client_secret_value", "SecretAccessKeyValue", "code_verifier_value", "custom_token_payload", "signing_key_material"];
  const fixtures = [
    ...credentialKeys.map((key) => ({
      source: JSON.stringify({ nested: [{ [key]: opaqueCredential }], encoded: JSON.stringify({ [key]: opaqueCredential }), ...benignKeys }),
      marker: JSON.stringify({ nested: [{ [key]: "[redacted]" }], encoded: JSON.stringify({ [key]: "[redacted]" }), ...benignKeys }),
    })),
    ...credentialKeys.filter((key) => key.endsWith("_value") || key.endsWith("Value")).map((key) => ({
      source: "log " + JSON.stringify({ nested: [{ [key]: rawCredential }], ...benignKeys }),
      marker: "log " + JSON.stringify({ nested: [{ [key]: "[redacted]" }], ...benignKeys }),
    })),
    ...credentialContainers.map((key) => ({
      source: "log " + JSON.stringify({ nested: [{ [key]: { opaque: rawCredential, values: [rawCredential] } }], ...benignKeys }),
      marker: "log " + JSON.stringify({ nested: [{ [key]: "[redacted]" }], ...benignKeys }),
    })),
    { source: "AKIA" + "BCDEFGHIJKLM2345", marker: "[redacted:aws-access-token]" },
    { source: `-----BEGIN PRIVATE KEY-----\n${synthetic(128)}\n-----END PRIVATE KEY-----`, marker: "[redacted:private-key]" },
    { source: "ghp_" + synthetic(36), marker: "[redacted:github-pat]" },
    { source: "gho_" + synthetic(36), marker: "[redacted:github-oauth]" },
    { source: "ghu_" + synthetic(36), marker: "[redacted:github-app-token]" },
    { source: "github_pat_" + synthetic(82), marker: "[redacted:github-fine-grained-pat]" },
    { source: "xoxb-123456789012-234567890123-" + synthetic(24), marker: "[redacted:slack-bot-token]" },
    { source: "xoxp-123456789012-234567890123-345678901234-" + synthetic(32), marker: "[redacted:slack-user-token]" },
    { source: "https://hooks.slack.com/services/" + synthetic(44), marker: "[redacted:slack-webhook-url]" },
    { source: "sk_test_" + synthetic(32), marker: "[redacted:stripe-access-token]" },
    { source: `sk-${synthetic(20)}T3BlbkFJ${synthetic(20)}`, marker: "[redacted:openai-api-key]" },
    { source: `sk-ant-api03-${synthetic(93)}AA`, marker: "[redacted:anthropic-api-key]" },
    { source: "AIza" + synthetic(35), marker: "[redacted:gcp-api-key]" },
    { source: "npm_" + synthetic(36), marker: "[redacted:npm-access-token]" },
    { source: "glpat-" + synthetic(20), marker: "[redacted:gitlab-pat]" },
    { source: jwt, marker: "[redacted:jwt]" },
    { source: `custom_api_key = "${synthetic(48)}"`, marker: 'custom_api_key = "[redacted:generic-api-key]"' },
  ];
  const prefix = `${"x".repeat(1953)}${"\n".repeat(10)} `;
  const capSecret = `sk-proj-${synthetic(74)}T3BlbkFJ${synthetic(74)}`;
  const pem = `-----BEGIN PRIVATE KEY-----\n${"synthetic-body".repeat(200)}`;
  const sha = "0123456789abcdef".repeat(2) + "01234567";
  const uuid = ["12345678", "1234", "4123", "8123", "123456789012"].join("-");
  const image = "data:image/png;base64," + Buffer.from("synthetic-image-bytes".repeat(6)).toString("base64");
  const control = `commit ${sha} request ${uuid} ${image}`;
  const completed = (callID: string, source: string) => ({ type: "tool", tool: "bash", callID, state: { status: "completed", input: { nested: [{ value: source }, JSON.stringify({ detail: source })] }, output: source, time: { start: 300, end: 301 } } });
  const messages = [{ info: { id: "msg_credentials", role: "assistant", time: { created: 300 } }, parts: [
    ...fixtures.flatMap(({ source }, index) => [completed(`call_${index}`, source), { type: "tool", tool: "bash", callID: `error_${index}`, state: { status: "error", input: {}, error: source, time: { start: 302, end: 303 } } }]),
    completed("call_cap", prefix + capSecret + " after " + "z".repeat(100)),
    completed("call_pem_cap", "x".repeat(1976) + " " + pem),
    completed("call_control", control),
  ] }];
  const base = "/workspace/ws/opencode";
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    requests.push(`${request.method} ${path}`);
    if (request.headers.authorization !== "Bearer credential-witness-token") return json(401, { error: "Unauthorized" });
    if (request.method !== "GET") return json(405, { error: "Read-only witness" });
    if (path === "/workspaces") return json(200, { items: [{ id: "ws", name: "Witness", path: session.directory }] });
    if (path === `${base}/session`) return json(200, [session]);
    if (path === `${base}/session/${session.id}`) return json(200, session);
    if (path === `${base}/session/${session.id}/message`) return json(200, messages);
    if (path === `${base}/provider`) return json(200, { connected: [], all: [] });
    if (path === `${base}/session/status`) return json(200, {});
    if ([`${base}/session/${session.id}/children`, `${base}/permission`, `${base}/question`].includes(path)) return json(200, []);
    unexpected.push(path);
    return json(404, { error: "Unknown witness route" });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Credential witness did not bind a port");
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "credential-witness-token";
    const plugin = await OpenWorkExtensionsPreview();
    const query = async (id: string, args: Record<string, unknown>) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({ id, args: { workspaceId: "ws", ...args } })));
      expect(output).toMatchObject({ ok: true, id });
      expect(record(output.result).ok).toBe(true);
      return record(output.result);
    };
    const read = await query("session.read", { sessionId: session.id, parts: ["tool"] });
    const tools = records(read.messages).flatMap((message) => records(message.tools));
    const activity = await query("session.activity", { sessionId: session.id });
    const errors = records(record(activity.errors).list);
    expect(tools).toHaveLength(fixtures.length * 2 + 3);
    expect(errors).toHaveLength(fixtures.length);
    for (const [index, { source, marker }] of fixtures.entries()) {
      expect(text(tools[index * 2]?.output), "raw credential must not survive production tool output").not.toContain(source);
      expect(tools[index * 2]?.output).toBe(JSON.stringify(marker));
      expect(tools[index * 2]?.input).toBe(JSON.stringify({ nested: [{ value: marker }, JSON.stringify({ detail: marker })] }));
      expect(tools[index * 2 + 1]?.error).toBe(JSON.stringify(marker));
      expect(errors[index]).toMatchObject({ code: "tool_error", message: "Tool execution failed" });
      expect(JSON.stringify(activity)).not.toContain(source);
      expect((await query("session.search", { query: JSON.stringify(source).slice(1, -1), in: ["tool"], match: "phrase" })).results).toEqual([]);
      expect(records((await query("session.search", { query: JSON.stringify(marker).slice(1, -1), in: ["tool"], match: "phrase" })).results)).toHaveLength(1);
    }
    for (const secret of [opaqueCredential, rawCredential]) {
      expect(JSON.stringify(read)).not.toContain(secret);
      expect((await query("session.search", { query: secret, in: ["tool"] })).results).toEqual([]);
    }
    expect(records((await query("session.search", { query: "useful-control", in: ["tool"] })).results)).toHaveLength(1);
    for (let index = 0; index < credentialKeys.length; index += 1) {
      const projected = record(JSON.parse(text(JSON.parse(text(tools[index * 2]?.output)))));
      expect(projected).toMatchObject(benignKeys);
    }
    evidence.recordAssertionEvidence("Opaque cloud credentials are removed by key context", "Auth, credential, credentials and authentication fields plus credential segments/pairs and payload/material suffixes were redacted in nested objects and encoded JSON strings through tool input/output/error. Raw JSON auth/credential objects and arrays were omitted whole, including opaque leaves without credential names. Searching the opaque value returned no result; benign keys, assertion-type metadata, public code challenges and length/count fields survived byte-for-byte and remained searchable.", true);
    evidence.recordAssertionEvidence("Pinned Gitleaks rules redact credentials across production read, search and activity", "A test-owned read-only HTTP witness supplied one synthetic positive for each of the 17 selected Gitleaks rule IDs at b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b. Exact rule-ID markers replaced secrets in output, nested input, JSON-encoded nested strings and tool errors; generic-api-key preserved assignment context. Activity emitted only fixed failure labels with no credential payload; negative secret searches and positive marker searches agreed. No live credentials or inference were used.", true);
    const capped = tools.find((tool) => tool.callId === "call_cap");
    expect(JSON.stringify(prefix).length - 1).toBe(1975);
    expect(JSON.stringify(prefix + capSecret).slice(0, 2000)).toContain(capSecret.slice(0, 20));
    expect(capped?.output).toBe(JSON.stringify(prefix + "[redacted:openai-api-key] after " + "z".repeat(100)).slice(0, 2000));
    expect(text(capped?.output)).toContain("[redacted:openai-api-key]");
    expect(capped?.truncated).toBe(true);
    expect(JSON.stringify(read)).not.toContain(capSecret.slice(0, 20));
    const pemRead = text(tools.find((tool) => tool.callId === "call_pem_cap")?.output);
    expect(pemRead).toBe(JSON.stringify("x".repeat(1976) + " [redacted:private-key]").slice(0, 2000));
    expect(pemRead).toContain("[redacted:private-key]");
    expect(pemRead).not.toContain("-----BEGIN");
    expect(JSON.stringify(read)).not.toContain("synthetic-body");
    expect(tools.find((tool) => tool.callId === "call_control")?.output).toBe(JSON.stringify(control));
    for (const secret of [capSecret.slice(0, 20), "synthetic-body"]) expect((await query("session.search", { query: secret, in: ["tool"] })).results).toEqual([]);
    for (const queryText of [sha, uuid, image]) expect(records((await query("session.search", { query: queryText, in: ["tool"], match: "phrase" })).results)).toHaveLength(1);
    expect(unexpected).toEqual([]);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    evidence.recordAssertionEvidence("Redaction precedes JSON encoding and caps, while SHA1, UUID and base64 images survive", "The raw synthetic OpenAI project token straddled offset 1975 after JSON encoding: clipping first demonstrably retained its prefix, while production returned the typed marker and no fragment. An unterminated multiline PEM straddling the cap was removed through EOF using the upstream header prefix. SHA1, UUIDv4 and base64 image controls remained byte-identical and searchable. Witness traffic was GET-only on declared routes.", true);
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("session.read and session.activity expose a real isolated headless shell call without leaking tool data by default", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  if (place.kind !== "local") throw new SkipError("local manifest proof; Daytona requires a remote runtime manifest adapter");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "session-tool-parts-")));
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  try {
    await using app = await appWeb({ name: "session-tool-parts", workspacePath: scratch, place });
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!runtime || runtime.openworkUrl !== app.openworkUrl || runtime.workspace !== scratch) throw new Error("Could not identify the test-owned headless runtime");
    process.env.OPENWORK_SERVER_URL = runtime.openworkUrl;
    process.env.OPENWORK_SERVER_TOKEN = runtime.token;
    const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> => {
      const response = await fetch(`${runtime.openworkUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Isolated engine request ${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return response.status === 204 ? null : response.json();
    };
    const workspace = records(record(await request("/workspaces")).items).find((entry) => entry.path === scratch);
    if (!workspace) throw new Error("Isolated workspace not found");
    const workspaceId = text(workspace.id);
    const base = `/workspace/${encodeURIComponent(workspaceId)}/opencode/session`;
    const model = { providerID: "tool-parts-unconfigured", modelID: "unused" };
    const sessionId = text(record(await request(base, { title: "Tool execution witness" })).id);
    const outputMarker = "witness-output-only-7c93";
    const neighborId = text(record(await request(base, { title: outputMarker })).id);
    const firstUser = "Keep this user message in the default transcript.";
    await request(`${base}/${sessionId}/message`, { noReply: true, model, parts: [{ type: "text", text: firstUser }] });
    await request(`${base}/${neighborId}/message`, { noReply: true, model, parts: [{ type: "text", text: outputMarker }] });
    const plugin = await OpenWorkExtensionsPreview({ directory: scratch });
    const query = async (id: string, args: Record<string, unknown>) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({ id, args: { workspaceId, ...args } })));
      expect(output.ok).toBe(true);
      const result = record(output.result);
      expect(result.ok).toBe(true);
      return result;
    };
    const before = await query("session.activity", { sessionId });
    expect(before.toolCalls).toEqual({ total: 0, byTool: {}, byAffordanceId: {} });
    const source = `process.stdout.write(JSON.stringify({ok:false,error:"intentional failure token=fixture-secret " + "E".repeat(400),payload:"P".repeat(2400)+["witness","output","only","7c93"].join("-")}))`;
    const command = `${JSON.stringify(process.execPath)} -e '${source}'`;
    expect(command).not.toContain(outputMarker);
    const shell = record(await request(`${base}/${sessionId}/shell`, { agent: "build", model, command }));
    const actualTool = records(shell.parts).find((part) => part.type === "tool");
    if (!actualTool) throw new Error("Real engine shell did not persist a tool part");
    const actualState = record(actualTool.state);
    expect(actualState.status).toBe("completed");
    expect(actualTool.tool).toBe("bash");
    expect(actualState.input).toMatchObject({ command });
    expect(text(actualState.output)).toContain(outputMarker);
    expect(text(actualState.output)).toContain("fixture-secret");
    const callId = text(actualTool.callID);
    const toolRead = await eventually(() => query("session.read", { sessionId, parts: ["tool"], from: "start" }), {
      within: 15_000, intervalMs: 250, label: "persisted real shell call visible through session.read",
      until: (result) => records(result.messages).some((message) => records(message.tools).some((tool) => tool.callId === callId)),
    });
    const tools = records(toolRead.messages).flatMap((message) => records(message.tools));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "tool", tool: "bash", callId, status: "completed", truncated: true });
    expect(text(tools[0]?.output)).toHaveLength(2000);
    expect(text(tools[0]?.output)).not.toContain(outputMarker);
    for (const field of ["input", "output", "error"]) expect(text(tools[0]?.[field]).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(toolRead)).toContain("[redacted]");
    expect(JSON.stringify(toolRead)).not.toContain("fixture-secret");
    expect(records(toolRead.messages).every((message) => message.text === "")).toBe(true);
    const defaultRead = await query("session.read", { sessionId, from: "start" });
    expect(records(defaultRead.messages).some((message) => message.text === firstUser)).toBe(true);
    expect(records(defaultRead.messages).every((message) => message.tools === undefined && message.reasoning === undefined)).toBe(true);
    expect(JSON.stringify(defaultRead)).not.toContain(outputMarker);
    const newest = await query("session.read", { sessionId, count: 1, parts: ["text", "tool"] });
    const newestMessages = records(newest.messages);
    expect(newest.returned).toBe(1);
    expect(newestMessages).toHaveLength(1);
    expect(records(newestMessages[0]?.tools)).toHaveLength(1);
    expect(records(newestMessages[0]?.tools)[0]).toMatchObject({ callId, tool: "bash", status: "completed" });
    evidence.recordAssertionEvidence("Newest count-one page retains the persisted tool", "The bounded newest page returned exactly one message containing exactly the persisted bash call ID, not only continuation metadata; an empty or dropped page fails this witness.", true);
    const history = record(newest.history);
    expect(history.complete).toBe(false);
    if (typeof history.nextBefore === "string") {
      const older = await query("session.read", { sessionId, count: 1, parts: ["text", "tool"], before: history.nextBefore });
      const nativeOlder = records(await request(`${base}/${sessionId}/message?${new URLSearchParams({ limit: "1", before: history.nextBefore })}`));
      expect(nativeOlder).toHaveLength(1);
      expect(record(nativeOlder[0]?.info).id).not.toBe(records(newest.messages)[0]?.id);
      const visible = nativeOlder.filter((message) => records(message.parts).some((part) =>
        (part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string" && part.text.trim())
        || (part.type === "tool" && part.tool && part.callID && part.state)));
      expect(records(older.messages).map((message) => message.id)).toEqual(visible.map((message) => record(message.info).id));
      evidence.recordAssertionEvidence("Native history cursor advances", "The isolated engine advertised X-Next-Cursor; replaying it as before returned a different older native message with count=1. The read projection matched its eligible text/tool parts, excluding synthetic-only messages. No unsupported cursor parameter was sent.", true);
    } else {
      expect(history.nextBefore).toBeNull();
      evidence.recordAssertionEvidence("Native history without a cursor remains incomplete", "The isolated engine did not advertise X-Next-Cursor at count=1. The adapter returned complete=false and no invented continuation; HTTP witnesses separately exercise supported before pagination.", true);
    }
    const summary = await query("session.read", { sessionId, summary: true, parts: ["text", "tool"] });
    expect(record(summary.firstUser).text).toBe(firstUser);
    expect(summary.lastAssistant).toBeNull();
    const toolSearch = await query("session.search", { query: outputMarker, in: ["tool"], match: "phrase" });
    expect(records(toolSearch.results).map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(records(toolSearch.results)[0]).toMatchObject({ kind: "tool", tool: "bash", callId, status: "completed" });
    expect(JSON.stringify(toolSearch)).not.toContain("fixture-secret");
    const defaultSearch = await query("session.search", { query: outputMarker, match: "phrase" });
    expect(records(defaultSearch.results).map((entry) => entry.sessionId)).toEqual([neighborId]);
    const secretSearch = await query("session.search", { query: "fixture-secret", in: ["tool"] });
    expect(secretSearch.results).toEqual([]);
    evidence.recordAssertionEvidence("Real shell tool opt-in, default isolation, full-field search and redaction", "The engine persisted exactly one completed bash call; session.read returned the same call ID with redacted fields capped at 2000 characters. Tool search found an output-only marker beyond the read cap, excluded the text/title neighbor and could not find the secret. Default read/search excluded tool data; a tool-only assistant did not become the summary reply.", true);
    const activity = await query("session.activity", { sessionId });
    expect(activity.toolCalls).toEqual({ total: 1, byTool: { bash: 1 }, byAffordanceId: {} });
    const errors = record(activity.errors);
    expect(errors.total).toBe(1);
    const failures = records(errors.list);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ callId, tool: "bash" });
    expect(failures[0]).toMatchObject({ code: "failed_outcome", message: "Tool reported a failed outcome" });
    expect(JSON.stringify(activity)).not.toContain("intentional failure");
    openworkSessionActivityResultSchema.parse(activity);
    expect(JSON.stringify(activity)).not.toContain("fixture-secret");
    expect(activity.firstAt).toBeTypeOf("number");
    expect(activity.lastAt).toBeTypeOf("number");
    expect(activity.messages).toMatchObject({ assistant: 1 });
    const inclusive = await query("session.activity", { sessionId, since: failures[0]?.at });
    expect(record(inclusive.toolCalls).total).toBe(1);
    if (typeof activity.lastAt !== "number") throw new Error("Expected dated real engine activity");
    const future = await query("session.activity", { sessionId, since: activity.lastAt + 1 });
    expect(future).toMatchObject({ toolCalls: { total: 0, byTool: {}, byAffordanceId: {} }, errors: { total: 0, list: [] }, messages: { user: 0, assistant: 0 }, firstAt: null, lastAt: null });
    const neighbor = await query("session.activity", { sessionId: neighborId });
    expect(neighbor.toolCalls).toEqual({ total: 0, byTool: {}, byAffordanceId: {} });
    expect(neighbor.errors).toEqual({ total: 0, list: [], truncated: false, nextOffset: null });
    evidence.recordAssertionEvidence("Activity counts the real call and its failed JSON outcome exactly once", "Activity changed from zero to one bash call and one completed ok:false outcome with the same call ID. Activity used a fixed failure code/label rather than copying any error payload. Inclusive since preserved the call, future since returned honest zeros, and the neighbor retained zero tool calls/errors.", true);
    const context = record(JSON.parse(await plugin.tool.openwork_context.execute()));
    const listing = records(record(context.context).availableAffordances).find((entry) => entry.id === "session.list_sessions");
    if (!listing) throw new Error("Isolated app did not advertise session.list_sessions");
    const archiveArgument = records(listing.arguments).find((argument) => argument.name === "archived");
    expect(archiveArgument).toMatchObject({ type: "string", required: false });
    for (const mode of ["include (default)", "exclude", "only"]) expect(text(archiveArgument?.description)).toContain(mode);
    expect(text(listing.description)).toContain("`archived`");
    const listApp = async (archived?: string) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({
        id: "session.list_sessions", args: { workspaceId, ...(archived === undefined ? {} : { archived }) },
      })));
      expect(output.ok).toBe(true);
      return records(output.result);
    };
    const bothIds = [sessionId, neighborId].sort();
    const initial = await eventually(() => listApp(), {
      within: 15_000, intervalMs: 250, label: "both real sessions loaded by the isolated app inventory",
      until: (entries) => bothIds.every((id) => entries.some((entry) => entry.sessionId === id && entry.archived === false)),
    });
    expect(initial.map((entry) => entry.sessionId).sort()).toEqual(bothIds);
    for (const archived of [1700000000000, 0]) {
      const updated = record(await request(`${base}/${neighborId}`, { time: { archived } }, "PATCH"));
      expect(record(updated.time).archived).toBe(archived);
      const isArchived = archived > 0;
      const loaded = await eventually(() => listApp("include"), {
        within: 15_000, intervalMs: 250, label: `app inventory observes archive timestamp ${archived}`,
        until: (entries) => entries.some((entry) => entry.sessionId === neighborId && entry.archived === isArchived),
      });
      expect(loaded.map((entry) => entry.sessionId).sort()).toEqual(bothIds);
      expect(loaded.find((entry) => entry.sessionId === sessionId)?.archived).toBe(false);
      expect((await listApp()).map((entry) => ({ id: entry.sessionId, archived: entry.archived }))).toEqual(loaded.map((entry) => ({ id: entry.sessionId, archived: entry.archived })));
      const excluded = await listApp("exclude");
      expect(excluded.map((entry) => entry.sessionId).sort()).toEqual(isArchived ? [sessionId] : bothIds);
      expect(excluded.every((entry) => entry.archived === false)).toBe(true);
      const only = await listApp("only");
      expect(only.map((entry) => entry.sessionId)).toEqual(isArchived ? [neighborId] : []);
      expect(only.every((entry) => entry.archived === true)).toBe(true);
    }
    evidence.recordAssertionEvidence("The real app advertises and applies archive inventory filters, including restored timestamp zero", "Through the isolated plugin bridge, session.list_sessions advertised the archived argument and include/exclude/only modes. Native engine PATCH persisted 1700000000000 then 0; bounded polling observed archived=true then false in the app inventory. Default matched include, exclude removed only the archived neighbor, only returned that neighbor while archived and became empty after restore; the untouched session stayed unarchived.", true);
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    await rm(scratch, { recursive: true, force: true });
  }
});
