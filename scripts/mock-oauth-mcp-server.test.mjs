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
  const listed = await rpc("tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["execute_capability"]);
  assert.equal("result" in listed.result.tools[0], false);
  const invoked = await rpc("tools/call", { name: "execute_capability", arguments: { target: "desktop" } });
  assert.equal(invoked.result.content[0].text, "queued");
  const log = await (await fetch(`${origin}/requests`)).json();
  assert.deepEqual(log.requests.flatMap((entry) => entry.toolCalls ?? []).map(({ name, args }) => ({ name, args })), [
    { name: "execute_capability", args: { target: "desktop" } },
  ]);

  const failedResponse = await fetch(`${origin}/admin/agent-workloads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), { error: "internal_server_error" });
  await waitFor(() => stderr.includes("[mock-oauth-mcp] request failed"));
});
