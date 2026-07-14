import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { ConnectLocalVault } from "./connect-local-vault.js";
import { ConnectLocalStore } from "./connect-local-store.js";
import { serve, type ServeResult } from "./serve-node.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const servers: ServeResult[] = [];
const originalVaultKey = process.env.OPENWORK_CONNECT_VAULT_KEY;

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (originalVaultKey === undefined) delete process.env.OPENWORK_CONNECT_VAULT_KEY;
  else process.env.OPENWORK_CONNECT_VAULT_KEY = originalVaultKey;
});

async function startRemoteMcp(): Promise<string> {
  const remote = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const mcp = new McpServer({ name: "local-connect-remote", version: "1.0.0" });
      mcp.registerTool("search_docs", {
        description: "Search project documents",
        inputSchema: z.object({ query: z.string() }),
      }, async ({ query }) => ({ content: [{ type: "text", text: `result:${query}` }] }));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await mcp.close();
      }
    },
  });
  servers.push(remote);
  return `http://127.0.0.1:${remote.port}/mcp`;
}

async function startOpenwork(): Promise<{ base: string; config: ServerConfig }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-e2e-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "connect-client-token",
    hostToken: "connect-host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
  };
  const server = await startServer(config);
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, config };
}

function headers(): Record<string, string> {
  return {
    Authorization: "Bearer connect-client-token",
    "X-OpenWork-Host-Token": "connect-host-token",
    "Content-Type": "application/json",
  };
}

function firstTextContent(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) return "";
  const first = result.content[0];
  if (typeof first !== "object" || first === null || !("type" in first) || first.type !== "text") return "";
  return "text" in first && typeof first.text === "string" ? first.text : "";
}

test("Local Connect manages a remote MCP and exposes the package-owned two-tool facade", async () => {
  process.env.OPENWORK_CONNECT_VAULT_KEY = randomBytes(32).toString("base64url");
  const remoteUrl = await startRemoteMcp();
  const openwork = await startOpenwork();

  const deniedCreate = await fetch(`${openwork.base}/v1/connect/connections`, {
    method: "POST",
    headers: {
      Authorization: "Bearer connect-client-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Denied", serverUrl: remoteUrl, authType: "none", allowPrivateNetwork: true }),
  });
  expect(deniedCreate.status).toBe(401);

  const createResponse = await fetch(`${openwork.base}/v1/connect/connections`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: "Project Docs",
      serverUrl: remoteUrl,
      authType: "api-key",
      allowPrivateNetwork: true,
      apiKey: "local-api-secret",
    }),
  });
  expect(createResponse.status).toBe(201);
  const connection = await createResponse.json() as { id: string; status: string };
  expect(JSON.stringify(connection)).not.toContain("local-api-secret");

  const connectResponse = await fetch(`${openwork.base}/v1/connect/connections/${connection.id}/connect`, {
    method: "POST",
    headers: headers(),
  });
  expect(connectResponse.status).toBe(200);
  expect(await connectResponse.json()).toMatchObject({ status: "connected" });

  const profileResponse = await fetch(`${openwork.base}/v1/connect/profile`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ mode: "local" }),
  });
  expect(profileResponse.status).toBe(200);
  expect(await profileResponse.json()).toMatchObject({
    profile: { mode: "local", localAvailable: true, connectionCount: 1, connectedCount: 1 },
  });

  const vault = new ConnectLocalVault();
  const token = vault.agentToken(new ConnectLocalStore(openwork.config, vault).agentRevision());
  const transport = new StreamableHTTPClientTransport(new URL(`${openwork.base}/mcp/agent`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "local-connect-e2e", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["execute_capability", "search_capabilities"]);

  const search = await client.callTool({
    name: "search_capabilities",
    arguments: { query: "search project docs" },
  });
  const searchPayload = JSON.parse(firstTextContent(search) || "{}") as {
    matches?: Array<{ name: string }>;
  };
  const capability = searchPayload.matches?.[0]?.name;
  expect(capability).toBe(`mcp:${connection.id}:search_docs`);

  const execution = await client.callTool({
    name: "execute_capability",
    arguments: { name: capability, body: { query: "roadmap" } },
  });
  expect(firstTextContent(execution)).toBe("result:roadmap");
  await client.close();

  for (const mode of ["hosted", "local"]) {
    const response = await fetch(`${openwork.base}/v1/connect/profile`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ mode }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: { mode, connectionCount: 1 } });
  }

  const revokedAgent = await fetch(`${openwork.base}/mcp/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  expect(revokedAgent.status).toBe(401);
});
