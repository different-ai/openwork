import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { loadBreakdownEstimates, loadContextBreakdown, type BreakdownSourceDeps } from "../src/react-app/domains/session/surface/composer/context-breakdown-source";
import type { ContextUsage } from "../src/react-app/domains/session/surface/composer/context-usage";

const transcript = [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "x".repeat(400) }] }] as UIMessage[];
const skills = [{ name: "demo-skill", description: "d".repeat(190), path: "p".repeat(130) }];
const tools = [{ id: "read", description: "r".repeat(1_000), parameters: { type: "object" } }];

const deps = (extra: Partial<BreakdownSourceDeps> = {}): BreakdownSourceDeps => ({
  engine: "v1",
  transcript: () => transcript,
  listSkills: async () => skills,
  listTools: async () => tools,
  listContext: async () => null,
  connectedMcpServers: 0,
  ...extra,
});

const usage: ContextUsage = { used: 20_000, window: 100_000, percent: 20, ceiling: 92_000, tone: "neutral", hint: null };

describe("loadBreakdownEstimates on v1", () => {
  test("sizes the transcript, the skill list and the tool list", async () => {
    const estimates = await loadBreakdownEstimates(deps());
    expect(estimates.messages).toBe(100);
    expect(estimates.skillRegistry).toBeGreaterThan(0);
    expect(estimates.tools).toBeGreaterThan(250);
    expect(estimates.toolsPartial).toBe(false);
    expect(estimates.toolsRow).toBe("tools");
  });

  test("the Tools row is partial once an MCP server is connected, whose tools the list does not show", async () => {
    expect((await loadBreakdownEstimates(deps({ connectedMcpServers: 2 }))).toolsPartial).toBe(true);
  });

  test("a failing tool list leaves the tools to the remainder and says so", async () => {
    const estimates = await loadBreakdownEstimates(deps({ listTools: async () => { throw new Error("offline"); } }));
    expect(estimates).toMatchObject({ tools: 0, toolsPartial: true, messages: 100 });
  });

  test("a failing skill list leaves the registry to the remainder", async () => {
    const estimates = await loadBreakdownEstimates(deps({ listSkills: async () => { throw new Error("offline"); } }));
    expect(estimates.skillRegistry).toBe(0);
  });

  test("never reads the engine context on v1", async () => {
    let read = false;
    await loadBreakdownEstimates(deps({ listContext: async () => { read = true; return []; } }));
    expect(read).toBe(false);
  });
});

describe("loadBreakdownEstimates on v2", () => {
  const entries = [
    { type: "user", text: "x".repeat(200) },
    { type: "system", text: "c".repeat(800), metadata: { instructionSources: ["core/codemode"] } },
  ];

  test("sizes the engine context, with the Code Mode catalog as an MCP tools row", async () => {
    const estimates = await loadBreakdownEstimates(deps({ engine: "v2", listContext: async () => entries }));
    expect(estimates).toMatchObject({ messages: 50, tools: 200, toolsRow: "mcpTools", toolsPartial: false });
  });

  test("never lists tools on v2", async () => {
    let listed = false;
    await loadBreakdownEstimates(deps({ engine: "v2", listContext: async () => entries, listTools: async () => { listed = true; return tools; } }));
    expect(listed).toBe(false);
  });

  test("falls back to the transcript when the engine context cannot be read", async () => {
    const estimates = await loadBreakdownEstimates(deps({ engine: "v2", listContext: async () => { throw new Error("offline"); } }));
    expect(estimates).toMatchObject({ messages: 100, tools: 0, toolsRow: "mcpTools", toolsPartial: false });
  });
});

describe("loadContextBreakdown", () => {
  test("builds the rows against the measured total and the window", async () => {
    const breakdown = await loadContextBreakdown(deps(), usage);
    expect(breakdown.used).toBe(20_000);
    expect(breakdown.window).toBe(100_000);
    expect(breakdown.rows.map((row) => row.id)).toEqual(["messages", "skills", "tools", "system", "buffer", "free"]);
    expect(breakdown.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(100_000);
  });
});
