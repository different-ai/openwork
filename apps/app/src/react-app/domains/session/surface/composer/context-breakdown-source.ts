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
  transcript: () => readonly UIMessage[];
  listSkills: () => Promise<readonly { name: string; description?: string; path?: string }[]>;
  listTools: () => Promise<readonly { id: string; description?: string; parameters?: unknown }[] | null>;
  listContext: () => Promise<readonly unknown[] | null>;
  connectedMcpServers: number;
};

const settled = async <T>(load: () => Promise<T>): Promise<T | null> => {
  try {
    return await load();
  } catch {
    return null;
  }
};

export async function loadBreakdownEstimates(deps: BreakdownSourceDeps): Promise<BreakdownEstimates> {
  const v2 = deps.engine === "v2";
  const [skills, tools, context] = await Promise.all([
    settled(deps.listSkills),
    v2 ? Promise.resolve(null) : settled(deps.listTools),
    v2 ? settled(deps.listContext) : Promise.resolve(null),
  ]);
  const skillRegistry = skills ? estimateSkillRegistryTokens(skills) : 0;

  if (v2) {
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
