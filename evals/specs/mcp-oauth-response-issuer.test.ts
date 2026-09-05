import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { mcpMock, needs, server, test } from "@openwork/testkit";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

// This callback journey was missing from the boundary lane: previous coverage
// used providers that never advertised RFC 9207 response issuer support.
test("local MCP sign-in preserves the response issuer and rejects mix-ups before exchanging a code", { timeout: 120_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  const root = await mkdtemp(join(tmpdir(), "openwork-oauth-issuer-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const { handle: provider } = await mcpMock({ authorizationResponseIssuerSupported: true }).boot(place);
  const token = "synthetic-local-oauth-client";
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const server = bootServer({
    ...inherited,
    XDG_CONFIG_HOME: join(root, "config"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_ALLOW_PRIVATE_MCP_URLS: "1",
    OPENWORK_ENCRYPTION_KEY: "synthetic-oauth-vault-key",
  }, token, workspace, () => {});
  try {
    const base = await server.listening;
    const request = (path: string, body?: unknown) => fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const workspaces: unknown = await (await request("/workspaces")).json();
    if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Workspace missing");
    const path = `/workspace/${workspaces.items[0].id}/mcp`;
    const tokenRequests = async () => (await provider.requests()).filter((entry) => entry.path === "/token").length;
    for (const mode of ["mismatch", "missing", "empty", "state", "valid"]) {
      const name = `issuer-${mode}`;
      const added = await request(`${path}/managed`, { name, url: provider.mcpUrl });
      const result: unknown = await added.json();
      expect(added.status, JSON.stringify(result)).toBe(201);
      if (!isRecord(result) || typeof result.authorizeUrl !== "string") throw new Error("Authorization URL missing");
      const authorize = new URL(result.authorizeUrl);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
      const redirect = await fetch(authorize, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      const callback = new URL(redirect.headers.get("location")!);
      expect(callback.searchParams.get("iss")).toBe(provider.url);
      if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
      if (mode === "missing") callback.searchParams.delete("iss");
      if (mode === "empty") callback.searchParams.set("iss", "");
      if (mode === "state") callback.searchParams.set("state", "invalid-state");
      const before = await tokenRequests();
      const completed = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
      const html = await completed.text();
      const connection: unknown = await (await request(`${path}/${name}/managed`)).json();
      if (mode !== "valid") {
        expect(completed.ok, html).toBe(false);
        expect(await tokenRequests()).toBe(before);
        expect(connection).not.toMatchObject({ status: "connected" });
        evidence.recordAssertionEvidence(`Reject ${mode} callback before token exchange`, `HTTP ${completed.status}; zero token requests; connection is not connected.`, true);
      } else {
        expect(completed.status, html).toBe(200);
        expect(html).toContain("Connected");
        expect(connection).toMatchObject({ status: "connected" });
        expect(await tokenRequests()).toBe(before + 1);
        evidence.recordAssertionEvidence("Valid issuer completes sign-in with PKCE", "Provider required S256 and accepted exactly one code exchange; callback returned Connected and the server reports connected.", true);
        const replay = await fetch(callback, { signal: AbortSignal.timeout(20_000) });
        expect(replay.ok).toBe(false);
        expect(await tokenRequests()).toBe(before + 1);
        evidence.recordAssertionEvidence("A consumed authorization cannot be replayed", "Replay rejected without a second token exchange.", true);
      }
    }
  } finally {
    await stopChild(server.child);
    await provider.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Den forwards a valid response issuer and rejects a mismatch before the token endpoint", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    mocks: { connector: mcpMock({ authorizationResponseIssuerSupported: true }) },
    org: { name: `OAuth Issuer ${Date.now()}`, members: {} },
  });
  const provider = den.mocks.connector;
  const headers = { authorization: `Bearer ${den.admin.token}` };
  for (const mode of ["mismatch", "valid"]) {
    const created = await denFetch(den.admin, "/v1/mcp-connections", {
      method: "POST", headers,
      body: JSON.stringify({ name: `Issuer ${mode}`, url: provider.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } }),
    });
    expect(created.response.status, created.text).toBe(200);
    if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
    const id = created.body.id;
    const started = await denFetch(den.admin, `/v1/mcp-connections/${id}/connect/start`, { headers });
    expect(started.response.status, started.text).toBe(200);
    if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
    const redirect = await fetch(started.body.authorizeUrl, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const callback = new URL(redirect.headers.get("location")!);
    expect(callback.searchParams.get("iss")).toBe(provider.url);
    if (mode === "mismatch") callback.searchParams.set("iss", "https://other-issuer.example.test");
    const before = (await provider.requests()).filter((entry) => entry.path === "/token").length;
    const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const html = await completed.text();
    expect(completed.status, html).toBe(mode === "valid" ? 200 : 400);
    expect((await provider.requests()).filter((entry) => entry.path === "/token").length).toBe(before + (mode === "valid" ? 1 : 0));
    const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers });
    expect(listed.response.status).toBe(200);
    if (!isRecord(listed.body) || !Array.isArray(listed.body.connections)) throw new Error("Connections missing");
    const connection = listed.body.connections.find((entry) => isRecord(entry) && entry.id === id);
    expect(connection).toMatchObject({ connected: mode === "valid" });
    evidence.recordAssertionEvidence(
      `Den ${mode === "valid" ? "completes sign-in with the valid issuer" : "rejects a mismatched issuer before exchange"}`,
      `Callback returned HTTP ${completed.status}; provider observed ${mode === "valid" ? "exactly one" : "zero"} token requests.`, true,
    );
  }
});
