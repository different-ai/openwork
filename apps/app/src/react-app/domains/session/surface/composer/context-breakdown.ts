import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";

import { readString, toRecord } from "../../sync/unknown-values";


const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_500;
const PDF_TOKENS = 2_000;
const TOOL_DEFINITION_OVERHEAD_CHARS = 90;
const SKILL_ENTRY_OVERHEAD_CHARS = 70;
const MAX_DEPTH = 8;

export type BreakdownRowId = "messages" | "activeSkills" | "skills" | "tools" | "mcpTools" | "system" | "buffer" | "free";

export type BreakdownRow = {
  id: BreakdownRowId;
  tokens: number;
  estimated: boolean;
  partial?: boolean;
};

export type ContextBreakdown = {
  used: number;
  window: number | null;
  rows: BreakdownRow[];
  scaled: boolean;
};

export type BreakdownEstimates = {
  messages: number;
  activeSkills: number;
  skillRegistry: number;
  tools: number;
  toolsRow: "tools" | "mcpTools";
  toolsPartial: boolean;
};

export type BasisMode = "window" | "occupied";

export const estimateCharsTokens = (chars: number) => (chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0);

export const estimateTextTokens = (text: string) => estimateCharsTokens(text.trim().length);

function jsonChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function stringChars(value: unknown, skip: ReadonlySet<string>, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (depth >= MAX_DEPTH || !value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + stringChars(item, skip, depth + 1), 0);
  let sum = 0;
  for (const [key, field] of Object.entries(value)) {
    if (!skip.has(key)) sum += stringChars(field, skip, depth + 1);
  }
  return sum;
}

const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "id", "type", "time", "metadata", "agent", "model", "finish", "rawFinish", "outcome", "tokens", "cost",
  "status", "provider", "callID", "sessionID", "outputPaths", "structured", "result", "description",
  "uri", "url", "files", "attachments",
]);

const SKILL_TOOL = "skill";

const fieldChars = (item: Record<string, unknown>, key: string) => (typeof item[key] === "string" ? item[key].length : 0);

function attachmentTokens(mediaType: string | undefined, filename: string | undefined): number {
  if (mediaType?.startsWith("image/")) return IMAGE_TOKENS;
  if (mediaType === "application/pdf") return PDF_TOKENS;
  return estimateCharsTokens(filename?.length ?? 0);
}

export function estimateTranscriptTokens(messages: readonly UIMessage[]): { messages: number; activeSkills: number } {
  let messageChars = 0;
  let skillChars = 0;
  let attachments = 0;
  for (const message of messages) {
    if (message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)) continue;
    for (const part of message.parts) {
      const fields = toRecord(part);
      if (part.type === "text" || part.type === "reasoning") {
        messageChars += readString(fields.text)?.length ?? 0;
      } else if (part.type === "file") {
        attachments += attachmentTokens(readString(fields.mediaType), readString(fields.filename));
      } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        const name = part.type === "dynamic-tool" ? readString(fields.toolName) ?? "" : part.type.slice("tool-".length);
        const chars = name.length + jsonChars(fields.input) + jsonChars(fields.output) + (readString(fields.errorText)?.length ?? 0);
        if (name === SKILL_TOOL) skillChars += chars;
        else messageChars += chars;
      }
    }
  }
  return { messages: estimateCharsTokens(messageChars) + attachments, activeSkills: estimateCharsTokens(skillChars) };
}

export type ContextEntrySizes = {
  messages: number;
  activeSkills: number;
  catalog: number;
  instructions: number;
};

