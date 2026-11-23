import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  buildContextBreakdown,
  estimateCharsTokens,
  estimateContextEntries,
  estimateSkillRegistryTokens,
  estimateToolDefinitionTokens,
  estimateTranscriptTokens,
  formatShare,
  rowShare,
  rowsForBasis,
  type BreakdownEstimates,
} from "../src/react-app/domains/session/surface/composer/context-breakdown";

const message = (id: string, parts: unknown[]): UIMessage => ({ id, role: "assistant", parts } as UIMessage);
const chars = (n: number) => "x".repeat(n);

describe("estimateTranscriptTokens", () => {
  test("counts text and reasoning at four characters per token", () => {
    const result = estimateTranscriptTokens([
      message("m1", [{ type: "text", text: chars(400) }, { type: "reasoning", text: chars(40) }]),
    ]);
    expect(result).toEqual({ messages: 110, activeSkills: 0 });
  });

  test("counts a tool call by name, input and output, and a skill call as an active skill", () => {
    const result = estimateTranscriptTokens([
      message("m1", [
        { type: "dynamic-tool", toolName: "read", state: "output-available", input: { filePath: "a.ts" }, output: chars(800) },
        { type: "dynamic-tool", toolName: "skill", state: "output-available", input: { name: "demo" }, output: chars(2_000) },
      ]),
    ]);
    expect(result.messages).toBe(estimateCharsTokens("read".length + JSON.stringify({ filePath: "a.ts" }).length + 800));
    expect(result.activeSkills).toBe(estimateCharsTokens("skill".length + JSON.stringify({ name: "demo" }).length + 2_000));
  });

  test("sizes attachments by kind, not by their address", () => {
    const result = estimateTranscriptTokens([
      message("m1", [
        { type: "file", mediaType: "image/png", filename: "a.png", url: `data:image/png;base64,${chars(500_000)}` },
        { type: "file", mediaType: "application/pdf", filename: "b.pdf", url: "file:///b.pdf" },
        { type: "file", mediaType: "text/plain", filename: "notes.txt", url: "file:///notes.txt" },
      ]),
    ]);
    expect(result.messages).toBe(1_500 + 2_000 + estimateCharsTokens("notes.txt".length));
  });

  test("skips the error rows the chat shows but the model never sees", () => {
    const result = estimateTranscriptTokens([
      message("session-error:turn-1", [{ type: "text", text: chars(4_000) }]),
      message("m1", [{ type: "text", text: chars(40) }]),
    ]);
    expect(result.messages).toBe(10);
  });

  test("is zero for an empty transcript", () => {
    expect(estimateTranscriptTokens([])).toEqual({ messages: 0, activeSkills: 0 });
  });
});

