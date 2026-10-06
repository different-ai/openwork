import { createServer } from "node:http";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionResponse, inventoryResponse, tokenResponse, requireOwnedDen } from "./member-api-key-fixture";

const test = spec.world(async (seed) => {
  requireOwnedDen();
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    if (!rpc?.id && rpc?.id !== 0) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Auth fixture", version: "1" } };
    else if (rpc.method === "tools/list") result = { tools: [{ name: "identity_probe", description: "Fixture", inputSchema: { type: "object" } }] };
    else if (request.headers.authorization === "Bearer fixture-alice-old") { response.writeHead(401).end(); return; }
    else result = { isError: false, content: [{ type: "text", text: "fixture healthy" }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const den = await seed.den({ web: true, env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "Replace UI fixture", members: { alice: {}, blair: {} } } });
  const created = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: "Private service", url: `http://127.0.0.1:${address.port}/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: true } }) });
  expect(created.response.status).toBe(200);
  const id = connectionResponse.parse(created.body).id;
  const bearers = new Map<string, string>();
  for (const [member, key] of [[den.members.alice, "fixture-alice-old"], [den.members.blair, "fixture-blair"]]) {
    if (typeof member === "string" || typeof key !== "string") throw new Error("Invalid fixture pair");
    const saved = await seed.api(member, `/v1/mcp-connections/${id}/my-credential`, { method: "PUT", body: JSON.stringify({ apiKey: key }) });
    expect(saved.response.status).toBe(200);
    const minted = await seed.api(member, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    expect(minted.response.status).toBe(200);
    bearers.set(member.email, tokenResponse.parse(minted.body).token);
  }
  const invoke = async (member: typeof den.admin) => {
    const bearer = bearers.get(member.email);
    if (!bearer) throw new Error("Missing owned MCP token");
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: `mcp:${id}:identity_probe`, body: {} } } }), signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const line = raw.split("\n").find(entry => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : raw);
  };
  expect((await invoke(den.members.alice)).result.isError).toBe(true);
  const web = await seed.web({ den, signedInAs: den.members.alice, startPath: "/dashboard/your-connections", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, id, web, invoke, [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { fixture.closeAllConnections(); fixture.close(error => error ? reject(error) : resolve()); }) };
}, {
  timeout: 240_000,
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("caller auth rejection exposes Web Replace and successful replacement leaves other member unchanged", async ({ world, user, probe, evidence }) => {
  const person = user.on(world.web);
  await person.see({ role: "button", label: "Replace key" }, { timeoutMs: 30_000 });
  await person.screenshot();
  await person.click({ role: "button", label: "Replace key" });
  await person.see({ role: "heading", label: "Replace key for Private service" });
  await person.type({ label: "Private service key" }, "fixture-alice-new", { sensitive: true });
  await person.click({ role: "button", label: "Save key" });
  await person.see({ role: "heading", label: "Private service: key saved" }, { timeoutMs: 30_000 });
  await person.screenshot();
  await person.click({ role: "button", label: "Done" });
  await person.see({ role: "button", label: "Replace key" });
  expect((await world.invoke(world.den.members.alice)).result.isError).not.toBe(true);
  expect((await world.invoke(world.den.members.blair)).result.isError).not.toBe(true);
  const rows = await probe.api(world.den.members.blair, "/v1/mcp-connections?scope=usable");
  expect(inventoryResponse.parse(rows.body).connections.find(row => row.id === world.id)).toMatchObject({ needsReconnect: false, connectedForMe: true });
  evidence.recordAssertionEvidence("Actual isolated Web replacement flow after transport rejection", "The real Den and Chrome showed the rejected caller's Replace key button, masked replacement dialog and Key saved acknowledgement. Alice's next actual tool call worked and Blair remained connected. Fixture seeding occurred only in the world. No real external provider acceptance or screenshot judgment is claimed.", true);
});
