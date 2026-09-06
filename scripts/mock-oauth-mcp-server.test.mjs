import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./mock-oauth-mcp-server.mjs", import.meta.url));

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for mock OAuth MCP server");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

test("mock OAuth HTML, Basic auth, and errors keep security boundaries", { timeout: 10_000 }, async (context) => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      AUTO_APPROVE: "0",
      DISABLE_DCR: "1",
      HOST: "127.0.0.1",
      ISSUER: origin,
      MOCK_CLIENT_ID: "test-client",
      MOCK_CLIENT_SECRET: "test-secret",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stop(child));

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  });

  const authorizeUrl = new URL(`${origin}/authorize`);
  authorizeUrl.searchParams.set("client_id", "test-client");
  authorizeUrl.searchParams.set("redirect_uri", `${origin}/callback`);
  authorizeUrl.searchParams.set("scope", "mcp:read");
  authorizeUrl.searchParams.set("state", `"><script>alert("unsafe")</script>`);
  const authorizeResponse = await fetch(authorizeUrl);
  const authorizeHtml = await authorizeResponse.text();
  assert.equal(authorizeResponse.status, 200);
  assert.equal(
    authorizeResponse.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const action = authorizeHtml.match(/<form method="post" action="([^"]+)">/)?.[1];
  assert.ok(action);
  assert.match(action, /^\/approve\?/);
  assert.match(action, /&amp;redirect_uri=/);
  assert.doesNotMatch(action, /&redirect_uri=/);

  const credentials = Buffer.from("test-client:test-secret").toString("base64");
  const tokenResponse = await fetch(`${origin}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${" ".repeat(4_096)}${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=refresh_token",
  });
  assert.equal(tokenResponse.status, 200);
  const accessToken = (await tokenResponse.json()).access_token;
  assert.equal(typeof accessToken, "string");

  const configured = await fetch(`${origin}/admin/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools: [{
      name: "execute_capability",
      description: "A deterministic handoff witness",
      inputSchema: { type: "object", properties: { target: { type: "string" } } },
      result: { content: [{ type: "text", text: "queued" }] },
    }] }),
  });
  assert.equal(configured.status, 200);
  const rpc = async (method, params) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const discovery = await rpc("server/discover", {});
  assert.equal(discovery.error.code, -32601);
  assert.equal("result" in discovery, false);
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const listed = await rpc("tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["execute_capability"]);
  assert.equal("result" in listed.result.tools[0], false);
  const invoked = await rpc("tools/call", { name: "execute_capability", arguments: { target: "desktop" } });
  assert.equal(invoked.result.content[0].text, "queued");
  const log = await (await fetch(`${origin}/requests`)).json();
  assert.deepEqual(log.requests.flatMap((entry) => entry.toolCalls ?? []).map(({ name, args }) => ({ name, args })), [
    { name: "execute_capability", args: { target: "desktop" } },
  ]);

  const workload = await fetch(`${origin}/admin/agent-workloads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [{
      promptMarker: "[The user selected @",
      finalReply: "Handoff received",
      steps: [{ tool: "execute_capability", arguments: { ignored: true }, argumentsFrom: "computer-mention" }],
    }] }),
  });
  assert.equal(workload.status, 200);
  for (const [target, task] of [["cloud", "Summarize today's notes."], ["desktop", "Review the changed draft."]]) {
    const completion = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "handoff-model",
        messages: [{ role: "user", content: [
          { type: "text", text: `@${target} ${task}` },
          { type: "text", text: `[The user selected @${target}: execute it with target "${target}" and the user's task as prompt.]` },
        ] }],
        tools: [{ type: "function", function: { name: "execute_capability" } }],
      }),
    });
    assert.equal(completion.status, 200);
    const frames = (await completion.text()).split("\n")
      .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    const call = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])[0];
    assert.deepEqual(JSON.parse(call.function.arguments), { name: "remote-session:create", body: { target, prompt: task } });
  }

  const discoveryWorkload = await fetch(`${origin}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [{ promptMarker: "Find the assigned skill", finalReply: "unused fixture reply",
      finalReplyFrom: "last-tool-text", steps: [
        { tool: "search_capabilities", arguments: { query: "Assigned skill" } },
        { tool: "execute_capability", arguments: { body: { limit: 3 } }, argumentsFrom: "capability-search" },
      ],
    }] }),
  });
  assert.equal(discoveryWorkload.status, 200);
  const modelRequest = async (toolResults) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "discovery-model", messages: [
        { role: "user", content: "Find the assigned skill" },
        ...toolResults.map(content => ({ role: "tool", content })),
      ], tools: ["search_capabilities", "execute_capability"].map(name => ({ type: "function", function: { name } })) }),
    });
    const body = await response.text();
    return { status: response.status, frames: body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))) };
  };
  for (const name of ["plugin:first:skill", "plugin:second:skill"]) {
    const result = await modelRequest([JSON.stringify({ matches: [{ name }] })]);
    assert.equal(result.status, 200);
    const call = result.frames.flatMap(frame => frame.choices[0].delta.tool_calls ?? [])[0];
    assert.deepEqual(JSON.parse(call.function.arguments), { name, body: { limit: 3 } });
  }
  const missing = await modelRequest([JSON.stringify({ matches: [] })]);
  assert.equal(missing.status, 500);
  const final = await modelRequest([JSON.stringify({ matches: [{ name: "plugin:first:skill" }] }), "unique text returned by the real tool"]);
  assert.equal(final.status, 200);
  assert.equal(final.frames.map(frame => frame.choices[0].delta.content ?? "").join(""), "unique text returned by the real tool");

  const failedResponse = await fetch(`${origin}/admin/agent-workloads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), { error: "internal_server_error" });
  await waitFor(() => stderr.includes("[mock-oauth-mcp] request failed"));
});