export function estimateContextEntries(entries: readonly unknown[]): ContextEntrySizes {
  let messageChars = 0;
  let skillChars = 0;
  let catalogChars = 0;
  let instructionChars = 0;
  let attachments = 0;
  for (const entry of entries) {
    const item = toRecord(entry);
    switch (item.type) {
      case "user": {
        messageChars += typeof item.text === "string" ? item.text.length : 0;
        for (const file of Array.isArray(item.files) ? item.files : []) {
          const attachment = toRecord(file);
          attachments += attachmentTokens(readString(attachment.mime), readString(attachment.name));
        }
        for (const agent of Array.isArray(item.agents) ? item.agents : []) messageChars += stringChars(agent, BOOKKEEPING_KEYS);
        break;
      }
      case "synthetic":
        messageChars += fieldChars(item, "text");
        break;
      case "shell":
        messageChars += fieldChars(item, "command") + fieldChars(item, "output");
        break;
      case "compaction":
        messageChars += fieldChars(item, "summary") + fieldChars(item, "recent");
        break;
      case "system": {
        const sources = toRecord(item.metadata).instructionSources;
        const chars = typeof item.text === "string" ? item.text.length : 0;
        if (Array.isArray(sources) && sources.includes("core/codemode")) catalogChars += chars;
        else instructionChars += chars;
        break;
      }
      case "assistant": {
        for (const content of Array.isArray(item.content) ? item.content : []) {
          const block = toRecord(content);
          if (block.type === "tool") {
            const name = typeof block.name === "string" ? block.name : "";
            const state = toRecord(block.state);
            const input = typeof state.input === "string" ? state.input.length : jsonChars(state.input);
            const chars = name.length + input + stringChars(state.content, BOOKKEEPING_KEYS) + stringChars(state.error, BOOKKEEPING_KEYS);
            if (name === SKILL_TOOL) skillChars += chars;
            else messageChars += chars;
          } else {
            messageChars += stringChars(block, BOOKKEEPING_KEYS);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return {
    messages: estimateCharsTokens(messageChars) + attachments,
    activeSkills: estimateCharsTokens(skillChars),
    catalog: estimateCharsTokens(catalogChars),
    instructions: estimateCharsTokens(instructionChars),
  };
}

export function estimateSkillRegistryTokens(skills: readonly { name: string; description?: string; path?: string }[]): number {
  return estimateCharsTokens(skills.reduce(
    (sum, skill) => sum + skill.name.length + (skill.description?.length ?? 0) + (skill.path?.length ?? 0) + SKILL_ENTRY_OVERHEAD_CHARS,
    0,
  ));
}

export function estimateToolDefinitionTokens(tools: readonly { id: string; description?: string; parameters?: unknown }[]): number {
  return estimateCharsTokens(tools.reduce(
    (sum, tool) => tool.id === "invalid"
      ? sum
      : sum + tool.id.length + (tool.description?.length ?? 0) + jsonChars(tool.parameters) + TOOL_DEFINITION_OVERHEAD_CHARS,
    0,
  ));
}

export function buildContextBreakdown(input: {
  used: number;
  window: number | null;
  ceiling: number | null;
  estimates: BreakdownEstimates;
}): ContextBreakdown {
  const { used, window, ceiling, estimates } = input;
  const known = [
    { id: "messages" as const, tokens: estimates.messages, partial: false },
    { id: "activeSkills" as const, tokens: estimates.activeSkills, partial: false },
    { id: "skills" as const, tokens: estimates.skillRegistry, partial: false },
    { id: estimates.toolsRow, tokens: estimates.tools, partial: estimates.toolsPartial },
  ];
  const sum = known.reduce((total, row) => total + row.tokens, 0);
  const scaled = sum > used && sum > 0;
  const factor = scaled ? used / sum : 1;
  const rows: BreakdownRow[] = known
    .map((row) => ({ id: row.id, tokens: Math.floor(row.tokens * factor), estimated: true, ...(row.partial ? { partial: true } : {}) }))
    .filter((row) => row.tokens > 0 || row.partial);
  const explained = rows.reduce((total, row) => total + row.tokens, 0);
  rows.push({ id: "system", tokens: Math.max(0, used - explained), estimated: true });
  if (window !== null && window > 0) {
    const buffer = ceiling === null ? 0 : Math.max(0, window - ceiling);
    if (buffer > 0) rows.push({ id: "buffer", tokens: buffer, estimated: false });
    rows.push({ id: "free", tokens: Math.max(0, window - used - buffer), estimated: false });
  }
  return { used, window, rows, scaled };
}

export function rowsForBasis(breakdown: ContextBreakdown, basis: BasisMode): BreakdownRow[] {
  return basis === "occupied" ? breakdown.rows.filter((row) => row.id !== "buffer" && row.id !== "free") : breakdown.rows;
}

export function rowShare(row: BreakdownRow, breakdown: ContextBreakdown, basis: BasisMode): number | null {
  const base = basis === "occupied" ? breakdown.used : breakdown.window;
  if (base === null || base <= 0) return null;
  return (row.tokens / base) * 100;
}

export function formatShare(share: number): string {
  if (share > 0 && share < 0.05) return "<0.1%";
  return `${share.toFixed(1)}%`;
}
