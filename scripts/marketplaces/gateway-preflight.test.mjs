import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { annotationSummary, main, parseRpcResponse, skillBody, toolData } from "./gateway-preflight.mjs";

const scriptUrl = new URL("./gateway-preflight.mjs", import.meta.url);
const checkout = dirname(dirname(dirname(fileURLToPath(scriptUrl))));
const fixtureUrl = new URL("../../integrations/marketplace-submissions/fixtures/reviewer-weekly-brief/SKILL.md", import.meta.url);
const gateway = "https://api.openworklabs.com/mcp/agent";
const resourceMetadata = "https://api.openworklabs.com/.well-known/oauth-protected-resource/mcp/agent";
const authorizationMetadata = "https://app.openworklabs.com/.well-known/oauth-authorization-server/api/auth";
const tokenEndpoint = "https://app.openworklabs.com/api/auth/oauth2/token";
const bootstrapEndpoint = "https://api.openworklabs.com/v1/bootstrap/workspace";
const secret = "synthetic-secret-must-not-appear";
const accessToken = "synthetic-access-token-must-not-appear";
const hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const responseMessage = { jsonrpc: "2.0", id: 7, result: { tools: [] } };

for (const [name, text, expected] of [
  ["compact JSON", JSON.stringify(responseMessage), responseMessage],
  ["pretty JSON with surrounding whitespace", ` \n${JSON.stringify(responseMessage, null, 2)}\n `, responseMessage],
  ["JSON-RPC error", JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid parameters" } }), { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid parameters" } }],
]) {
  test(`parseRpcResponse preserves ${name}`, () => {
    assert.deepEqual(parseRpcResponse(text), expected);
  });
}

test("parseRpcResponse skips SSE comments and notifications before the response", () => {
  const stream = [
    ": keepalive",
    "",
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
    "",
    `event: message\nid: transport-event\ndata: ${JSON.stringify(responseMessage)}`,
    "",
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
    "",
  ].join("\n");
  assert.deepEqual(parseRpcResponse(stream), responseMessage);
});

test("parseRpcResponse joins multiline SSE data with CRLF and ignores transport fields", () => {
  const stream = [
    ": comment", "retry: 1000", "", "event: message", "id: ignored",
    'data: {"jsonrpc":"2.0",', 'data: "id":7,', 'data: "result":{"tools":[]}}', "", "",
  ].join("\r\n");
  assert.deepEqual(parseRpcResponse(stream), responseMessage);
});

for (const id of [0, null]) {
  test(`parseRpcResponse recognizes an SSE response whose id is ${id}`, () => {
    const expected = { jsonrpc: "2.0", id, error: { code: -32700, message: "Parse error" } };
    assert.deepEqual(parseRpcResponse(`data: ${JSON.stringify(expected)}\n\n`), expected);
  });
}

