import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect } from "vitest";
import { test, server, mcpMock } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { connectionResponse, tokenResponse, requireOwnedDen } from "./member-api-key-fixture";

test("Den validates personal key values and redacts provider failures across real MCP requests", { timeout: 180_000 }, async ({ place, evidence }) => {
  requireOwnedDen();
  await using den = await server({ place, org: { name: "Personal key value boundary", members: { alice: {} } },
    mocks: { keyed: mcpMock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{ name: "value_probe", description: "Synthetic key boundary probe", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "synthetic response" }] } }] }) } });
  const alice = den.members.alice;
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const wire: { scheme: string; fingerprint: string; method: string }[] = [];
  let providerError: string | undefined;
  let observedErrors = 0;
  let redirectStatus = 0;
  let targetRequests = 0;
  const witness = createServer(async (request, response) => {
    if (request.url === "/target") targetRequests += 1;
    const auth = /^(Bearer|Token) ([\x21-\x7e]+)$/.exec(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : {};
    wire.push({ scheme: auth?.[1] ?? "", fingerprint: fingerprint(auth?.[2] ?? ""), method: rpc.method ?? request.method });
    if (redirectStatus && request.url !== "/target") {
      response.writeHead(redirectStatus, { location: "/target" }); response.end(); return;
    }
    if (providerError && rpc.method === "tools/call") {
      observedErrors += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: providerError }] } }));
      return;
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
  await using ownedWitness = { [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => { witness.closeAllConnections(); witness.close(error => error ? reject(error) : resolve()); }) };
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Missing owned provider witness");
  const api = (member: typeof alice, path: string, body: unknown, method = "POST") => denFetch(member, path, { method, headers: { authorization: `Bearer ${member.token}` }, body: JSON.stringify(body) });
  const minted = await api(alice, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] });
  expect(minted.response.status).toBe(200);
  const bearer = tokenResponse.parse(minted.body).token;
  const invoke = async (id: string) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: `mcp:${id}:value_probe`, body: {} } } }), signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const text = await response.text();
    const line = text.split("\n").find(entry => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text);
  };
  const strings = (value: unknown): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  let diagnostics = 0;
  for (const scheme of ["bearer", "token"]) {
    const created = await api(den.admin, "/v1/mcp-connections", { name: `Value boundary ${scheme}`, url: `http://127.0.0.1:${address.port}/mcp`, authType: "apikey", credentialMode: "per_member", apiKeyAuthScheme: scheme, access: { orgWide: true } });
    expect(created.response.status).toBe(200);
    const id = connectionResponse.parse(created.body).id;
    const endpoint = `/v1/mcp-connections/${id}/my-credential`;
    for (const apiKey of ["", "Bearer synthetic", "Token synthetic", "x\r\ny:z", "x\0", "x\t", "x ", "é", "x".repeat(8193)]) {
      const before = wire.length;
      expect((await api(alice, endpoint, { apiKey }, "PUT")).response.status).toBe(400);
      expect(wire).toHaveLength(before);
    }
    const bounded = "x".repeat(8192);
    expect((await api(alice, endpoint, { apiKey: bounded }, "PUT")).response.status).toBe(200);
    const before = wire.length;
    expect((await invoke(id)).result.isError).not.toBe(true);
    expect(wire.slice(before).some(entry => entry.method === "tools/call" && entry.scheme === (scheme === "bearer" ? "Bearer" : "Token") && entry.fingerprint === fingerprint(bounded))).toBe(true);
    for (const prefix of ["Bearer", "Token", "tOkEn"]) {
      for (const key of ["q", "abc1234", "a:!\"%&'()*+,./;<=>?@[\\]^_`{|}~", "synthetic-bearer-control"]) {
        expect((await api(alice, endpoint, { apiKey: key }, "PUT")).response.status).toBe(200);
        for (const text of [`403 forbidden ${prefix} ${key}`, `403 forbidden Authorization: ${prefix} ${key}`, `403 forbidden ${JSON.stringify({ authorization: `${prefix} ${key}` })}`]) {
          providerError = text;
          const result = await invoke(id);
          expect(result.result.isError).toBe(true);
          const log = await den.apiLog();
          const logValues = log.split("\n").flatMap(line => {
            try { return strings(JSON.parse(line)); } catch { return [line]; }
          });
          const projections = [...strings(result), ...logValues];
          expect(projections.some(value => value.includes(`${prefix} ${key}`))).toBe(false);
          diagnostics += 1;
        }
      }
    }
    providerError = undefined;
    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status;
      expect((await api(alice, endpoint, { apiKey: `synthetic-redirect-${status}` }, "PUT")).response.status).toBe(200);
      expect((await invoke(id)).result.isError).toBe(true);
      expect(targetRequests).toBe(0);
    }
    redirectStatus = 0;
  }
  expect(observedErrors).toBe(72);
  expect(diagnostics).toBe(observedErrors);
  evidence.recordAssertionEvidence("Raw personal keys are bounded at the real enrollment endpoint", "Both transports reject9 malformed candidates without provider traffic and accept8192-byte raw keys observed by exact fingerprint at the provider.", true);
  evidence.recordAssertionEvidence("Actual provider errors cannot return scheme-prefixed credentials", `${diagnostics} gateway tool-error responses and real API log observations omit the rejected credential expressions across both transports, mixed-case prefixes, short keys and punctuation. No product internals were imported.`, diagnostics === 72);
  evidence.recordAssertionEvidence("Personal requests refuse redirects at the actual provider boundary", "All five redirect statuses fail through both transports with zero target requests. Ordinary shared and OAuth policy remain covered by the separate isolation journey, not asserted here.", targetRequests === 0);
});
