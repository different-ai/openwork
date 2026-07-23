import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readMcpSkillIndex,
  readOpenWorkConnectSkillCatalog,
  renderOpenWorkConnectSkillInstruction,
  resetOpenWorkConnectSkillCatalogCacheForTests,
} from "./connect-skill-catalog.js";
import { readConnectCloudMcp, writeConnectCloudMcp } from "./connect-state.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  resetOpenWorkConnectSkillCatalogCacheForTests();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

function skillIndexFetcher(capability = "skill:skill_customer_briefing"): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } },
        { headers: { "mcp-session-id": "catalog-session" } },
      );
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: "skill://index.json",
          mimeType: "application/json",
          text: JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [{
              name: "customer-briefing",
              type: "skill-md",
              description: "Prepare customer briefings.",
              url: "skill://customer-briefing/SKILL.md",
              capability,
            }],
          }),
        }],
      },
    });
  };
}

async function serverConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-skills-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = {
    id: "ws_legacy",
    name: "Legacy",
    path: root,
    preset: "starter",
    workspaceType: "local" as const,
  };
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "openwork.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("OpenWork Connect skill catalog", () => {
  test("renders bounded discovery metadata and capability retrieval guidance", () => {
    const instruction = renderOpenWorkConnectSkillInstruction([{
      name: "customer-briefing",
      type: "skill-md",
      description: "Use for accounts & renewals <before calls>",
      url: "skill://customer-briefing/SKILL.md",
      capability: "skill:skill_customer_briefing",
    }]);

    expect(instruction).toContain("<available_skills>");
    expect(instruction).toContain("<name>customer-briefing</name>");
    expect(instruction).toContain("Use for accounts &amp; renewals &lt;before calls&gt;");
    expect(instruction).toContain("<location>skill://customer-briefing/SKILL.md</location>");
    expect(instruction).toContain("<capability>skill:skill_customer_briefing</capability>");
    expect(instruction).toContain("openwork-cloud_execute_capability");
    expect(instruction).toContain("NEVER use the native Load Skill tool");
    expect(instruction).toContain("exact value from that skill's <capability> field");
    expect(instruction).toContain("Do not call openwork-cloud_search_capabilities first");
    expect(instruction).not.toContain("# Customer Briefing");
  });

  test("omits the prompt block when no authorized skills exist", () => {
    expect(renderOpenWorkConnectSkillInstruction([])).toBe("");
  });

  test("reports why the prompt block was omitted through the diagnostics collector", () => {
    const reasons: string[] = [];
    expect(renderOpenWorkConnectSkillInstruction([], (message) => reasons.push(message))).toBe("");
    expect(reasons.some((message) => message.includes("skill catalog is empty"))).toBe(true);
  });

  test("reports skip reasons for unusable cloud MCP configs", async () => {
    const reasons: string[] = [];
    const never = async () => Response.json({});
    const invalidUrl = "not-a-url?token=url-secret#fragment-secret";
    expect(await readMcpSkillIndex({ url: invalidUrl }, never, (message) => reasons.push(message))).toBeNull();
    expect(reasons.some((message) => message.includes("reason=invalid-url"))).toBe(true);
    expect(reasons.join("\n")).not.toContain(invalidUrl);
    expect(reasons.join("\n")).not.toContain("url-secret");

    reasons.length = 0;
    expect(await readMcpSkillIndex({ url: "https://example.com/mcp", enabled: false }, never, (message) => reasons.push(message))).toBeNull();
    expect(reasons.some((message) => message.includes("disabled"))).toBe(true);
  });

  test("rejects a declared oversized MCP response before buffering it", async () => {
    const fetcher = async () => new Response("{}", {
      headers: { "content-length": String(600 * 1024) },
    });
    await expect(readMcpSkillIndex(
      { url: "https://connect.example/mcp/agent" },
      fetcher,
    )).rejects.toThrow("connect_skill_catalog_response_too_large");
  });

  test("cancels and rejects a streaming oversized MCP response", async () => {
    const chunk = new Uint8Array(300 * 1024);
    const fetcher = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }));
    await expect(readMcpSkillIndex(
      { url: "https://connect.example/mcp/agent" },
      fetcher,
    )).rejects.toThrow("connect_skill_catalog_response_too_large");
  });

  test("reports an invalid skill index instead of silently dropping it", async () => {
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      if (body.method === "resources/read") {
        return Response.json({
          jsonrpc: "2.0",
          id: 2,
          result: { contents: [{ uri: "skill://index.json", text: JSON.stringify({ $schema: "https://wrong.example/schema.json", skills: [] }) }] },
        });
      }
      return Response.json({});
    };
    const reasons: string[] = [];
    expect(await readMcpSkillIndex({ url: "https://example.com/mcp" }, fetcher, (message) => reasons.push(message))).toBeNull();
    expect(reasons.some((message) => message.includes("reason=invalid-schema"))).toBe(true);
    expect(reasons.join("\n")).not.toContain("wrong.example");
  });

  test("reports the failing JSON-RPC phase and code without copying the server message", async () => {
    const reasons: string[] = [];
    const fetcher = async () => Response.json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "private auth token and endpoint" },
    });

    expect(await readMcpSkillIndex(
      { url: "https://connect.example/mcp" },
      fetcher,
      (message) => reasons.push(message),
    )).toBeNull();
    expect(reasons.join("\n")).toContain("phase=initialize");
    expect(reasons.join("\n")).toContain("jsonRpcCode=-32001");
    expect(reasons.join("\n")).not.toContain("private auth token");
  });

  test("reads the standards-shaped index through an authenticated MCP resource", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> | null; headers: Headers }> = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ method, body, headers: new Headers(init?.headers) });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (!body) throw new Error("Expected MCP POST body");
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {} } }, {
          headers: { "mcp-session-id": "session-1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          contents: [{
            uri: "skill://index.json",
            mimeType: "application/json",
            text: JSON.stringify({
              $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
              skills: [{
                name: "customer-briefing",
                type: "skill-md",
                description: "Prepare customer briefings.",
                url: "skill://customer-briefing/SKILL.md",
                capability: "skill:skill_customer_briefing",
              }],
            }),
          }],
        },
      });
    };

    const skills = await readMcpSkillIndex({
      type: "remote",
      url: "https://connect.example/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer secret" },
    }, fetcher);

    expect(skills).toHaveLength(1);
    expect(skills?.[0]?.capability).toBe("skill:skill_customer_briefing");
    expect(requests.map((request) => request.body?.method ?? request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
      "DELETE",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-1");
    expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(requests[3]?.headers.get("mcp-session-id")).toBe("session-1");
  });

  test("ignores SSE notifications until the matching JSON-RPC response arrives", async () => {
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return new Response([
          "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}",
          "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{}}}",
          "",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response([
        "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/resources/list_changed\"}",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            contents: [{
              uri: "skill://index.json",
              text: JSON.stringify({
                $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                skills: [{
                  name: "sse-skill",
                  type: "skill-md",
                  description: "SSE skill",
                  url: "skill://sse-skill/SKILL.md",
                  capability: "skill:sse_skill",
                }],
              }),
            }],
          },
        })}`,
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    };

    const skills = await readMcpSkillIndex({ url: "https://connect.example/mcp" }, fetcher);
    expect(skills?.[0]?.name).toBe("sse-skill");
  });

  test("accepts marketplace plugin capability pointers for remote skill retrieval", async () => {
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          contents: [{
            uri: "skill://index.json",
            mimeType: "application/json",
            text: JSON.stringify({
              $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
              skills: [{
                name: "test-me-a1b2c3d4",
                type: "skill-md",
                description: "Use when the user asks to test the skill.",
                url: "skill://test-me-a1b2c3d4/SKILL.md",
                capability: "plugin:plg_test:cfg_test",
              }],
            }),
          }],
        },
      });
    };

    const skills = await readMcpSkillIndex({
      type: "remote",
      url: "https://connect.example/mcp/agent",
      enabled: true,
    }, fetcher);

    expect(skills).toHaveLength(1);
    expect(skills?.[0]?.capability).toBe("plugin:plg_test:cfg_test");
  });

  test("reads the skill catalog from server-scoped Connect MCP config", async () => {
    const config = await serverConfig();
    const databasePath = process.env.OPENWORK_RUNTIME_DB;
    if (!databasePath) throw new Error("Expected isolated runtime database path");
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: "https://connect.example/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer secret" },
    });

    const skills = await readOpenWorkConnectSkillCatalog(config, skillIndexFetcher());
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("customer-briefing");
    expect(existsSync(databasePath)).toBe(false);
  });

  test("does not create a runtime database while inspecting an empty catalog", async () => {
    const config = await serverConfig();
    const databasePath = process.env.OPENWORK_RUNTIME_DB;
    if (!databasePath) throw new Error("Expected isolated runtime database path");
    expect(existsSync(databasePath)).toBe(false);

    expect(await readOpenWorkConnectSkillCatalog(config)).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("replays successful candidate diagnostics on cache hits without catalog or credential details", async () => {
    const config = await serverConfig();
    const cloudUrl = "https://catalog-user:url-password@connect.example/mcp/agent?token=query-secret#fragment-secret";
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: cloudUrl,
      enabled: true,
      headers: { Authorization: "Bearer header-secret" },
    });

    let requests = 0;
    const working = skillIndexFetcher("skill:skill_private_capability");
    const fetcher = async (url: string, init?: RequestInit) => {
      requests += 1;
      return working(url, init);
    };
    const first: string[] = [];
    const second: string[] = [];

    expect(await readOpenWorkConnectSkillCatalog(config, fetcher, (message) => first.push(message))).toHaveLength(1);
    expect(await readOpenWorkConnectSkillCatalog(config, fetcher, (message) => second.push(message))).toHaveLength(1);

    expect(requests).toBe(4);
    expect(first.some((message) => message.includes("source=server") && message.includes("cache=miss") && message.includes("result=1-skills"))).toBe(true);
    expect(second.some((message) => message.includes("source=server") && message.includes("cache=hit") && message.includes("result=1-skills"))).toBe(true);
    expect(first.some((message) => message.includes("phase=schema") && message.includes("outcome=selected skills=1"))).toBe(true);
    expect(second.some((message) => message.includes("phase=schema") && message.includes("outcome=selected skills=1"))).toBe(true);
    expect(second).toContain("skill catalog selected from server scope (1 skills)");

    const diagnostics = [...first, ...second].join("\n");
    for (const secret of [
      cloudUrl,
      "catalog-user",
      "url-password",
      "query-secret",
      "fragment-secret",
      "header-secret",
      "customer-briefing",
      "skill_private_capability",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
  });

  test("replays sanitized candidate failures on cache hits without raw errors or endpoint details", async () => {
    const config = await serverConfig();
    const cloudUrl = "https://catalog-user:url-password@connect.example/mcp/agent?token=query-secret#fragment-secret";
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: cloudUrl,
      enabled: true,
      headers: { Authorization: "Bearer header-secret" },
    });

    let requests = 0;
    const fetcher = async () => {
      requests += 1;
      throw new Error(`remote-payload-secret token=raw-error-secret endpoint=${cloudUrl}`);
    };
    const first: string[] = [];
    const second: string[] = [];

    expect(await readOpenWorkConnectSkillCatalog(config, fetcher, (message) => first.push(message))).toEqual([]);
    expect(await readOpenWorkConnectSkillCatalog(config, fetcher, (message) => second.push(message))).toEqual([]);

    expect(requests).toBe(1);
    expect(first.some((message) => message.includes("phase=candidate") && message.includes("reason=request-or-protocol-failure"))).toBe(true);
    expect(second.some((message) => message.includes("phase=candidate") && message.includes("reason=request-or-protocol-failure"))).toBe(true);
    expect(second.some((message) => message.includes("cache=hit") && message.includes("result=unusable"))).toBe(true);
    expect(second).toContain("skipped: every considered openwork-cloud MCP candidate was unusable");

    const diagnostics = [...first, ...second].join("\n");
    for (const secret of [
      cloudUrl,
      "catalog-user",
      "url-password",
      "query-secret",
      "fragment-secret",
      "header-secret",
      "remote-payload-secret",
      "raw-error-secret",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
  });

  test("reads a legacy workspace catalog without mutating server-scoped state", async () => {
    const config = await serverConfig();
    await writeRuntimeOpencodeConfig(config, "ws_legacy", (current) => ({
      ...current,
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://connect.example/mcp/agent",
          enabled: true,
        },
      },
    }));

    const skills = await readOpenWorkConnectSkillCatalog(config, skillIndexFetcher("skill:skill_promoted"));
    expect(skills[0]?.capability).toBe("skill:skill_promoted");
    expect(await readConnectCloudMcp(config)).toBeNull();

    // Clearing the only workspace source makes the next read empty; GET-style
    // catalog inspection must never have promoted it behind the user's back.
    await writeRuntimeOpencodeConfig(config, "ws_legacy", () => ({ mcp: {} }));
    resetOpenWorkConnectSkillCatalogCacheForTests();
    const again = await readOpenWorkConnectSkillCatalog(config, skillIndexFetcher("skill:skill_promoted"));
    expect(again).toEqual([]);
    expect(await readConnectCloudMcp(config)).toBeNull();
  });

  test("skips revoked or dead configs and selects a working fallback without promotion", async () => {
    const config = await serverConfig();
    // Poisoned server-scoped copy: stale local Den URL with a revoked token.
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: "https://stale.local.test/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer revoked" },
    });
    await writeRuntimeOpencodeConfig(config, "ws_legacy", (current) => ({
      ...current,
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://connect.example/mcp/agent",
          enabled: true,
          headers: { Authorization: "Bearer live" },
        },
      },
    }));

    const working = skillIndexFetcher("skill:skill_live");
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://stale.local.test")) {
        return Response.json({ error: "mcp_session_revoked" }, { status: 401 });
      }
      return working(url, init);
    };

    const skills = await readOpenWorkConnectSkillCatalog(config, fetcher);
    expect(skills[0]?.capability).toBe("skill:skill_live");

    // The read path must leave the explicit server-scoped source untouched.
    const kept = await readConnectCloudMcp(config);
    expect(kept?.url).toBe("https://stale.local.test/mcp/agent");
  });

  test("deduplicates candidates before applying the four-candidate bound", async () => {
    const config = await serverConfig();
    config.workspaces = Array.from({ length: 5 }, (_, index) => ({
      ...config.workspaces[0]!,
      id: `ws_${index}`,
      name: `Workspace ${index}`,
    }));
    const stale = {
      type: "remote",
      url: "https://stale.example/mcp",
      enabled: true,
    };
    await writeConnectCloudMcp(config, stale);
    for (let index = 0; index < 3; index += 1) {
      await writeRuntimeOpencodeConfig(config, `ws_${index}`, () => ({
        mcp: { "openwork-cloud": stale },
      }));
    }
    await writeRuntimeOpencodeConfig(config, "ws_3", () => ({
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://live.example/mcp",
          enabled: true,
        },
      },
    }));

    const working = skillIndexFetcher("skill:deduped_live");
    const skills = await readOpenWorkConnectSkillCatalog(config, (url, init) => (
      url.startsWith("https://stale.example")
        ? Promise.resolve(Response.json({}, { status: 401 }))
        : working(url, init)
    ));
    expect(skills[0]?.capability).toBe("skill:deduped_live");
  });

  test("returns empty when every candidate config is unusable", async () => {
    const config = await serverConfig();
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: "https://stale.local.test/mcp/agent",
      enabled: true,
    });
    const fetcher = async () => Response.json({ error: "invalid_token" }, { status: 401 });

    expect(await readOpenWorkConnectSkillCatalog(config, fetcher)).toEqual([]);
    // The dead config must not be re-promoted or kept as a false positive.
    const kept = await readConnectCloudMcp(config);
    expect(kept?.url).toBe("https://stale.local.test/mcp/agent");
  });
});