for (const [name, text, error] of [
  ["malformed JSON", '{"jsonrpc":', SyntaxError],
  ["malformed SSE data", "data: not-json\n\n", SyntaxError],
  ["an empty response", " \r\n", /No JSON-RPC response received/],
  ["only SSE notifications", 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', /No JSON-RPC response received/],
  ["only SSE transport metadata", ": keepalive\nevent: message\nid: not-a-rpc-id\n\n", /No JSON-RPC response received/],
]) {
  test(`parseRpcResponse rejects ${name}`, () => {
    assert.throws(() => parseRpcResponse(text), error);
  });
}

test("annotationSummary accepts explicit false values and preserves the input", () => {
  const tools = [{ name: "test_tool", annotations: { ...hints } }];
  const before = structuredClone(tools);
  assert.deepEqual(annotationSummary(tools), [{ name: "test_tool", complete: true, annotations: hints }]);
  assert.deepEqual(tools, before);
  assert.deepEqual(annotationSummary([]), []);
});

for (const key of Object.keys(hints)) {
  test(`annotationSummary requires a boolean ${key}, not a missing or truthy value`, () => {
    for (const value of [undefined, null, 0, 1, "false", "true", {}]) {
      const annotations = { ...hints, [key]: value };
      assert.equal(annotationSummary([{ name: "test_tool", annotations }])[0].complete, false);
    }
    assert.equal(annotationSummary([{ name: "test_tool", annotations: { ...hints, [key]: true } }])[0].complete, true);
  });
}

test("annotationSummary marks absent annotations incomplete", () => {
  assert.deepEqual(annotationSummary([{ name: "test_tool" }]), [{ name: "test_tool", complete: false, annotations: null }]);
});

test("annotationSummary drops arbitrary secret-bearing annotation extensions", () => {
  const tools = [{ name: "test_tool", annotations: {
    ...hints, access_token: accessToken, metadata: { assertion: secret }, title: secret,
  } }];
  const before = structuredClone(tools);
  const summary = annotationSummary(tools);
  assert.deepEqual(summary, [{ name: "test_tool", complete: true, annotations: hints }]);
  assert.deepEqual(tools, before);
  assertNoSecrets(JSON.stringify(summary));
});

for (const key of Object.keys(hints)) {
  test(`annotationSummary replaces secret-bearing nonboolean ${key} with null`, () => {
    for (const value of [secret, { access_token: accessToken }, [secret]]) {
      const summary = annotationSummary([{ name: "test_tool", annotations: { ...hints, [key]: value } }]);
      assert.deepEqual(summary, [{ name: "test_tool", complete: false, annotations: { ...hints, [key]: null } }]);
      assertNoSecrets(JSON.stringify(summary));
    }
  });
}

test("toolData prefers structured content to conflicting JSON text", () => {
  const structuredContent = { skills: [{ capability: "plugin:synthetic:skill" }] };
  assert.equal(toolData({ structuredContent, content: [{ type: "text", text: '{"skills":[]}' }] }), structuredContent);
  assert.deepEqual(toolData({ structuredContent: {} }), {});
});

test("toolData skips non-text and non-JSON content before the first JSON text", () => {
  assert.deepEqual(toolData({ content: [
    { type: "image", data: "synthetic", mimeType: "image/png" },
    { type: "text", text: "Readable fallback, not JSON" },
    { type: "text", text: "{malformed" },
    { type: "text", text: '{"matches":[]}' },
    { type: "text", text: '{"ignored":true}' },
  ] }), { matches: [] });
});

test("toolData refuses tool errors even when structured content is present", () => {
  assert.throws(() => toolData({ isError: true, structuredContent: { error: secret }, content: [{ type: "text", text: secret }] }), (error) => {
    assert.equal(error.message, "Tool returned an error");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

for (const [name, value] of [
  ["missing result", undefined],
  ["missing content", {}],
  ["empty content", { content: [] }],
  ["plain text", { content: [{ type: "text", text: secret }] }],
  ["malformed JSON text", { content: [{ type: "text", text: `{"secret":"${secret}"` }] }],
]) {
  test(`toolData rejects ${name} without including its body in the error`, () => {
    assert.throws(() => toolData(value), (error) => {
      assert.equal(error.message, "Tool did not return structured data");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  });
}

test("skillBody compares canonicalized frontmatter rather than dynamic descriptor names", () => {
  const original = "---\nname: reviewer-weekly-brief\ndescription: original\n---\n\n# Brief\n\nDocumentation refresh.\n";
  const canonical = "---\r\nname: reviewer-weekly-brief-z90p\r\ndescription: \"Canonical description\"\r\n---\r\n\n# Brief\n\nDocumentation refresh.\n";
  assert.equal(skillBody(original), skillBody(canonical));
});

test("skillBody preserves body content and internal separators", () => {
  const body = "# Brief\n\n---\n\nKeep this separator and these instructions.";
  assert.equal(skillBody(`---\nname: synthetic\n---\n\n${body}\n`), body);
  assert.equal(skillBody(` \n${body}\n `), body);
  assert.notEqual(skillBody(`${body}\nChanged instruction.`), skillBody(body));
});

test("skillBody handles frontmatter ending at EOF and does not strip an unclosed header", () => {
  assert.equal(skillBody("---\nname: synthetic\n---"), "");
  assert.equal(skillBody("---\r\nname: synthetic\r\n---"), "");
  assert.equal(skillBody("---\nname: synthetic\n# Unclosed header"), "---\nname: synthetic\n# Unclosed header");
  assert.throws(() => skillBody(undefined), /Skill content missing/);
});

test("importing the module neither fetches nor reads, writes, or provisions private state", () => {
  const probe = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const calls = [];
    for (const name of ["readFile", "writeFile", "mkdir", "realpath", "lstat"]) {
      fs[name] = () => { calls.push(name); throw new Error("Unexpected import side effect"); };
    }
    syncBuiltinESMExports();
    globalThis.fetch = () => { calls.push("fetch"); throw new Error("Network forbidden during import"); };
    console.log = () => calls.push("console.log");
    console.error = () => calls.push("console.error");
    process.argv = [process.execPath, "import-only", "--prepare-qa", "unused-private-state"];
    const imported = await import(${JSON.stringify(scriptUrl.href)});
    process.stdout.write(JSON.stringify({ calls, exports: Object.keys(imported).sort() }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8", timeout: 10000 }));
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.exports, ["annotationSummary", "main", "parseRpcResponse", "skillBody", "toolData"]);
});

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function publicReply(url) {
  if (url === gateway) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"` } });
  if (url === resourceMetadata) return json({ resource: gateway, authorization_servers: ["https://app.openworklabs.com/api/auth"] });
  if (url === authorizationMetadata) return json({
    issuer: "https://app.openworklabs.com/api/auth", code_challenge_methods_supported: ["S256"],
    registration_endpoint: "https://app.openworklabs.com/api/auth/oauth2/register",
    grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint: tokenEndpoint,
  });
  if (url === "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.openworklabs%2Fopenwork&limit=100") return json({ servers: [{
    server: { name: "com.openworklabs/openwork", remotes: [{ url: gateway }] },
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true, status: "active" } },
  }] });
  if (["privacy", "terms", "docs/start-here/connect-openwork-mcp"].some((path) => url === `https://openworklabs.com/${path}`)) return new Response("Synthetic public page");
  throw new Error(`Unmocked request; real network is forbidden: ${url}`);
}

function mockRun(t, reply = () => undefined) {
  const requests = [];
  const output = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(typeof url, "string");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    requests.push({ url, options });
    return await reply(url, options) ?? publicReply(url);
  });
  t.mock.method(console, "log", (text) => output.push(text));
  return { requests, output, async run(args) {
    const start = output.length;
    const exitCode = await main(args);
    assert.equal(output.length, start + 1);
    const text = output[start];
    return { exitCode, text, report: JSON.parse(text) };
  } };
}

function qaCheck(report) {
  return report.checks.find((check) => check.name === "Isolated synthetic QA workspace");
}

function assertNoSecrets(text) {
  for (const value of [secret, accessToken]) assert.equal(text.includes(value), false, "Reports must not contain synthetic credentials");
}

async function privateState(t, overrides = {}) {
  const base = join(tmpdir(), "opencode");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, "gateway-preflight-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const state = {
    identity: { tokenEndpoint, assertionType: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: secret },
    setup: { expiresAt: new Date(Date.now() + 86400000).toISOString() },
    ...overrides,
  };
  await writeFile(join(directory, "bootstrap.json"), JSON.stringify(state), { mode: 0o600 });
  return { directory, state };
}

test("--public checks only mocked discovery, registry and public pages without provisioning", async (t) => {
  const mocked = mockRun(t);
  const { exitCode, report, text } = await mocked.run(["--public"]);
  assert.equal(exitCode, 0);
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every((check) => check.status === "passed"));
  assert.equal(mocked.requests.length, 7);
  assert.equal(mocked.requests.filter(({ url, options }) => options.method === "POST").length, 1);
  assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
  assert.ok(report.notVerified.includes("Human OAuth sign-in, refresh and revocation in each target client"));
  assertNoSecrets(text);
});

for (const failure of ["network exception", "HTTP error body", "malformed JSON", "unexpected metadata shape"]) {
  test(`--public sanitizes ${failure} and continues independent checks`, async (t) => {
    const mocked = mockRun(t, (url) => {
      if (url !== resourceMetadata) return;
      if (failure === "network exception") throw new Error(`Authorization: Bearer ${secret}`);
      if (failure === "HTTP error body") return json({ access_token: secret }, 503);
      if (failure === "malformed JSON") return new Response(`{"access_token":"${secret}"`, { status: 200 });
      return json({ resource: secret, authorization_servers: [] });
    });
    const { exitCode, report, text } = await mocked.run(["--public"]);
    assert.equal(exitCode, 1);
    assert.equal(report.checks[0].status, "failed");
    assert.ok(report.checks.slice(1).every((check) => check.status === "passed"));
    assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
    assertNoSecrets(text);
  });
}

test("private state rejects a symlink resolving inside the checkout before writing or token exchange", async (t) => {
  const { directory } = await privateState(t);
  const alias = join(directory, "checkout-link");
  await symlink(checkout, alias, "dir");
  const mocked = mockRun(t);
  const { exitCode, report, text } = await mocked.run(["--prepare-qa", alias]);
  assert.equal(exitCode, 1);
  assert.equal(qaCheck(report).reason, "QA credentials must be outside the checkout");
  assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
  assertNoSecrets(text);
});

test("checkout containment rejects an existing child beginning with two dots without filesystem writes", () => {
  // Mock built-in filesystem bindings in a child, rather than creating a secret-state
  // directory in the checkout. This exercises main's real, unexported path guard.
  const probe = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const writes = [];
    fs.realpath = async (path) => String(path).startsWith(${JSON.stringify(checkout)}) ? "/synthetic-checkout" : path;
    fs.mkdir = async () => { writes.push("mkdir"); };
    fs.lstat = async () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700 });
    fs.writeFile = async () => { writes.push("writeFile"); throw new Error("Unexpected state write"); };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const json = (value) => new Response(JSON.stringify(value));
      if (url === ${JSON.stringify(gateway)}) return new Response(null, { status: 401, headers: { "WWW-Authenticate": ${JSON.stringify(`Bearer resource_metadata="${resourceMetadata}"`)} } });
      if (url === ${JSON.stringify(resourceMetadata)}) return json({ resource: ${JSON.stringify(gateway)}, authorization_servers: ["https://app.openworklabs.com/api/auth"] });
      if (url === ${JSON.stringify(authorizationMetadata)}) return json({ issuer: "https://app.openworklabs.com/api/auth", code_challenge_methods_supported: ["S256"], registration_endpoint: "https://app.openworklabs.com/api/auth/oauth2/register", grant_types_supported: ["refresh_token"], token_endpoint: ${JSON.stringify(tokenEndpoint)} });
      if (path === "/v0.1/servers") return json({ servers: [] });
      if (["/privacy", "/terms", "/docs/start-here/connect-openwork-mcp"].includes(path)) return new Response("Synthetic public page");
      throw new Error("Unmocked request; real network is forbidden");
    };
    let report;
    console.log = (text) => { report = JSON.parse(text); };
    const { main } = await import(${JSON.stringify(scriptUrl.href)});
    const exitCode = await main(["--prepare-qa", "/synthetic-checkout/..qa"]);
    process.stdout.write(JSON.stringify({ exitCode, writes, report }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8", timeout: 10000 }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.writes, []);
  assert.equal(qaCheck(result.report).reason, "QA credentials must be outside the checkout");
});

for (const guard of ["directory permissions", "state permissions", "state symlink", "expired workspace", "untrusted token endpoint", "malformed local JSON"]) {
  test(`--check-qa rejects ${guard} before sending credentials`, async (t) => {
    const { directory, state } = await privateState(t);
    const statePath = join(directory, "bootstrap.json");
    if (guard === "directory permissions") await chmod(directory, 0o755);
    if (guard === "state permissions") await chmod(statePath, 0o644);
    if (guard === "state symlink") {
      const target = join(directory, "original-state.json");
      await writeFile(target, JSON.stringify(state), { mode: 0o600 });
      await rm(statePath);
      await symlink(target, statePath);
    }
    if (guard === "expired workspace") {
      state.setup.expiresAt = "2000-01-01T00:00:00.000Z";
      await writeFile(statePath, JSON.stringify(state));
    }
    if (guard === "untrusted token endpoint") {
      state.identity.tokenEndpoint = `https://untrusted.example/token?assertion=${secret}`;
      await writeFile(statePath, JSON.stringify(state));
    }
    if (guard === "malformed local JSON") await writeFile(statePath, `{"assertion":"${secret}"`);
    const mocked = mockRun(t);
    const { exitCode, report, text } = await mocked.run(["--check-qa", directory]);
    assert.equal(exitCode, 1);
    assert.equal(qaCheck(report).status, "failed");
    assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
    assertNoSecrets(text);
  });
}

test("--prepare-qa never overwrites existing state or provisions a second workspace", async (t) => {
  const { directory } = await privateState(t);
  const path = join(directory, "bootstrap.json");
  const original = await readFile(path, "utf8");
  const mocked = mockRun(t);
  const { exitCode, report, text } = await mocked.run(["--prepare-qa", directory]);
  assert.equal(exitCode, 1);
  assert.equal(qaCheck(report).status, "failed");
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
  assertNoSecrets(text);
});

test("failed mocked bootstrap leaves a reservation that prevents a blind retry", async (t) => {
  const { directory } = await privateState(t);
  const path = join(directory, "bootstrap.json");
  await rm(path);
  const mocked = mockRun(t, (url) => url === bootstrapEndpoint ? json({ assertion: secret }, 503) : undefined);
  const first = await mocked.run(["--prepare-qa", directory]);
  const second = await mocked.run(["--prepare-qa", directory]);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, 1);
  assert.equal(mocked.requests.filter(({ url }) => url === bootstrapEndpoint).length, 1);
  assert.equal(await readFile(path, "utf8"), "{}\n");
  assertNoSecrets(first.text);
  assertNoSecrets(second.text);
});

