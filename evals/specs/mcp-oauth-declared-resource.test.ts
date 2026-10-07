import { expect } from "vitest";
import { allocateFreePorts, denFetch, mcpMock, needs, server, test } from "@openwork/testkit";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Some providers front a regional MCP host with a global one, so the protected
// resource they declare is on a different host than the URL an administrator
// configures. The mock declares localhost while Den is configured with
// 127.0.0.1, which reproduces that shape without external hosts.
test("Den OAuth connects when the MCP server declares its resource on another host", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"], placement: "local" });
  const [port] = await allocateFreePorts(1);
  const declaredOrigin = `http://localhost:${port}`;
  await using den = await server({
    place, web: false,
    mocks: { connector: mcpMock({ port, issuer: declaredOrigin }) },
    org: { name: `OAuth Declared Resource ${Date.now()}`, members: {} },
  });
  const provider = den.mocks.connector;
  expect(new URL(provider.mcpUrl).origin).not.toBe(declaredOrigin);
  const headers = { authorization: `Bearer ${den.admin.token}` };

  const created = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Declared resource", url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBe(200);
  if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
  const id = created.body.id;

  const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
  expect(started.response.status, started.text).toBe(200);
  if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
  const authorize = new URL(started.body.authorizeUrl);
  expect(authorize.origin).toBe(declaredOrigin);
  expect(authorize.searchParams.get("resource")).toBe(`${declaredOrigin}/mcp`);
  evidence.recordAssertionEvidence("Sign-in starts for a resource declared on another host", `Configured ${provider.mcpUrl}; authorization requested resource ${authorize.searchParams.get("resource")}.`, true);

  const redirect = await fetch(authorize, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  const completed = await fetch(redirect.headers.get("location")!, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  expect(completed.status, await completed.text()).toBe(200);

  const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
  expect(listed.response.status).toBe(200);
  if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
  expect(listed.body.connections.find((entry) => isRecord(entry) && entry.id === id)).toMatchObject({ connected: true });
  const tools = await denFetch(den.admin, `/v1/mcp-connections/${id}/tools`, { headers });
  expect(tools.response.status, tools.text).toBe(200);
  evidence.recordAssertionEvidence("Connection completes and lists tools", "Callback returned HTTP 200, Den reports the connection connected, and authenticated tool discovery succeeded.", true);
});
