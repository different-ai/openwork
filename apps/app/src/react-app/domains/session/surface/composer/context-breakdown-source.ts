import type { UIMessage } from "ai";

import {
  buildContextBreakdown,
  estimateContextEntries,
  estimateSkillRegistryTokens,
  estimateToolDefinitionTokens,
  estimateTranscriptTokens,
  type BreakdownEstimates,
  type ContextBreakdown,
} from "./context-breakdown";
import type { ContextEngine, ContextUsage } from "./context-usage";

export type BreakdownSourceDeps = {
  engine: ContextEngine;
  /** The transcript as rendered, read when the popover opens. */
  transcript: () => readonly UIMessage[];
  listSkills: () => Promise<readonly { name: string; description?: string; path?: string }[]>;
  /** v1: the tool definitions the engine lists for the selected model. Null when it cannot say. */
  listTools: () => Promise<readonly { id: string; description?: string; parameters?: unknown }[] | null>;
  /** v2: the messages the engine will send next. Null when it cannot say. */
  listContext: () => Promise<readonly unknown[] | null>;
  /** Connected MCP servers: on v1 their tools are not in the tool list, so the Tools row is partial. */
  connectedMcpServers: number;
};

const settled = async <T>(load: () => Promise<T>): Promise<T | null> => {
  try {
    return await load();
  } catch {
    return null;
  }
};

/**
 * Gathers what the breakdown estimates from. Local reads only: the transcript
 * in memory, the engine's own lists on loopback. A source that fails leaves its
 * share in "system and other" instead of failing the whole breakdown.
 */
export async function loadBreakdownEstimates(deps: BreakdownSourceDeps): Promise<BreakdownEstimates> {
  const v2 = deps.engine === "v2";
  const [skills, tools, context] = await Promise.all([
    settled(deps.listSkills),
    v2 ? Promise.resolve(null) : settled(deps.listTools),
    v2 ? settled(deps.listContext) : Promise.resolve(null),
  ]);
  const skillRegistry = skills ? estimateSkillRegistryTokens(skills) : 0;

  if (v2) {
    // On v2 the built-in tool definitions cannot be listed and stay in "system and
    // other"; only the Code Mode catalog of MCP tools is known, so that is all
    // this row claims to be.
    const sizes = context ? estimateContextEntries(context) : null;
    const transcript = sizes ?? estimateTranscriptTokens(deps.transcript());
    return {
      messages: transcript.messages,
      activeSkills: transcript.activeSkills,
      skillRegistry,
      tools: sizes?.catalog ?? 0,
      toolsRow: "mcpTools",
      toolsPartial: false,
    };
  }

  const transcript = estimateTranscriptTokens(deps.transcript());
  return {
    messages: transcript.messages,
    activeSkills: transcript.activeSkills,
    skillRegistry,
    tools: tools ? estimateToolDefinitionTokens(tools) : 0,
    toolsRow: "tools",
    toolsPartial: tools === null || deps.connectedMcpServers > 0,
  };
}

export async function loadContextBreakdown(deps: BreakdownSourceDeps, usage: ContextUsage): Promise<ContextBreakdown> {
  return buildContextBreakdown({
    used: usage.used,
    window: usage.window,
    ceiling: usage.ceiling,
    estimates: await loadBreakdownEstimates(deps),
  });
}