async function authenticatedMock(t, options = {}) {
  const { directory, state } = await privateState(t);
  const fixture = await readFile(fixtureUrl, "utf8");
  const descriptor = { name: "reviewer-weekly-brief-z90p", title: "reviewer-weekly-brief", capability: "plugin:synthetic-plugin:synthetic-skill" };
  const canonical = `---\nname: ${descriptor.name}\ndescription: \"Canonicalized review fixture\"\n---\n\n${skillBody(fixture)}\n`;
  let exists = options.fixtureExists !== false;
  const protocolVersion = Object.hasOwn(options, "protocolVersion") ? options.protocolVersion : "2025-11-25";
  const calls = [];
  const mocked = mockRun(t, (url, request) => {
    if (url === tokenEndpoint) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(request.body.get("grant_type"), state.identity.assertionType);
      assert.equal(request.body.get("assertion"), secret);
      return json({ access_token: accessToken, token_type: "Bearer", scope: "mcp:read mcp:write", expires_in: 900 });
    }
    if (url !== gateway || !request.headers.Authorization) return;
    assert.equal(request.headers.Authorization, `Bearer ${accessToken}`);
    const rpc = JSON.parse(request.body);
    calls.push(rpc);
    const message = (value) => {
      const response = { jsonrpc: "2.0", id: rpc.id, result: value };
      return options.responseOverride?.(rpc, response) ?? response;
    };
    if (rpc.method === "initialize") {
      assert.equal(request.headers["MCP-Protocol-Version"], undefined);
      return new Response(`: keepalive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\r\n\r\ndata: ${JSON.stringify(message({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }))}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "synthetic-session" } });
    }
    assert.equal(request.headers["MCP-Protocol-Version"], protocolVersion);
    assert.equal(request.headers["Mcp-Session-Id"], "synthetic-session");
    if (rpc.method === "notifications/initialized") {
      assert.equal(Object.hasOwn(rpc, "id"), false);
      return new Response(null, { status: 202 });
    }
    const result = (value) => json(message(value));
    if (rpc.method === "tools/list") return result({ tools: ["search_capabilities", "execute_capability", "list_skills", "get_skill", "create_skill"].map((name) => ({ name, annotations: options.annotations ?? { ...hints } })) });
    assert.equal(rpc.method, "tools/call");
    const { name, arguments: args } = rpc.params;
    if (options.rpcError === name) return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: secret, data: { access_token: accessToken } } });
    if (name === "list_skills") {
      assert.deepEqual(args, { query: "reviewer-weekly-brief" });
      return result({ structuredContent: { skills: exists ? [descriptor] : [] } });
    }
    if (name === "create_skill") {
      assert.equal(exists, false);
      assert.equal(args.pluginName, "Marketplace Review Fixture");
      assert.equal(args.skillMarkdown, fixture);
      exists = true;
      return result({ content: [{ type: "text", text: '{"name":"reviewer-weekly-brief-z90p"}' }] });
    }
    if (name === "get_skill") {
      assert.deepEqual(args, { name: descriptor.capability });
      return result({ structuredContent: { ...descriptor, content: options.changedBody ? `${canonical}\nChanged instructions.` : canonical } });
    }
    if (name === "search_capabilities") {
      assert.deepEqual(args, { query: "reviewer weekly brief", type: "skills", limit: 20 });
      return result({ structuredContent: { matches: [{ name: descriptor.capability }] } });
    }
    assert.equal(name, "execute_capability");
    assert.deepEqual(args, { name: descriptor.capability });
    return result({ content: [{ type: "text", text: canonical }] });
  });
  return { ...mocked, directory, calls };
}

for (const fixtureExists of [true, false]) {
  test(`mocked QA uses descriptor title and canonical body with ${fixtureExists ? "an existing" : "a newly created"} fixture`, async (t) => {
    const mocked = await authenticatedMock(t, { fixtureExists });
    const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
    assert.equal(exitCode, 0);
    assert.equal(qaCheck(report).status, "passed");
    assert.deepEqual(report.qa, { status: "passed", expiresAt: report.qa.expiresAt, fixture: "reviewer-weekly-brief", humanOAuthTested: false });
    assert.equal(mocked.calls.filter((rpc) => rpc.params?.name === "create_skill").length, fixtureExists ? 0 : 1);
    assert.equal(mocked.calls.filter((rpc) => rpc.params?.name === "execute_capability").length, 1);
    assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint));
    assertNoSecrets(text);
  });
}

test("mocked QA refuses changed skill instructions despite matching descriptor title", async (t) => {
  const mocked = await authenticatedMock(t, { changedBody: true });
  const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
  assert.equal(exitCode, 1);
  assert.equal(qaCheck(report).reason, "Review fixture content differs");
  assert.equal(mocked.calls.some((rpc) => rpc.params?.name === "execute_capability"), false);
  assertNoSecrets(text);
});

test("mocked QA sanitizes JSON-RPC provider errors without executing the fixture", async (t) => {
  const mocked = await authenticatedMock(t, { rpcError: "get_skill" });
  const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
  assert.equal(exitCode, 1);
  assert.equal(qaCheck(report).reason, "MCP request failed for tools/call");
  assert.equal(mocked.calls.some((rpc) => rpc.params?.name === "execute_capability"), false);
  assertNoSecrets(text);
});

test("mocked QA reports only boolean annotations, dropping secret-bearing extensions", async (t) => {
  const mocked = await authenticatedMock(t, { annotations: { ...hints, access_token: accessToken, extra: { assertion: secret } } });
  const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
  assert.equal(exitCode, 0);
  assert.ok(report.tools.every((tool) => tool.complete));
  for (const tool of report.tools) assert.deepEqual(tool.annotations, hints);
  assertNoSecrets(text);
});

for (const key of Object.keys(hints)) {
  test(`mocked QA redacts nonboolean ${key} from a failed annotation report`, async (t) => {
    const mocked = await authenticatedMock(t, { annotations: { ...hints, [key]: secret, extra: accessToken } });
    const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
    assert.equal(exitCode, 1);
    assert.equal(qaCheck(report).reason, "Some tools lack explicit annotations");
    for (const tool of report.tools) {
      assert.equal(tool.complete, false);
      assert.deepEqual(tool.annotations, { ...hints, [key]: null });
    }
    assert.equal(mocked.calls.some((rpc) => rpc.method === "tools/call"), false);
    assert.equal(Object.hasOwn(report, "qa"), false);
    assertNoSecrets(text);
  });
}

for (const [label, protocolVersion] of [
  ["unsupported version", "1999-01-01"],
  ["reflected secret", secret],
  ["secret-bearing object", { access_token: accessToken }],
  ["null", null],
  ["missing version", undefined],
]) {
  test(`mocked QA rejects ${label} before copying protocolVersion into the report`, async (t) => {
    const mocked = await authenticatedMock(t, { protocolVersion });
    const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
    assert.equal(exitCode, 1);
    assert.equal(qaCheck(report).reason, "Unexpected MCP protocol version");
    assert.equal(Object.hasOwn(report, "protocolVersion"), false);
    assert.equal(Object.hasOwn(report, "qa"), false);
    assert.deepEqual(mocked.calls.map((rpc) => rpc.method), ["initialize"]);
    assertNoSecrets(text);
  });
}

test("mocked QA accepts the supported 2026-07-28 protocol and uses its negotiated headers", async (t) => {
  const mocked = await authenticatedMock(t, { protocolVersion: "2026-07-28" });
  const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
  assert.equal(exitCode, 0);
  assert.equal(report.protocolVersion, "2026-07-28");
  assert.equal(report.qa.humanOAuthTested, false);
  assertNoSecrets(text);
});

for (const method of ["initialize", "tools/list"]) {
  for (const [label, override] of [
    ["different numeric id", (rpc) => ({ id: rpc.id + 1 })],
    ["stringified id", (rpc) => ({ id: String(rpc.id) })],
    ["secret-bearing id", () => ({ id: secret })],
    ["missing id", () => ({ id: undefined })],
    ["wrong JSON-RPC version", () => ({ jsonrpc: "1.0" })],
    ["secret-bearing JSON-RPC version", () => ({ jsonrpc: accessToken })],
    ["missing JSON-RPC version", () => ({ jsonrpc: undefined })],
  ]) {
    test(`mocked QA rejects ${label} on ${method} without leaking response metadata`, async (t) => {
      const mocked = await authenticatedMock(t, { responseOverride: (rpc, message) => (
        rpc.method === method ? { ...message, ...override(rpc) } : message
      ) });
      const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
      assert.equal(exitCode, 1);
      // initialize uses SSE, where messages without ids are skipped like notifications.
      const reason = method === "initialize" && label === "missing id"
        ? "No JSON-RPC response received" : `MCP response mismatch for ${method}`;
      assert.equal(qaCheck(report).reason, reason);
      assert.equal(mocked.calls.at(-1).method, method);
      assert.equal(mocked.calls.some((rpc) => rpc.method === "tools/call"), false);
      assert.equal(Object.hasOwn(report, "tools"), false);
      assert.equal(Object.hasOwn(report, "qa"), false);
      if (method === "initialize") assert.equal(Object.hasOwn(report, "protocolVersion"), false);
      assertNoSecrets(text);
    });
  }
}

for (const mode of ["--prepare-qa", "--check-qa"]) {
  for (const failure of ["issuer", "PKCE", "registration endpoint", "refresh grant", "protected resource", "challenge", "malformed discovery JSON"]) {
    test(`${mode} never bootstraps or exchanges tokens after failed ${failure} discovery`, async (t) => {
      const { directory } = await privateState(t);
      const path = join(directory, "bootstrap.json");
      const original = await readFile(path, "utf8");
      if (mode === "--prepare-qa") await rm(path);
      const mocked = mockRun(t, async (url) => {
        if (failure === "challenge" && url === gateway) return new Response(secret, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        if (failure === "protected resource" && url === resourceMetadata) return json({ resource: secret, authorization_servers: ["https://app.openworklabs.com/api/auth"] });
        if (url !== authorizationMetadata || ["challenge", "protected resource"].includes(failure)) return;
        if (failure === "malformed discovery JSON") return new Response(`{"issuer":"${secret}"`);
        const metadata = await publicReply(url).json();
        if (failure === "issuer") metadata.issuer = secret;
        if (failure === "PKCE") metadata.code_challenge_methods_supported = ["plain", secret];
        if (failure === "registration endpoint") metadata.registration_endpoint = `https://untrusted.example/register?assertion=${secret}`;
        if (failure === "refresh grant") metadata.grant_types_supported = ["authorization_code", secret];
        // Keep a valid token endpoint, so failure gating—not endpoint mismatch—must stop QA.
        assert.equal(metadata.token_endpoint, tokenEndpoint);
        return json(metadata);
      });
      const { exitCode, report, text } = await mocked.run([mode, directory]);
      assert.equal(exitCode, 1);
      assert.equal(report.checks[0].status, "failed");
      assert.ok(report.checks.slice(1, 5).every((check) => check.status === "passed"));
      assert.equal(qaCheck(report).reason, "QA requires trusted OAuth metadata");
      assert.equal(Object.hasOwn(report, "qa"), false);
      assert.ok(mocked.requests.every(({ url }) => url !== bootstrapEndpoint && url !== tokenEndpoint));
      if (mode === "--prepare-qa") await assert.rejects(readFile(path), { code: "ENOENT" });
      else assert.equal(await readFile(path, "utf8"), original);
      assertNoSecrets(text);
    });
  }
}

