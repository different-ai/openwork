import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readMcpSkillIndex,
  readOpenWorkConnectSkillCatalog,
  renderOpenWorkConnectSkillInstruction,
  resetOpenWorkConnectSkillCatalogCacheForTests,
  type OpenWorkConnectSkill,
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
  test("renders discovery metadata and capability retrieval guidance", () => {
    const instruction = renderOpenWorkConnectSkillInstruction([{
      name: "customer-briefing",
      type: "skill-md",
      title: "Customer Briefing",
      description: "Use for accounts & renewals <before calls>",
      marketplaceName: "Revenue & Success",
      pluginName: "Customer <Ops>",
      url: "skill://customer-briefing/SKILL.md",
      capability: "skill:skill_customer_briefing",
    }]);

    expect(instruction).toContain("<available_skills>");
    expect(instruction).toContain("<title>Customer Briefing</title>");
    expect(instruction).toContain("<name>customer-briefing</name>");
    expect(instruction).toContain("Use for accounts &amp; renewals &lt;before calls&gt;");
    expect(instruction).toContain("<marketplace>Revenue &amp; Success</marketplace>");
    expect(instruction).toContain("<plugin>Customer &lt;Ops&gt;</plugin>");
    expect(instruction).toContain("<location>skill://customer-briefing/SKILL.md</location>");
    expect(instruction).toContain("<capability>skill:skill_customer_briefing</capability>");
    expect(instruction).toContain("openwork-cloud_execute_capability");
    expect(instruction).toContain("NEVER use the native Load Skill tool");
    expect(instruction).toContain("exact value from that skill's <capability> field");
    expect(instruction).toContain("Do not call openwork-cloud_search_capabilities first");
    expect(instruction).toContain("transient HTTP 502, 503, or 504");
    expect(instruction).toContain("retry the same capability once");
    expect(instruction).not.toContain("# Customer Briefing");
  });

  test("renders every authorized skill beyond the former count and character limits", () => {
    const skills: OpenWorkConnectSkill[] = Array.from({ length: 150 }, (_, index) => ({
      name: `marketplace-skill-${index}`,
      type: "skill-md",
      title: `Marketplace Skill ${index}`,
      description: `Use marketplace skill ${index} when requested. ${"Detailed discovery context. ".repeat(12)}`,
      marketplaceName: "Enterprise Marketplace",
      pluginName: `Plugin ${index}`,
      url: `skill://marketplace-skill-${index}/SKILL.md`,
      capability: `plugin:plg_${index}:cob_${index}`,
    }));

    const instruction = renderOpenWorkConnectSkillInstruction(skills);

    expect(instruction.length).toBeGreaterThan(32_000);
    expect(instruction.match(/  <skill>/g)).toHaveLength(150);
    expect(instruction).toContain("<title>Marketplace Skill 149</title>");
    expect(instruction).toContain("<capability>plugin:plg_149:cob_149</capability>");
  });

  test("keeps older skill indexes compatible by falling back from title to name", () => {
    const instruction = renderOpenWorkConnectSkillInstruction([{
      name: "legacy-skill",
      type: "skill-md",
      description: "",
      url: "skill://legacy-skill/SKILL.md",
      capability: "skill:skill_legacy",
    }]);

    expect(instruction).toContain("<title>legacy-skill</title>");
    expect(instruction).toContain("<description>legacy-skill</description>");
    expect(instruction).not.toContain("<marketplace>");
    expect(instruction).not.toContain("<plugin>");
  });

  test("omits the prompt block when no authorized skills exist", () => {
    expect(renderOpenWorkConnectSkillInstruction([])).toBe("");
  });

  test("reads the standards-shaped index through an authenticated MCP resource", async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }, {
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
                title: "Customer Briefing",
                description: "Prepare customer briefings.",
                marketplaceName: "Go To Market",
                pluginName: "Revenue Operations",
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
    expect(skills?.[0]).toMatchObject({
      title: "Customer Briefing",
      description: "Prepare customer briefings.",
      marketplaceName: "Go To Market",
      pluginName: "Revenue Operations",
    });
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-1");
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
    await writeConnectCloudMcp(config, {
      type: "remote",
      url: "https://connect.example/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer secret" },
    });

    const skills = await readOpenWorkConnectSkillCatalog(config, skillIndexFetcher());
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("customer-briefing");
  });

  test("promotes legacy workspace openwork-cloud config into server scope", async () => {
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

    // Second read should use the promoted host-level copy even if workspace config is cleared.
    await writeRuntimeOpencodeConfig(config, "ws_legacy", () => ({ mcp: {} }));
    resetOpenWorkConnectSkillCatalogCacheForTests();
    const again = await readOpenWorkConnectSkillCatalog(config, skillIndexFetcher("skill:skill_promoted"));
    expect(again[0]?.capability).toBe("skill:skill_promoted");
  });

  test("skips revoked or dead configs and promotes the first working candidate", async () => {
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

    // The working workspace config must replace the poisoned server-scoped copy.
    const promoted = await readConnectCloudMcp(config);
    expect(promoted?.url).toBe("https://connect.example/mcp/agent");
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
