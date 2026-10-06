import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect } from "vitest";
import { test, server, mcpMock } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { connectionResponse, inventoryResponse, tokenResponse, requireOwnedDen } from "./member-api-key-fixture";

test("admin Bearer and Token schemes preserve member isolation and invalidate changed transport", { timeout: 180_000 }, async ({ place, evidence }) => {
  requireOwnedDen();
  await using den = await server({ place, org: { name: "Typed member key transport", members: { alice: {}, bob: {} } },
    mocks: { keyed: mcpMock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{ name: "scheme_probe", description: "Read-only synthetic transport witness", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "synthetic transport result" }] } }] }) } });
  const alice = den.members.alice;
  const bob = den.members.bob;
  const keys = ["synthetic-scheme-alice", "synthetic-scheme-bob"];
  const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);
  const wire: { scheme: string; identity: string; method: string }[] = [];
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const auth = /^(Bearer|Token) ([\x21-\x7e]+)$/.exec(request.headers.authorization ?? "");
    if (!auth || !keys.includes(auth[2])) { response.writeHead(401); response.end(); return; }
    wire.push({ scheme: auth[1], identity: fingerprint(auth[2]), method: body ? JSON.parse(body).method : request.method ?? "unknown" });
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    try {
      const upstream = await fetch(den.mocks.keyed.mcpUrl, { method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  await using ownedWitness = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { witness.closeAllConnections(); witness.close((error) => error ? reject(error) : resolve()); }) };
  void ownedWitness;
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Missing owned witness address");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const api = (member: typeof den.admin, path: string, body?: unknown, method = "POST") => denFetch(member, path, { method,
    headers: { authorization: `Bearer ${member.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const invoke = async (member: typeof den.admin, id: string, direct = false, discovery = false) => {
    const minted = await api(member, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] });
    expect(minted.response.status).toBe(200);
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent${direct ? `/connections/${id}` : ""}`, { method: "POST",
      headers: { authorization: `Bearer ${tokenResponse.parse(minted.body).token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: discovery
        ? { name: "search_capabilities", arguments: { query: "scheme_probe" } }
        : direct ? { name: "scheme_probe", arguments: {} } : { name: "execute_capability", arguments: { name: `mcp:${id}:scheme_probe`, body: {} } } }),
      signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const text = await response.text(); const line = text.split("\n").find((entry) => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text);
  };
  const current = async (id: string) => {
    const listed = await api(den.admin, "/v1/mcp-connections?scope=manageable", undefined, "GET");
    expect(listed.response.status).toBe(200);
    return connectionResponse.parse(inventoryResponse.parse(listed.body).connections.find(row => row.id === id));
  };
  let tokenConnectionId = "";
  for (const scheme of ["bearer", "token"]) {
    const created = await api(den.admin, "/v1/mcp-connections", { name: `Scheme ${scheme}`, url, authType: "apikey", credentialMode: "per_member", exposeDirectly: true,
      ...(scheme === "token" ? { apiKeyAuthScheme: "token" } : {}), access: { orgWide: true } });
    expect(created.response.status).toBe(200);
    expect(connectionResponse.parse(created.body).apiKeyAuthScheme).toBe(scheme);
    const id = String(connectionResponse.parse(created.body).id);
    if (scheme === "token") tokenConnectionId = id;
    for (const [index, member] of [alice, bob].entries()) {
      const saved = await api(member, `/v1/mcp-connections/${id}/my-credential`, { apiKey: keys[index] }, "PUT");
      expect(saved.response.status).toBe(200); expect(saved.body).toEqual({ ok: true });
      const start = wire.length;
      expect((await invoke(member, id)).result.isError).not.toBe(true);
      expect((await invoke(member, id, true)).result.isError).not.toBe(true);
      const observations = wire.slice(start);
      expect(observations.some((entry) => entry.method === "tools/list")).toBe(true);
      expect(observations.some((entry) => entry.method === "tools/call")).toBe(true);
      expect(observations.every((entry) => entry.scheme === (scheme === "token" ? "Token" : "Bearer") && entry.identity === fingerprint(keys[index]))).toBe(true);
    }
  }
  const row = await current(tokenConnectionId);
  const unchanged = await api(den.admin, `/v1/mcp-connections/${tokenConnectionId}`, { expectedUpdatedAt: row.updatedAt, name: "Renamed token connection", url,
    authType: "apikey", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true } }, "PUT");
  expect(unchanged.response.status).toBe(200);
  expect((await current(tokenConnectionId)).apiKeyAuthScheme).toBe("token");
  const beforePreserved = wire.length;
  expect((await invoke(alice, tokenConnectionId)).result.isError).not.toBe(true);
  expect(wire.slice(beforePreserved).every((entry) => entry.scheme === "Token")).toBe(true);
  const latest = await current(tokenConnectionId);
  const edit = { expectedUpdatedAt: latest.updatedAt, name: latest.name, url, authType: "apikey", credentialMode: "per_member", apiKeyAuthScheme: "bearer", access: { orgWide: true } };
  expect((await api(alice, `/v1/mcp-connections/${tokenConnectionId}`, edit, "PUT")).response.status).toBe(403);
  expect((await api(alice, `/v1/mcp-connections/${tokenConnectionId}/my-credential`, { apiKey: keys[0], apiKeyAuthScheme: "bearer" }, "PUT")).response.status).toBe(400);
  expect((await api(den.admin, `/v1/mcp-connections/${tokenConnectionId}`, edit, "PUT")).response.status).toBe(200);
  expect((await current(tokenConnectionId)).apiKeyAuthScheme).toBe("bearer");
  const beforeMissing = wire.length;
  expect((await invoke(alice, tokenConnectionId)).result.isError).toBe(true);
  expect((await invoke(bob, tokenConnectionId)).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeMissing);
  expect((await api(alice, `/v1/mcp-connections/${tokenConnectionId}/my-credential`, { apiKey: keys[0] }, "PUT")).response.status).toBe(200);
  expect((await invoke(alice, tokenConnectionId)).result.isError).not.toBe(true);
  expect(wire.slice(beforeMissing).every((entry) => entry.scheme === "Bearer")).toBe(true);
  for (const invalid of ["Basic", "Token", "bearer\r\nCookie:x", "x-api-key"]) {
    const rejected = await api(den.admin, "/v1/mcp-connections", { name: "Rejected transport", url, authType: "apikey", credentialMode: "per_member", apiKeyAuthScheme: invalid, access: { orgWide: true } });
    expect(rejected.response.status).toBe(400);
  }
  const shared = await api(den.admin, "/v1/mcp-connections", { name: "Shared Token control", url, authType: "apikey", credentialMode: "shared", apiKeyAuthScheme: "token", apiKey: keys[0], access: { orgWide: true } });
  expect(shared.response.status).toBe(200);
  expect((await invoke(bob, connectionResponse.parse(shared.body).id)).result.isError).not.toBe(true);
  expect(wire.at(-1)?.scheme).toBe("Token");

  if (!den.database?.name.startsWith("openwork_eval_")) throw new Error("Owned isolated schema required");
  expect(await queryDenDatabase(den.database.url, "SELECT COLUMN_DEFAULT AS default_value, IS_NULLABLE AS nullable, COLUMN_TYPE AS column_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_mcp_connection' AND COLUMN_NAME = 'api_key_auth_scheme'"))
    .toEqual([{ default_value: "bearer", nullable: "NO", column_type: "enum('bearer','token')" }]);
  evidence.recordAssertionEvidence("Admin-selected scheme controls actual enterprise member transport", "The real Den enterprise client emitted exact Bearer or Token Authorization for both members' distinct key fingerprints during catalog initialization and gateway/direct tool calls. Shared Token retained its explicit shared identity; stored-only enrollment remained exactly200{ok:true}.", true);
  evidence.recordAssertionEvidence("Scheme mutation is an identity change, not a member-controlled prefix", "Omitted update preserved existing Token and live credential; member admin-edit/extra enrollment scheme denied; unsupported/control-character/header-name values rejected; changing scheme cleared both member credentials before further upstream calls. The live isolated Den database exposes a non-null Bearer-default enum column. Migration replay is separately scoped, not inferred from repository SQL.", true);
});
