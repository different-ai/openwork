import { describe, expect, test } from "bun:test";

import { readMcpSkillIndex, renderOpenWorkConnectSkillInstruction } from "./connect-skill-catalog.js";

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
    expect(instruction).not.toContain("# Customer Briefing");
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
    expect(skills[0]?.capability).toBe("skill:skill_customer_briefing");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-1");
  });
});
