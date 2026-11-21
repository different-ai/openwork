import type { MessageTokens, ModelRef } from "@/app/types";
import type { MeasuredUsage } from "../../sync/measured-usage-store";
import { toRecord } from "../../sync/unknown-values";

export type ContextEngine = "v1" | "v2";

export type ContextWindowLimit = {
  context: number;
  input?: number;
  output: number;
};

export type CompactionSettings = {
  auto?: boolean;
  reserved?: number;
  buffer?: number | string;
};

export type ContextTone = "neutral" | "warning" | "strong";

const V1_OUTPUT_TOKEN_MAX = 32_000;
const V1_COMPACTION_BUFFER = 20_000;
const V2_RESERVE_SHARE = 0.15;
const V2_RESERVE_MIN = 16_000;

export const CONTEXT_WARNING_SHARE = 0.7;
export const CONTEXT_NEAR_CEILING_SHARE = 0.05;

export function measuredContextTokens(tokens: MessageTokens, engine: ContextEngine): number {
  if (engine === "v2") return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

export function compactionCeiling(engine: ContextEngine, limit: ContextWindowLimit, settings: CompactionSettings = {}): number | null {
  if (settings.auto === false) return null;
  if (engine === "v1") {
    if (limit.context <= 0) return null;
    const maxOutput = Math.min(limit.output, V1_OUTPUT_TOKEN_MAX) || V1_OUTPUT_TOKEN_MAX;
    if (limit.input) return Math.max(0, limit.input - (settings.reserved ?? Math.min(V1_COMPACTION_BUFFER, maxOutput)));
    return Math.max(0, limit.context - maxOutput);
  }
  const window = limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context;
  if (window <= 0) return null;
  const buffer = typeof settings.buffer === "string" ? Math.round((window * Number.parseFloat(settings.buffer)) / 100) : settings.buffer;
  if (buffer !== undefined && buffer < window) return window - buffer;
  return window - Math.max(Math.floor(window * V2_RESERVE_SHARE), window >= 2 * V2_RESERVE_MIN ? V2_RESERVE_MIN : 0);
}

export function contextUsagePercent(used: number, windowTokens: number): number | null {
  if (windowTokens <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / windowTokens) * 100)));
}

export function contextUsageTone(input: { used: number; window: number; ceiling: number | null }): ContextTone {
  const { used, window, ceiling } = input;
  if (window <= 0) return "neutral";
  if (ceiling !== null && used >= ceiling - CONTEXT_NEAR_CEILING_SHARE * window) return "strong";
  return used >= CONTEXT_WARNING_SHARE * window ? "warning" : "neutral";
}

type MessageWithUsage = {
  info: { id: string; role: string; tokens?: MessageTokens; summary?: unknown };
};

export function latestMeasuredUsage(messages: readonly MessageWithUsage[], engine: ContextEngine): MeasuredUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const { info } = messages[index];
    if (info.role !== "assistant") continue;
    if (info.summary === true) return null;
    if (info.tokens && measuredContextTokens(info.tokens, engine) > 0) return { messageId: info.id, tokens: info.tokens };
  }
  return null;
}

export function pickMeasuredUsage(
  live: MeasuredUsage | undefined,
  history: MeasuredUsage | null,
  messageIds: readonly string[],
): MeasuredUsage | null {
  if (!live) return history;
  if (!history || live.messageId === history.messageId) return live;
  const liveIndex = messageIds.indexOf(live.messageId);
  if (liveIndex === -1) return live;
  return messageIds.indexOf(history.messageId) > liveIndex ? history : live;
}

export function readCompactionSettings(value: unknown): CompactionSettings {
  const raw = toRecord(value);
  const count = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined);
  return {
    ...(typeof raw.auto === "boolean" ? { auto: raw.auto } : {}),
    ...(count(raw.reserved) === undefined ? {} : { reserved: count(raw.reserved) }),
    ...(typeof raw.buffer === "string" && raw.buffer.trim() !== "" ? { buffer: raw.buffer } : count(raw.buffer) === undefined ? {} : { buffer: count(raw.buffer) }),
  };
}

export type ContextCompactionHint = "soon";

export type ContextUsage = {
  used: number;
  window: number | null;
  percent: number | null;
  ceiling: number | null;
  tone: ContextTone;
  hint: ContextCompactionHint | null;
};

export function buildContextUsage(input: {
  measured: MeasuredUsage | null;
  engine: ContextEngine;
  limit: ContextWindowLimit | null;
  settings?: CompactionSettings;
}): ContextUsage | null {
  if (!input.measured) return null;
  const used = measuredContextTokens(input.measured.tokens, input.engine);
  if (!input.limit) return { used, window: null, percent: null, ceiling: null, tone: "neutral", hint: null };
  const window = input.limit.context;
  const ceiling = compactionCeiling(input.engine, input.limit, input.settings);
  const tone = contextUsageTone({ used, window, ceiling });
  const hint: ContextCompactionHint | null = tone === "strong" ? "soon" : null;
  return { used, window, percent: contextUsagePercent(used, window), ceiling, tone, hint };
}

export function formatTokens(tokens: number): string {
  const trim = (value: number) => String(Number(value.toFixed(1)));
  const thousands = Number((tokens / 1_000).toFixed(1));
  if (thousands >= 1_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

type ProviderModels = {
  readonly all: readonly {
    readonly id: string;
    readonly models: { readonly [modelId: string]: { readonly limit?: { readonly context: number; readonly input?: number; readonly output: number } } | undefined };
  }[];
};

export function contextLimitFor(providers: ProviderModels | null | undefined, model: ModelRef | null | undefined): ContextWindowLimit | null {
  if (!providers || !model) return null;
  const limit = providers.all.find((provider) => provider.id === model.providerID)?.models[model.modelID]?.limit;
  if (!limit || !(limit.context > 0)) return null;
  return { context: limit.context, output: limit.output, ...(limit.input ? { input: limit.input } : {}) };
}