for (const target of ["directory", "state file"]) {
  test(`QA rejects another user's owner-only ${target} using mocked ownership, without chown`, () => {
    const probe = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const gateway = ${JSON.stringify(gateway)};
      const resourceMetadata = ${JSON.stringify(resourceMetadata)};
      const authorizationMetadata = ${JSON.stringify(authorizationMetadata)};
      const tokenEndpoint = ${JSON.stringify(tokenEndpoint)};
      const json = ${json.toString()};
      const publicReply = ${publicReply.toString()};
      const calls = [];
      const requests = [];
      process.getuid = () => 1000;
      fs.realpath = async (path) => String(path).startsWith(${JSON.stringify(checkout)}) ? "/synthetic-checkout" : path;
      fs.mkdir = async () => { calls.push("mkdir"); };
      fs.lstat = async (path) => {
        const isFile = String(path).endsWith("bootstrap.json");
        calls.push(isFile ? "fileStat" : "directoryStat");
        const wrongOwner = ${JSON.stringify(target)} === (isFile ? "state file" : "directory");
        return { isDirectory: () => !isFile, isFile: () => isFile, isSymbolicLink: () => false, mode: isFile ? 0o600 : 0o700, uid: wrongOwner ? 1001 : 1000 };
      };
      fs.readFile = async () => { calls.push("readFile"); throw new Error("Unexpected state read"); };
      fs.writeFile = async () => { calls.push("writeFile"); throw new Error("Unexpected state write"); };
      syncBuiltinESMExports();
      globalThis.fetch = async (url) => { requests.push(url); return publicReply(url); };
      let text;
      console.log = (value) => { text = value; };
      const { main } = await import(${JSON.stringify(scriptUrl.href)});
      const exitCode = await main([${JSON.stringify(target === "directory" ? "--prepare-qa" : "--check-qa")}, "/synthetic-private-state"]);
      process.stdout.write(JSON.stringify({ exitCode, calls, requests, text, report: JSON.parse(text) }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8", timeout: 10000 }));
    assert.equal(result.exitCode, 1);
    assert.equal(qaCheck(result.report).reason, target === "directory"
      ? "Private directory must be a real directory with owner-only permissions"
      : "QA state must be a regular owner-only file");
    assert.deepEqual(result.calls, target === "directory" ? ["mkdir", "directoryStat"] : ["mkdir", "directoryStat", "fileStat"]);
    assert.ok(result.requests.every((url) => url !== bootstrapEndpoint && url !== tokenEndpoint));
    assertNoSecrets(result.text);
  });
}

test("mocked QA redacts known credentials reflected inside tool names", async (t) => {
  const mocked = await authenticatedMock(t, { responseOverride: (rpc, message) => {
    if (rpc.method === "tools/list") {
      message.result.tools.push({ name: `extra-${accessToken}-${secret}`, annotations: { ...hints } });
    }
    return message;
  } });
  const { exitCode, report, text } = await mocked.run(["--check-qa", mocked.directory]);
  assert.equal(exitCode, 0);
  assert.ok(report.tools.some((tool) => tool.name === "extra-[redacted]-[redacted]"));
  assertNoSecrets(text);
});

for (const expiresAt of ["2030-01-01", "October 13, 2030 UTC", `2030-01-01T00:00:00.000Z ${secret}`]) {
  test("QA rejects noncanonical expiry metadata before sending credentials", async (t) => {
    const { directory } = await privateState(t, { setup: { expiresAt } });
    const mocked = mockRun(t);
    const { exitCode, report, text } = await mocked.run(["--check-qa", directory]);
    assert.equal(exitCode, 1);
    assert.equal(qaCheck(report).reason, "QA workspace expired or invalid; explicitly prepare a new one");
    assert.ok(mocked.requests.every(({ url }) => url !== tokenEndpoint && url !== bootstrapEndpoint));
    assertNoSecrets(text);
  });
}
