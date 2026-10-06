import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect } from "vitest";
import { test, server, mcpMock } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { connectionResponse, inventoryResponse, tokenResponse, organizationResponse, requireOwnedDen } from "./member-api-key-fixture";

// Drives the two in-flight error paths of a personal-key request: the key is replaced or
// rejected while one of the member's requests is held at the provider. Each must stop the
// operation without another provider request and without disclosing the key.
test("in-flight key replacement and rejection stop the request without disclosing the key", { timeout: 180_000 }, async ({ place, evidence }) => {
  requireOwnedDen();
  await using den = await server({ place, org: { name: "Personal key error paths fixture", members: { bob: {} } },
    mocks: { keyed: mcpMock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{ name: "identity_probe", description: "Synthetic member key probe", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "synthetic provider response" }] } }] }) } });
  const bob = den.members.bob;
  const api = (member: typeof bob, path: string, body?: unknown, method = "POST") => denFetch(member, path, { method, headers: { authorization: `Bearer ${member.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const keyFirst = "synthetic-errpath-first";
  const keyNext = "synthetic-errpath-next";
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const accepted = new Set([keyFirst, keyNext]);
  const wire: { method: string; fingerprint: string }[] = [];
  let hold: { key: string; arrived: () => void; release: Promise<void> } | undefined;
  let rejectOnce: string | undefined;
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : {};
    const key = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    wire.push({ method: rpc.method ?? request.method, fingerprint: fingerprint(key) });
    if (hold && key === hold.key) {
      const held = hold;
      hold = undefined;
      held.arrived();
      await held.release;
    }
    if (rejectOnce === key || !accepted.has(key)) {
      if (rejectOnce === key) rejectOnce = undefined;
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "invalid_credential" })); return;
    }
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      const upstream = await fetch(den.mocks.keyed.mcpUrl, { method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  await using ownedWitness = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { witness.closeAllConnections(); witness.close((error) => error ? reject(error) : resolve()); }) };
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Missing owned witness address");
  const members = organizationResponse.parse((await api(den.admin, "/v1/org", undefined, "GET")).body).members;
  const bobId = members.find(entry => entry.user.email === bob.email)?.id;
  if (!bobId) throw new Error("Owned member absent from organization");
  const created = await api(den.admin, "/v1/mcp-connections", { name: "Error path fixture", url: `http://127.0.0.1:${address.port}/mcp`, authType: "apikey", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: false, memberIds: [bobId] } });
  expect(created.response.status).toBe(200);
  const id = connectionResponse.parse(created.body).id;
  const endpoint = `/v1/mcp-connections/${id}/my-credential`;
  const minted = await api(bob, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] });
  expect(minted.response.status).toBe(200);
  const bearer = tokenResponse.parse(minted.body).token;
  const call = async () => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: `mcp:${id}:identity_probe`, body: {} } } }), signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("data:"));
    return { text, rpc: JSON.parse(line ? line.slice(5) : text) };
  };
  const holdNext = (key: string) => {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hold = { key, arrived: arrived.resolve, release: release.promise };
    return { release: release.resolve, arrived: Promise.race([arrived.promise, new Promise<never>((_, reject) => {
      AbortSignal.timeout(10_000).addEventListener("abort", () => reject(new Error("Timed out waiting for the owned held request")), { once: true });
    })]) };
  };
  const bobConnection = async () => connectionResponse.parse(inventoryResponse.parse((await api(bob, "/v1/mcp-connections", undefined, "GET")).body).connections.find((entry) => entry.id === id));

  expect((await api(bob, endpoint, { apiKey: keyFirst }, "PUT")).body).toEqual({ ok: true });
  expect((await call()).rpc.result.isError).not.toBe(true);
  expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint(keyFirst));

  // Path 1: destination/credential guard. The key changes while a request is held, so the
  // next request of the same operation no longer matches the stored key.
  const guard = holdNext(keyFirst);
  const guarded = call();
  await guard.arrived;
  expect((await api(bob, endpoint, { apiKey: keyNext }, "PUT")).response.status).toBe(200);
  const afterGuardRelease = wire.length;
  guard.release();
  const guardResult = await guarded;
  expect(guardResult.rpc.result.isError).toBe(true);
  expect(wire).toHaveLength(afterGuardRelease);
  for (const key of [keyFirst, keyNext]) expect(guardResult.text.includes(key)).toBe(false);
  expect((await call()).rpc.result.isError).not.toBe(true);
  expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint(keyNext));

  // Path 2: "Connect your personal API key". A concurrent provider 401 marks the key while
  // another request is held; the held operation must stop at its next request.
  const pending = holdNext(keyNext);
  const stale = call();
  await pending.arrived;
  rejectOnce = keyNext;
  const rejected = await call();
  expect(rejected.rpc.result.isError).toBe(true);
  for (const key of [keyFirst, keyNext]) expect(rejected.text.includes(key)).toBe(false);
  // Independent M2 check: the provider 401 must leave the key reading as needing replacement.
  expect(await bobConnection()).toMatchObject({ credentialHealth: "reconnect_required", needsReconnect: true });
  const afterRejectRelease = wire.length;
  pending.release();
  const staleResult = await stale;
  expect(staleResult.rpc.result.isError).toBe(true);
  expect(wire).toHaveLength(afterRejectRelease);
  for (const key of [keyFirst, keyNext]) expect(staleResult.text.includes(key)).toBe(false);

  const apiLog = await den.apiLog();
  for (const key of [keyFirst, keyNext]) expect(apiLog.includes(key)).toBe(false);
  evidence.recordAssertionEvidence("In-flight personal-key error paths", "A key replaced while a request was held stopped the operation at the credential guard with no further provider request; a concurrent provider 401 marked the key as needing replacement and stopped the held operation before its next request. Neither the responses nor the actual Den API log contained either synthetic key value.", true);
});
