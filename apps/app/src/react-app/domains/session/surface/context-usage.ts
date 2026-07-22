import type { Part } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "@/app/lib/openwork-server";
import type { ModelRef } from "@/app/types";

// UI-only fallback: real tokenization varies by model, especially for code-heavy transcripts.
const ESTIMATED_CHARS_PER_TOKEN = 4;
const WARNING_THRESHOLD = 70;
const DANGER_THRESHOLD = 90;

type ModelCatalog = {
  all: readonly {
    id: string;
    models: {
      readonly [modelId: string]: {
        readonly limit?: {
          readonly context: number;
        };
      } | undefined;
    };
  }[];
};

export type ContextUsageTone = "neutral" | "warning" | "danger";

export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  percent: number;
  label: string;
  tone: ContextUsageTone;
  isEstimate: boolean;
  showCompactionHint: boolean;
};

export type ContextTranscriptUsage = {
  tokens: number;
  isEstimate: boolean;
};

function positiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.ceil(value);
}

export function estimateTextTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / ESTIMATED_CHARS_PER_TOKEN));
}

function partText(part: Part) {
  if (part.type === "text" && !part.synthetic && !part.ignored) return part.text;
  if (part.type === "reasoning") return part.text;
  if (part.type === "agent") return part.name;
  if (part.type === "file") return [part.filename, part.mime].filter(Boolean).join(" ");
  return "";
}

function estimateSnapshotTokens(snapshot: OpenworkSessionSnapshot | null | undefined) {
  if (!snapshot) return 0;
  const text = snapshot.messages
    .flatMap((message) => message.parts.map(partText))
    .filter(Boolean)
    .join("\n");
  return estimateTextTokens(text);
}

function uiPartText(part: UIMessage["parts"][number]) {
  if ("text" in part && typeof part.text === "string") return part.text;
  if (part.type === "file") return [part.filename, part.mediaType].filter(Boolean).join(" ");
  if (part.type === "source-url") return [part.title, part.url].filter(Boolean).join(" ");
  if (part.type === "source-document") return [part.title, part.filename, part.mediaType].filter(Boolean).join(" ");
  return "";
}

function estimateRenderedMessageTokens(messages: UIMessage[] | null | undefined) {
  if (!messages) return 0;
  const text = messages
    .flatMap((message) => message.parts.map(uiPartText))
    .filter(Boolean)
    .join("\n");
  return estimateTextTokens(text);
}

function estimateRenderedMessagesAfterSnapshot(snapshot: OpenworkSessionSnapshot | null | undefined, messages: UIMessage[] | null | undefined) {
  if (!snapshot || !messages) return 0;
  const snapshotMessageIds = new Set(snapshot.messages.map((message) => message.info.id));
  const liveMessages = messages.filter((message) => !snapshotMessageIds.has(message.id));
  return estimateRenderedMessageTokens(liveMessages);
}

export function getLatestReportedContextTokens(snapshot: OpenworkSessionSnapshot | null | undefined) {
  if (!snapshot) return null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (!message || message.info.role !== "assistant") continue;

    const total = positiveInteger(message.info.tokens.total);
    if (total !== null) return total;

    const input = positiveInteger(message.info.tokens.input) ?? 0;
    const output = positiveInteger(message.info.tokens.output) ?? 0;
    const reasoning = positiveInteger(message.info.tokens.reasoning) ?? 0;
    const combined = input + output + reasoning;
    if (combined > 0) return combined;
  }
  return null;
}

export function getSelectedModelContextLimit(providerList: ModelCatalog | null | undefined, selectedModel: ModelRef | null | undefined) {
  if (!providerList || !selectedModel) return null;
  const provider = providerList.all.find((item) => item.id === selectedModel.providerID);
  const context = provider?.models[selectedModel.modelID]?.limit?.context;
  return positiveInteger(context);
}

export function getContextUsageTone(percent: number): ContextUsageTone {
  if (percent >= DANGER_THRESHOLD) return "danger";
  if (percent >= WARNING_THRESHOLD) return "warning";
  return "neutral";
}

function compactTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

export function buildContextTranscriptUsage(input: {
  snapshot: OpenworkSessionSnapshot | null | undefined;
  renderedMessages?: UIMessage[] | null | undefined;
}): ContextTranscriptUsage {
  const reportedTokens = getLatestReportedContextTokens(input.snapshot);
  const renderedEstimate = estimateRenderedMessageTokens(input.renderedMessages);
  const snapshotEstimate = estimateSnapshotTokens(input.snapshot);
  const liveTokensAfterSnapshot = estimateRenderedMessagesAfterSnapshot(input.snapshot, input.renderedMessages);
  const transcriptTokens = reportedTokens !== null
    ? reportedTokens + liveTokensAfterSnapshot
    : Math.max(snapshotEstimate, renderedEstimate);

  return {
    tokens: transcriptTokens,
    isEstimate: liveTokensAfterSnapshot > 0 || (reportedTokens === null && transcriptTokens > 0),
  };
}

export function buildContextUsage(input: {
  contextLimit: number | null | undefined;
  transcriptUsage: ContextTranscriptUsage;
  draftText: string;
}): ContextUsage | null {
  const limitTokens = positiveInteger(input.contextLimit);
  if (limitTokens === null) return null;

  const draftTokens = estimateTextTokens(input.draftText);
  const transcriptTokens = input.transcriptUsage.tokens;
  const usedTokens = Math.min(limitTokens, transcriptTokens + draftTokens);
  const percent = Math.min(100, Math.round((usedTokens / limitTokens) * 100));
  const isEstimate = draftTokens > 0 || input.transcriptUsage.isEstimate;
  const label = `ctx ${isEstimate ? "~" : ""}${compactTokenCount(usedTokens)} / ${compactTokenCount(limitTokens)} - ${percent}%`;

  return {
    usedTokens,
    limitTokens,
    percent,
    label,
    tone: getContextUsageTone(percent),
    isEstimate,
    showCompactionHint: percent >= DANGER_THRESHOLD,
  };
}
