import type { MessageTokens, ModelRef } from "@/app/types";
import type { MeasuredUsage } from "../../sync/measured-usage-store";

/** The two OpenCode engines count and compact differently; see docs/plans/local-context-widget.md (M0 results). */
export type ContextEngine = "v1" | "v2";

export type ContextWindowLimit = {
  context: number;
  input?: number;
  output: number;
};

/** The engine's own `compaction` config, when it can be read. Absent keys mean the engine default. */
export type CompactionSettings = {
  auto?: boolean;
  /** v1 `compaction.reserved`. */
  reserved?: number;
  /** v2 `compaction.buffer`. */
  buffer?: number;
};

export type ContextTone = "neutral" | "warning" | "strong";

/** v1 never asks a model for more than this many output tokens when sizing its reserve. */
const V1_OUTPUT_TOKEN_MAX = 32_000;
/** v1 reserve when the model has an input limit: the least of this and the output limit. */
const V1_COMPACTION_BUFFER = 20_000;
/** v2 keeps this share of the window free, or `V2_RESERVE_MIN`, whichever is more. */
const V2_RESERVE_SHARE = 0.15;
const V2_RESERVE_MIN = 16_000;

/** Share of the window at which the indicator starts to warn. */
export const CONTEXT_WARNING_SHARE = 0.7;
/** The strong step starts this share of the window before the compaction ceiling. */
export const CONTEXT_NEAR_CEILING_SHARE = 0.05;

/**
 * Tokens the engine itself counts against the window after a finished message.
 * Same formulas as the engines' overflow checks, so the indicator and the
 * compaction agree: v1 prefers the provider's `total` and leaves reasoning out,
 * v2 sums every field.
 */
export function measuredContextTokens(tokens: MessageTokens, engine: ContextEngine): number {
  if (engine === "v2") return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
}

/**
 * Used tokens at or above which the engine compacts before its next request,
 * or `null` when it never does (auto-compaction off, or an unknown window).
 */
export function compactionCeiling(engine: ContextEngine, limit: ContextWindowLimit, settings: CompactionSettings = {}): number | null {
  if (settings.auto === false) return null;
  if (engine === "v1") {
    if (limit.context <= 0) return null;
    const maxOutput = Math.min(limit.output, V1_OUTPUT_TOKEN_MAX) || V1_OUTPUT_TOKEN_MAX;
    if (limit.input) return Math.max(0, limit.input - (settings.reserved ?? Math.min(V1_COMPACTION_BUFFER, maxOutput)));
    return Math.max(0, limit.context - maxOutput);
  }
  // An unknown input limit falls back to the context window; no window at all never compacts.
  const window = limit.input || limit.context;
  if (window <= 0) return null;
  if (settings.buffer !== undefined) return window - settings.buffer;
  return window - Math.max(Math.floor(window * V2_RESERVE_SHARE), window >= 2 * V2_RESERVE_MIN ? V2_RESERVE_MIN : 0);
}

/** Share of the window in percent, 0 to 100; `null` when the window is unknown. */
export function contextUsagePercent(used: number, windowTokens: number): number | null {
  if (windowTokens <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / windowTokens) * 100)));
}

/**
 * Color step of the indicator. The first step is a fixed share of the window;
 * the second follows the compaction ceiling, so it comes before the engine acts.
 * Without a ceiling (auto-compaction off, unknown window) only the first step exists.
 */
export function contextUsageTone(input: { used: number; window: number; ceiling: number | null }): ContextTone {
  const { used, window, ceiling } = input;
  if (window <= 0) return "neutral";
  if (ceiling !== null && used >= ceiling - CONTEXT_NEAR_CEILING_SHARE * window) return "strong";
  return used >= CONTEXT_WARNING_SHARE * window ? "warning" : "neutral";
}

type MessageWithUsage = {
  // v1 marks the compaction summary with `summary: true` on an assistant message; user messages carry an object there.
  info: { id: string; role: string; tokens?: MessageTokens; summary?: unknown };
};

/**
 * The latest assistant message of a history read that reports usage, or null.
 * A compaction summary reports what it cost to write the summary, not the size
 * of the context that follows; when it is the latest assistant message, nothing
 * is measured until the next reply.
 */
export function latestMeasuredUsage(messages: readonly MessageWithUsage[], engine: ContextEngine): MeasuredUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const { info } = messages[index];
    if (info.role !== "assistant") continue;
    if (info.summary === true) return null;
    if (info.tokens && measuredContextTokens(info.tokens, engine) > 0) return { messageId: info.id, tokens: info.tokens };
  }
  return null;
}

/**
 * The live figure and the history figure can differ: history may have been
 * read before the latest reply, or after a reply this window never saw. The one
 * that belongs to the later message wins; a live figure for a message the
 * history does not list yet (a reply still being written) is the newest.
 */
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

/** Reads the engine config's `compaction` block, keeping only what the ceiling needs. */
export function readCompactionSettings(value: unknown): CompactionSettings {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const count = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined);
  return {
    ...(typeof raw.auto === "boolean" ? { auto: raw.auto } : {}),
    ...(count(raw.reserved) === undefined ? {} : { reserved: count(raw.reserved) }),
    ...(count(raw.buffer) === undefined ? {} : { buffer: count(raw.buffer) }),
  };
}

/** Shown in the strong step. Both engines compact before the prompt that would cross the ceiling is answered, so "the next reply" is never a state one can stand in; only "soon" is. */
export type ContextCompactionHint = "soon";

export type ContextUsage = {
  /** Tokens counted against the window by the last measured reply. */
  used: number;
  /** The model's context window, or null when the model reports none. */
  window: number | null;
  /** Share of the window in percent; null without a window. */
  percent: number | null;
  /** Used tokens at which the engine compacts; null when it never does. */
  ceiling: number | null;
  tone: ContextTone;
  hint: ContextCompactionHint | null;
};

/** The state the indicator shows, or null while nothing has been measured yet. */
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

/** 999, 12.3k, 100k, 1.2M. */
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

/** The window of the selected model, or null while the catalog is missing or the model reports none (0). */
export function contextLimitFor(providers: ProviderModels | null | undefined, model: ModelRef | null | undefined): ContextWindowLimit | null {
  if (!providers || !model) return null;
  const limit = providers.all.find((provider) => provider.id === model.providerID)?.models[model.modelID]?.limit;
  if (!limit || !(limit.context > 0)) return null;
  return { context: limit.context, output: limit.output, ...(limit.input ? { input: limit.input } : {}) };
}