describe("estimateContextEntries", () => {
  // Shapes recorded from OpenCode 2.0.26 (GET /api/session/{id}/context).
  const catalog = "The Code Mode tool catalog has changed.\n\n" + chars(751);
  const entries = [
    { id: "msg_1", time: { created: 1 }, text: "Turn 1: say hello briefly.", type: "user" },
    {
      id: "msg_2", time: { created: 2 }, type: "assistant", agent: "build", model: { id: "ctx-model", providerID: "fake" },
      content: [{ type: "text", text: "Fake reply for the context spike." }],
      finish: "stop", rawFinish: "stop", cost: 0, tokens: { input: 5596, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { id: "msg_3", time: { created: 3 }, type: "idle", outcome: "succeeded" },
    { id: "msg_4", metadata: { notice: "instructions", instructionSources: ["core/codemode"] }, time: { created: 4 }, type: "system", text: catalog, description: "Instructions updated: core/codemode" },
  ];

  test("sizes messages and keeps the Code Mode catalog apart", () => {
    const sizes = estimateContextEntries(entries);
    expect(sizes.messages).toBe(estimateCharsTokens("Turn 1: say hello briefly.".length + "Fake reply for the context spike.".length));
    expect(sizes.catalog).toBe(estimateCharsTokens(catalog.length));
    expect(sizes.activeSkills).toBe(0);
    expect(sizes.instructions).toBe(0);
  });

  test("other instruction notices count as instructions", () => {
    const sizes = estimateContextEntries([{ type: "system", text: chars(400), metadata: { instructionSources: ["agents-md"] } }]);
    expect(sizes).toMatchObject({ instructions: 100, catalog: 0 });
  });

  test("counts a skill tool call as an active skill and other tool calls as messages", () => {
    const sizes = estimateContextEntries([{
      type: "assistant",
      content: [
        { type: "tool", id: "t1", name: "skill", state: { status: "completed", input: { name: "demo" }, content: [{ type: "text", text: chars(2_000) }], structured: {} } },
        { type: "tool", id: "t2", name: "read", state: { status: "completed", input: { filePath: "a.ts" }, content: [{ type: "text", text: chars(400) }], structured: { huge: chars(9_999) } } },
      ],
    }]);
    expect(sizes.activeSkills).toBe(estimateCharsTokens("skill".length + JSON.stringify({ name: "demo" }).length + 2_000));
    expect(sizes.messages).toBe(estimateCharsTokens("read".length + JSON.stringify({ filePath: "a.ts" }).length + 400));
  });

  test("counts a compaction summary as messages and a user file by kind, never by its uri", () => {
    const sizes = estimateContextEntries([
      { type: "compaction", reason: "auto", summary: chars(800), recent: chars(200) },
      { type: "user", text: "see attached", files: [{ uri: `data:image/png;base64,${chars(400_000)}`, mime: "image/png", name: "a.png" }] },
    ]);
    expect(sizes.messages).toBe(estimateCharsTokens(1_000 + "see attached".length) + 1_500);
  });

  test("ignores entries it does not know and malformed ones", () => {
    expect(estimateContextEntries([null, "x", 3, { type: "agent-switched" }, { type: "model-switched" }, { type: "idle" }])).toEqual({
      messages: 0, activeSkills: 0, catalog: 0, instructions: 0,
    });
  });
});

describe("estimateSkillRegistryTokens and estimateToolDefinitionTokens", () => {
  test("a skill costs its name, description and location plus a fixed wrapper", () => {
    expect(estimateSkillRegistryTokens([{ name: "demo-skill", description: chars(190), path: chars(130) }])).toBe(estimateCharsTokens(10 + 190 + 130 + 70));
    expect(estimateSkillRegistryTokens([])).toBe(0);
  });

  test("a tool definition costs its name, description and schema plus a fixed wrapper, and invalid costs nothing", () => {
    const tool = { id: "read", description: chars(1_000), parameters: { type: "object", properties: { filePath: { type: "string" } } } };
    const expected = estimateCharsTokens("read".length + 1_000 + JSON.stringify(tool.parameters).length + 90);
    expect(estimateToolDefinitionTokens([tool])).toBe(expected);
    expect(estimateToolDefinitionTokens([tool, { id: "invalid", description: chars(10), parameters: {} }])).toBe(expected);
  });
});

describe("buildContextBreakdown", () => {
  const estimates = (extra: Partial<BreakdownEstimates> = {}): BreakdownEstimates => ({
    messages: 1_000, activeSkills: 0, skillRegistry: 300, tools: 5_000, toolsRow: "tools", toolsPartial: false, ...extra,
  });

  test("the rows add up to the measured total, the remainder is system and other", () => {
    const breakdown = buildContextBreakdown({ used: 10_000, window: 100_000, ceiling: 92_000, estimates: estimates() });
    expect(breakdown.rows.map((row) => [row.id, row.tokens])).toEqual([
      ["messages", 1_000],
      ["skills", 300],
      ["tools", 5_000],
      ["system", 3_700],
      ["buffer", 8_000],
      ["free", 82_000],
    ]);
    const occupied = rowsForBasis(breakdown, "occupied").reduce((sum, row) => sum + row.tokens, 0);
    expect(occupied).toBe(10_000);
    expect(breakdown.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(100_000);
    expect(breakdown.scaled).toBe(false);
  });

  test("marks what is derived from the window as not estimated", () => {
    const rows = buildContextBreakdown({ used: 10_000, window: 100_000, ceiling: 92_000, estimates: estimates() }).rows;
    expect(rows.filter((row) => !row.estimated).map((row) => row.id)).toEqual(["buffer", "free"]);
  });

  test("scales estimates down when they exceed the measured total, and leaves nothing for the remainder", () => {
    const breakdown = buildContextBreakdown({ used: 3_000, window: 100_000, ceiling: null, estimates: estimates({ messages: 4_000, tools: 8_000 }) });
    expect(breakdown.scaled).toBe(true);
    const known = breakdown.rows.filter((row) => row.id !== "system" && row.id !== "free");
    expect(known.reduce((sum, row) => sum + row.tokens, 0)).toBeLessThanOrEqual(3_000);
    expect(breakdown.rows.find((row) => row.id === "system")?.tokens).toBeLessThanOrEqual(5);
  });

  test("hides empty categories but keeps a partial one visible", () => {
    const hidden = buildContextBreakdown({ used: 6_000, window: 100_000, ceiling: null, estimates: estimates({ messages: 0, skillRegistry: 0, tools: 0 }) });
    expect(hidden.rows.map((row) => row.id)).toEqual(["system", "free"]);
    const partial = buildContextBreakdown({ used: 6_000, window: 100_000, ceiling: null, estimates: estimates({ messages: 0, skillRegistry: 0, tools: 0, toolsPartial: true }) });
    expect(partial.rows[0]).toMatchObject({ id: "tools", tokens: 0, partial: true });
  });

  test("without a window there is no free space and no buffer", () => {
    const breakdown = buildContextBreakdown({ used: 10_000, window: null, ceiling: null, estimates: estimates() });
    expect(breakdown.rows.map((row) => row.id)).toEqual(["messages", "skills", "tools", "system"]);
  });

  test("without a compaction ceiling there is free space but no buffer", () => {
    const breakdown = buildContextBreakdown({ used: 10_000, window: 100_000, ceiling: null, estimates: estimates() });
    expect(breakdown.rows.map((row) => row.id)).toEqual(["messages", "skills", "tools", "system", "free"]);
    expect(breakdown.rows.at(-1)?.tokens).toBe(90_000);
  });

  test("free space never goes below zero when the buffer is already reached", () => {
    const breakdown = buildContextBreakdown({ used: 95_000, window: 100_000, ceiling: 92_000, estimates: estimates() });
    expect(breakdown.rows.at(-1)).toMatchObject({ id: "free", tokens: 0 });
  });
});

describe("MCP tools row (v2)", () => {
  test("is its own row without the partial mark, and hidden while there is nothing in it", () => {
    const withCatalog = buildContextBreakdown({ used: 10_000, window: 100_000, ceiling: null, estimates: { messages: 1_000, activeSkills: 0, skillRegistry: 0, tools: 200, toolsRow: "mcpTools", toolsPartial: false } });
    expect(withCatalog.rows.map((row) => row.id)).toEqual(["messages", "mcpTools", "system", "free"]);
    expect(withCatalog.rows.find((row) => row.id === "mcpTools")).toEqual({ id: "mcpTools", tokens: 200, estimated: true });
    const empty = buildContextBreakdown({ used: 10_000, window: 100_000, ceiling: null, estimates: { messages: 1_000, activeSkills: 0, skillRegistry: 0, tools: 0, toolsRow: "mcpTools", toolsPartial: false } });
    expect(empty.rows.map((row) => row.id)).toEqual(["messages", "system", "free"]);
  });
});

describe("shares", () => {
  const breakdown = buildContextBreakdown({
    used: 50_000, window: 100_000, ceiling: 92_000,
    estimates: { messages: 25_000, activeSkills: 0, skillRegistry: 0, tools: 5_000, toolsRow: "tools", toolsPartial: false },
  });
  const row = (id: string) => breakdown.rows.find((candidate) => candidate.id === id)!;

  test("relative to the window, every row including the buffer and free space has a share", () => {
    expect(rowShare(row("messages"), breakdown, "window")).toBe(25);
    expect(rowShare(row("buffer"), breakdown, "window")).toBe(8);
    expect(rowShare(row("free"), breakdown, "window")).toBe(42);
  });

  test("relative to the occupied context, only occupied rows count and they sum to 100%", () => {
    const rows = rowsForBasis(breakdown, "occupied");
    expect(rows.map((candidate) => candidate.id)).toEqual(["messages", "tools", "system"]);
    expect(rows.reduce((sum, candidate) => sum + (rowShare(candidate, breakdown, "occupied") ?? 0), 0)).toBeCloseTo(100, 6);
    expect(rowShare(row("messages"), breakdown, "occupied")).toBe(50);
  });

  test("has no share without a base", () => {
    const noWindow = buildContextBreakdown({ used: 10_000, window: null, ceiling: null, estimates: { messages: 1_000, activeSkills: 0, skillRegistry: 0, tools: 0, toolsRow: "tools", toolsPartial: false } });
    expect(rowShare(noWindow.rows[0], noWindow, "window")).toBeNull();
    expect(rowShare(noWindow.rows[0], noWindow, "occupied")).toBe(10);
  });

  test("formats with one decimal, and tiny shares as less than 0.1%", () => {
    expect(formatShare(50.4)).toBe("50.4%");
    expect(formatShare(2.66)).toBe("2.7%");
    expect(formatShare(0.8)).toBe("0.8%");
    expect(formatShare(0.04)).toBe("<0.1%");
    expect(formatShare(0)).toBe("0.0%");
  });
});
