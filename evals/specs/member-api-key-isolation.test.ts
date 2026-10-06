import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect } from "vitest";
import { test, server, mcpMock } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { connectionResponse, inventoryResponse, tokenResponse, organizationResponse, newOrganizationResponse, apiKeyResponse, teamResponse, requireOwnedDen } from "./member-api-key-fixture";

test("one central personal-key connection routes only the calling member credential", { timeout: 180_000 }, async ({ place, evidence }) => {
  requireOwnedDen();
  await using den = await server({ place, org: { name: "Personal key isolation fixture", members: { alice: {}, bob: {}, charlie: {} } },
    mocks: { keyed: mcpMock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{ name: "identity_probe", description: "Synthetic member key probe", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "synthetic provider response" }] } }] }) } });
  const admin = den.admin;
  const alice = den.members.alice;
  const bob = den.members.bob;
  const charlie = den.members.charlie;
  const api = (member: typeof admin, path: string, body?: unknown, method = "POST") => denFetch(member, path, { method, headers: { authorization: `Bearer ${member.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const accepted = new Set(["synthetic-member-alice", "synthetic-member-bob", "synthetic-replacement"]);
  const wire: { method: string; fingerprint: string; accepted: boolean }[] = [];
  let held401: { arrived: () => void; release: Promise<void> } | undefined;
  let redirectTargetRequests = 0;
  let crossOriginRedirect = "";
  let crossOriginTargetRequests = 0;
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : {};
    const key = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const permitted = accepted.has(key);
    wire.push({ method: rpc.method ?? request.method, fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 12), accepted: permitted });
    if (request.url?.startsWith("/redirect/")) { response.writeHead(Number(request.url.split("/")[2]), { location: "/forbidden-target" }); response.end(); return; }
    if (request.url?.startsWith("/redirect-cross/")) { response.writeHead(Number(request.url.split("/")[2]), { location: crossOriginRedirect }); response.end(); return; }
    if (request.url === "/forbidden-target") { redirectTargetRequests += 1; response.writeHead(400); response.end(); return; }
    if (held401 && key === "synthetic-member-bob") {
      const held = held401;
      held401 = undefined;
      held.arrived();
      await held.release;
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "invalid_credential" })); return;
    }
    if (!permitted) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "invalid_credential" })); return; }
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
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const redirectTarget = createServer((_request, response) => { crossOriginTargetRequests += 1; response.writeHead(400); response.end(); });
  await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
  await using ownedRedirectTarget = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { redirectTarget.closeAllConnections(); redirectTarget.close((error) => error ? reject(error) : resolve()); }) };
  const targetAddress = redirectTarget.address();
  if (!targetAddress || typeof targetAddress === "string") throw new Error("Missing owned redirect target address");
  crossOriginRedirect = `http://127.0.0.1:${targetAddress.port}/forbidden-target`;
  const org = await api(admin, "/v1/org", undefined, "GET");
  const members = organizationResponse.parse(org.body).members;
  const aliceMember = members.find(entry => entry.user.email === alice.email);
  const bobMember = members.find(entry => entry.user.email === bob.email);
  if (!aliceMember || !bobMember) throw new Error("Owned members absent from organization");
  const aliceId = aliceMember.id;
  const bobId = bobMember.id;
  const created = await api(admin, "/v1/mcp-connections", { name: "Personal fixture", url, authType: "apikey", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: false, memberIds: [aliceId, bobId] } });
  expect(created.response.status).toBe(200);
  const id = connectionResponse.parse(created.body).id;
  const endpoint = `/v1/mcp-connections/${id}/my-credential`;
  const tokenA = "synthetic-member-alice";
  const tokenB = "synthetic-member-bob";
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const minted = new Map<string, string>();
  const invoke = async (member: typeof admin, tool: string, args: unknown, path = "/mcp/agent", expectedStatus = 200) => {
    let bearer = minted.get(member.email);
    if (!bearer) {
      const result = await api(member, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] });
      expect(result.response.status).toBe(200);
      bearer = tokenResponse.parse(result.body).token;
      minted.set(member.email, bearer!);
    }
    const response = await fetch(`${den.ref.apiUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(expectedStatus);
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text);
  };
  const call = (member: typeof admin) => invoke(member, "execute_capability", { name: `mcp:${id}:identity_probe`, body: {} });
  expect((await api(alice, endpoint, { apiKey: tokenA }, "PUT")).body).toEqual({ ok: true });
  expect((await api(charlie, endpoint, { apiKey: "synthetic-charlie" }, "PUT")).response.status).toBe(403);
  expect((await api(admin, endpoint, { apiKey: "synthetic-admin" }, "PUT")).response.status).toBe(403);
  const missing = await call(bob);
  expect(missing.result.isError).toBe(true);
  expect(await den.mocks.keyed.toolCalls()).toHaveLength(0);
  expect(wire).toHaveLength(0);
  const missingSearch = JSON.stringify(await invoke(bob, "search_capabilities", { query: "Personal fixture" }));
  expect(missingSearch).toContain("update_credentials");
  expect(missingSearch).toContain("openwork_your_connections");
  expect(missingSearch).toContain("Never request a key in chat");
  expect(wire).toHaveLength(0);
  expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).body).toEqual({ ok: true });
  if (!den.database || !den.database.name.startsWith("openwork_eval_")) throw new Error("At-rest proof requires this test's owned isolated schema");
  const stored = await queryDenDatabase(den.database.url, "SELECT COUNT(*) AS total, SUM(access_token LIKE 'enc:v1:%') AS encrypted, SUM(access_token IN (?, ?)) AS plaintext FROM connected_account WHERE provider_id = ? AND token_type = 'api_key'", [tokenA, tokenB, id]);
  const atRest = stored[0];
  if (!atRest || typeof atRest !== "object" || !("total" in atRest) || !("encrypted" in atRest) || !("plaintext" in atRest)) throw new Error("Missing at-rest aggregate");
  expect(Number(atRest.total)).toBe(2);
  expect(Number(atRest.encrypted)).toBe(2);
  expect(Number(atRest.plaintext)).toBe(0);
  for (const member of [alice, bob, alice, bob]) {
    const result = await call(member);
    expect(result.error).toBeUndefined();
    expect(result.result.isError).not.toBe(true);
  }
  expect((await den.mocks.keyed.toolCalls()).map((entry) => entry.tokenId)).toEqual([fingerprint(tokenA), fingerprint(tokenB), fingerprint(tokenA), fingerprint(tokenB)]);
  for (const member of [alice, bob]) {
    const beforeSearch = wire.length;
    const discovery = await invoke(member, "search_capabilities", { query: "identity_probe" });
    expect(JSON.stringify(discovery)).toContain(`mcp:${id}:identity_probe`);
    expect(JSON.stringify(discovery)).not.toContain(member === alice ? tokenA : tokenB);
    const listed = wire.slice(beforeSearch).filter((entry) => entry.method === "tools/list");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((entry) => entry.fingerprint === fingerprint(member === alice ? tokenA : tokenB))).toBe(true);
    const direct = await invoke(member, "identity_probe", {}, `/mcp/agent/connections/${id}`);
    expect(direct.error).toBeUndefined();
    expect(direct.result.isError).not.toBe(true);
    expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint(member === alice ? tokenA : tokenB));
  }
  expect((await api(alice, endpoint, { apiKey: "synthetic-replacement", orgMembershipId: "someone-else" }, "PUT")).response.status).toBe(400);
  expect((await api(alice, endpoint, { apiKey: "Token synthetic" }, "PUT")).response.status).toBe(400);
  expect((await api(alice, endpoint, { apiKey: "synthetic-replacement" }, "PUT")).response.status).toBe(200);
  expect((await call(alice)).result.isError).not.toBe(true);
  expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint("synthetic-replacement"));
  expect((await api(alice, `/v1/mcp-connections/${id}/disconnect-my-account`)).response.status).toBe(200);
  const before = (await den.mocks.keyed.toolCalls()).length;
  expect((await call(alice)).result.isError).toBe(true);
  expect((await call(charlie)).result.isError).toBe(true);
  expect(await den.mocks.keyed.toolCalls()).toHaveLength(before);
  for (const member of [alice, charlie]) {
    const beforeDirect = wire.length;
    const denied = await invoke(member, "identity_probe", {}, `/mcp/agent/connections/${id}`, 403);
    expect(Boolean(denied.error || denied.result?.isError)).toBe(true);
    expect(wire).toHaveLength(beforeDirect);
  }
  expect((await call(bob)).result.isError).not.toBe(true);
  // A deterministically delayed rejection of the OLD key may not poison NEW.
  for (const mode of ["different", "same", "recreate"]) {
    expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    held401 = { arrived: arrived.resolve, release: release.promise };
    const oldRequest = call(bob);
    const replacement = mode === "different" ? "synthetic-member-bob-rotated" : tokenB;
    try {
      await Promise.race([arrived.promise, new Promise<never>((_, reject) => {
        AbortSignal.timeout(10_000).addEventListener("abort", () => reject(new Error("Timed out waiting for the owned held request")), { once: true });
      })]);
      accepted.add(replacement);
      if (mode === "recreate") expect((await api(bob, `/v1/mcp-connections/${id}/disconnect-my-account`)).response.status).toBe(200);
      expect((await api(bob, endpoint, { apiKey: replacement }, "PUT")).response.status).toBe(200);
    } finally { release.resolve(); }
    expect((await oldRequest).result.isError).toBe(true);
    expect((await call(bob)).result.isError).not.toBe(true);
    expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint(replacement));
  }
  expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
  accepted.delete(tokenB);
  const rejectedKey = await call(bob);
  expect(rejectedKey.result.isError).toBe(true);
  expect(JSON.stringify(rejectedKey)).toContain("update_credentials");
  expect(JSON.stringify(rejectedKey)).toContain("openwork_your_connections");
  expect(wire.at(-1)?.accepted).toBe(false);
  const afterRejected = wire.length;
  const revokedDirect = await invoke(bob, "identity_probe", {}, `/mcp/agent/connections/${id}`, 403);
  expect(Boolean(revokedDirect.error || revokedDirect.result?.isError)).toBe(true);
  expect(wire).toHaveLength(afterRejected);
  const bobStatus = await api(bob, "/v1/mcp-connections", undefined, "GET");
  expect(inventoryResponse.parse(bobStatus.body).connections.find((entry: { id: string }) => entry.id === id)).toMatchObject({ credentialHealth: "reconnect_required", needsReconnect: true });
  const rejectedDiscovery = await invoke(bob, "search_capabilities", { query: "identity_probe" });
  expect(JSON.stringify(rejectedDiscovery)).not.toContain(`mcp:${id}:identity_probe`);
  expect((await api(bob, endpoint, { apiKey: "synthetic-invalid" }, "PUT")).response.status).toBe(200);
  expect((await call(bob)).result.isError).toBe(true);
  const inventory = await api(admin, "/v1/mcp-connections?scope=manageable", undefined, "GET");
  expect(JSON.stringify(inventory.body)).not.toContain(tokenA);
  expect(JSON.stringify(inventory.body)).not.toContain(tokenB);
  expect(JSON.stringify(inventory.body)).not.toContain("synthetic-replacement");
  expect(JSON.stringify(inventory.body)).not.toContain("synthetic-invalid");
  const updateAccess = async (memberIds: string[]) => {
    const current = await api(admin, "/v1/mcp-connections?scope=manageable", undefined, "GET");
    const row = connectionResponse.parse(inventoryResponse.parse(current.body).connections.find(entry => entry.id === id));
    const result = await api(admin, `/v1/mcp-connections/${id}`, { expectedUpdatedAt: row.updatedAt, name: row.name, url, authType: "apikey", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: false, memberIds } }, "PUT");
    expect(result.response.status).toBe(200);
  };
  accepted.add(tokenB);
  expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
  expect((await call(bob)).result.isError).not.toBe(true);
  expect((await api(alice, endpoint, { apiKey: tokenA }, "PUT")).response.status).toBe(200);
  await updateAccess([aliceId]);
  // Narrowing access prunes only the member who lost it; Alice keeps her key.
  expect((await call(alice)).result.isError).not.toBe(true);
  const beforeRevoked = wire.length;
  expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).response.status).toBe(403);
  expect((await call(bob)).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeRevoked);
  await updateAccess([aliceId, bobId]);
  expect((await call(bob)).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeRevoked);
  expect((await api(bob, endpoint, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
  const current = await api(admin, "/v1/mcp-connections?scope=manageable", undefined, "GET");
  const row = connectionResponse.parse(inventoryResponse.parse(current.body).connections.find(entry => entry.id === id));
  const edited = await api(admin, `/v1/mcp-connections/${id}`, { expectedUpdatedAt: row.updatedAt, name: row.name, url: `${url}?new-destination=1`, authType: "apikey", credentialMode: "per_member", access: { orgWide: false, memberIds: [aliceId, bobId] } }, "PUT");
  expect(edited.response.status).toBe(200);
  expect((await call(bob)).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeRevoked);
  const orgKey = await api(admin, "/v1/api-keys", { name: "Synthetic credential boundary" });
  expect(orgKey.response.status).toBe(201);
  const machineControl = await denFetch(admin, "/v1/api-keys", { headers: { "x-api-key": apiKeyResponse.parse(orgKey.body).key } });
  expect(machineControl.response.status).toBe(200);
  const machineEnroll = await denFetch(admin, endpoint, { method: "PUT", headers: { "x-api-key": apiKeyResponse.parse(orgKey.body).key }, body: JSON.stringify({ apiKey: tokenA }) });
  expect(machineEnroll.response.status).toBe(403);
  const shared = await api(admin, "/v1/mcp-connections", { name: "Shared regression", url, authType: "apikey", credentialMode: "shared", apiKey: tokenA, access: { orgWide: true } });
  expect(shared.response.status).toBe(200);
  for (const member of [alice, bob]) {
    const sharedCall = await invoke(member, "execute_capability", { name: `mcp:${connectionResponse.parse(shared.body).id}:identity_probe`, body: {} });
    expect(sharedCall.result.isError).not.toBe(true);
    expect((await den.mocks.keyed.toolCalls()).at(-1)?.tokenId).toBe(fingerprint(tokenA));
  }
  const migrated = await api(admin, `/v1/mcp-connections/${connectionResponse.parse(shared.body).id}`, { expectedUpdatedAt: connectionResponse.parse(shared.body).updatedAt, name: connectionResponse.parse(shared.body).name, url, authType: "apikey", credentialMode: "per_member", access: { orgWide: true } }, "PUT");
  expect(migrated.response.status).toBe(200);
  const beforeMigrated = wire.length;
  expect((await invoke(bob, "execute_capability", { name: `mcp:${connectionResponse.parse(shared.body).id}:identity_probe`, body: {} })).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeMigrated);
  const team = await api(admin, "/v1/teams", { name: "Personal key team", memberIds: [bobId] });
  expect(team.response.status).toBe(201);
  const teamPath = `/v1/teams/${teamResponse.parse(team.body).team.id}`;
  const teamConnection = await api(admin, "/v1/mcp-connections", { name: "Team key lifecycle", url, authType: "apikey", credentialMode: "per_member", access: { orgWide: false, teamIds: [teamResponse.parse(team.body).team.id] } });
  expect(teamConnection.response.status).toBe(200);
  const teamKeyPath = `/v1/mcp-connections/${connectionResponse.parse(teamConnection.body).id}/my-credential`;
  const teamCall = () => invoke(bob, "execute_capability", { name: `mcp:${connectionResponse.parse(teamConnection.body).id}:identity_probe`, body: {} });
  expect((await api(bob, teamKeyPath, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
  expect((await api(alice, teamPath, { memberIds: [] }, "PATCH")).response.status).toBe(403);
  expect((await teamCall()).result.isError).not.toBe(true);
  expect((await api(admin, teamPath, { memberIds: [bobId] }, "PATCH")).response.status).toBe(200);
  expect((await teamCall()).result.isError).not.toBe(true);
  expect((await api(admin, teamPath, { memberIds: [] }, "PATCH")).response.status).toBe(200);
  const beforeTeamRemoval = wire.length;
  expect((await teamCall()).result.isError).toBe(true);
  expect((await api(admin, teamPath, { memberIds: [bobId] }, "PATCH")).response.status).toBe(200);
  expect((await teamCall()).result.isError).toBe(true);
  expect(wire).toHaveLength(beforeTeamRemoval);
  expect((await api(bob, teamKeyPath, { apiKey: tokenB }, "PUT")).response.status).toBe(200);
  const raced = await Promise.all([
    api(bob, teamKeyPath, { apiKey: tokenB }, "PUT"),
    api(admin, teamPath, { memberIds: [] }, "PATCH"),
  ]);
  expect([200, 403, 409]).toContain(raced[0].response.status);
  expect(raced[1].response.status).toBe(200);
  expect((await api(admin, teamPath, { memberIds: [bobId] }, "PATCH")).response.status).toBe(200);
  expect((await teamCall()).result.isError).toBe(true);
  for (const path of ["redirect", "redirect-cross"].flatMap((origin) => [301, 302, 303, 307, 308].map((status) => `${origin}/${status}`))) {
    const redirectConnection = await api(admin, "/v1/mcp-connections", { name: `Redirect boundary ${path}`, url: `http://127.0.0.1:${address.port}/${path}`, authType: "apikey", credentialMode: "per_member", access: { orgWide: false, memberIds: [aliceId] } });
    expect(redirectConnection.response.status).toBe(200);
    expect((await api(alice, `/v1/mcp-connections/${connectionResponse.parse(redirectConnection.body).id}/my-credential`, { apiKey: tokenA }, "PUT")).response.status).toBe(200);
    const beforeRedirect = wire.length;
    expect((await invoke(alice, "execute_capability", { name: `mcp:${connectionResponse.parse(redirectConnection.body).id}:identity_probe`, body: {} })).result.isError).toBe(true);
    expect(wire.length).toBeGreaterThan(beforeRedirect);
    expect(wire.slice(beforeRedirect).every((entry) => entry.fingerprint === fingerprint(tokenA))).toBe(true);
  }
  expect(redirectTargetRequests).toBe(0);
  expect(crossOriginTargetRequests).toBe(0);
  const otherOrg = await api(charlie, "/v1/org", { name: "Separate personal key tenant" });
  expect(otherOrg.response.status).toBe(201);
  const crossOrg = await denFetch(charlie, endpoint, { method: "PUT", headers: { authorization: `Bearer ${charlie.token}`, "x-openwork-org-id": newOrganizationResponse.parse(otherOrg.body).organization.id }, body: JSON.stringify({ apiKey: tokenA }) });
  expect(crossOrg.response.status).toBe(404);
  const otherToken = await denFetch(charlie, "/v1/mcp/token", { method: "POST", headers: { authorization: `Bearer ${charlie.token}`, "x-openwork-org-id": newOrganizationResponse.parse(otherOrg.body).organization.id }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  expect(otherToken.response.status).toBe(200);
  minted.set(charlie.email, tokenResponse.parse(otherToken.body).token);
  const beforeCrossDirect = wire.length;
  expect((await invoke(charlie, "identity_probe", {}, `/mcp/agent/connections/${id}`, 403)).error).toBe("connection_not_available");
  expect(wire).toHaveLength(beforeCrossDirect);
  const readSecret = await api(alice, endpoint, undefined, "GET");
  expect(readSecret.response.status).toBe(404);
  expect((await api(admin, "/v1/mcp-connections", { name: "No auth rejection", url: den.mocks.keyed.mcpUrl, authType: "none", credentialMode: "per_member", access: { orgWide: true } })).response.status).toBe(400);
  expect((await api(admin, "/v1/mcp-connections", { name: "OAuth control", url: den.mocks.keyed.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } })).response.status).toBe(200);
  const apiLog = await den.apiLog();
  for (const value of [tokenA, tokenB, "synthetic-replacement", "synthetic-invalid", "synthetic-member-bob-rotated"]) expect(apiLog.includes(value)).toBe(false);
  evidence.recordAssertionEvidence("Single connection caller-bound keys", "Actual isolated Den accepted personal API-key mode; Alice/Bob tool and direct calls carried distinct expected synthetic fingerprints, tools/list used the caller fingerprint, missing credentials made zero upstream HTTP requests; ungranted Charlie/admin could not enroll.", true);
  evidence.recordAssertionEvidence("Replacement, revocation and write-only enrollment", "Strict enrollment rejected caller-selected member IDs and header prefixes; rotation/disconnect isolated Alice, provider401 required reconnect with no catalog reuse, access removal/regrant and destination edits cleared keys; API-key principals and cross-org writes denied, GET unavailable, metadata omitted old/current synthetic values. No-auth rejected and OAuth creation accepted (not an OAuth runtime assertion).", true);
  evidence.recordAssertionEvidence("Generation and team mutation isolation", "Deterministically delayed old401 did not poison a different key, same-key replacement or disconnect/recreate. Rejected and identical team edits preserved the key; team removal/regrant and concurrent enroll/removal required new enrollment. Shared API-key runtime retained its explicit shared identity and migration did not copy it into personal storage.", true);
  evidence.recordAssertionEvidence("At-rest and request-log non-disclosure", "Owned test schema aggregates confirmed two member rows with enc:v1 ciphertext and zero plaintext matches; actual Den API log contained none of the five synthetic enrolled/replaced/invalid credential values. No ciphertext or token was emitted as evidence.", true);
  evidence.recordAssertionEvidence("Personal credentials never follow redirects", "Actual enterprise-client operations reached the configured source with Alice's fingerprint then failed on301/302/303/307/308; both changed-path same-origin and different-port cross-origin targets observed zero requests. Local private-network fixture does not claim hosted DNS/SSRF proof.", true);
});
