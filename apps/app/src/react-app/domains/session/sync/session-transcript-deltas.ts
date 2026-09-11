import type { UIMessage } from "ai";

export type PendingDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  reasoning: boolean;
  delta: string;
};

export type DeltaFlushLane = "foreground" | "background";

type TranscriptMessageDraft = {
  message: UIMessage;
  partIndexById: Map<string, number>;
};

export function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type === "dynamic-tool") {
    const metadata = part.callProviderMetadata?.opencode;
    if (!metadata || typeof metadata !== "object") return null;
    const partId = Reflect.get(metadata, "partId");
    return typeof partId === "string" ? partId : null;
  }
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "file" && part.type !== "source-url" && part.type !== "source-document") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  const partId = Reflect.get(metadata, "partId");
  return typeof partId === "string" ? partId : null;
}

/**
 * Infer the role of a message shell created before its message.updated event.
 * Chat sessions alternate, so the new message normally has the opposite role
 * from the most recent known message.
 */
export function inferStubRole(messages: UIMessage[]): UIMessage["role"] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "user";
  if (lastMessage.role === "user") return "assistant";
  if (lastMessage.role === "assistant") return "user";
  return "assistant";
}

function indexMessageParts(parts: UIMessage["parts"]) {
  const indexById = new Map<string, number>();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const partId = part.type === "dynamic-tool" ? part.toolCallId : getPartMetadataId(part);
    if (partId) indexById.set(partId, index);
  }
  return indexById;
}

/**
 * Apply a frame's coalesced text deltas with one transcript clone and one
 * parts clone per touched message. Message and part indexes are built once,
 * avoiding repeated full-transcript scans in long sessions.
 */
export function applyPendingDeltasToTranscript(
  messages: UIMessage[],
  items: PendingDelta[],
) {
  if (items.length === 0) return { messages, unapplied: new Array<PendingDelta>() };

  let nextMessages = messages;
  const messageIndexById = new Map<string, number>();
  const draftsByMessageId = new Map<string, TranscriptMessageDraft>();
  const partIndexesByMessageId = new Map<string, Map<string, number>>();
  const unapplied: PendingDelta[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message) messageIndexById.set(message.id, index);
  }

  const ensureMessage = (item: PendingDelta) => {
    const knownIndex = messageIndexById.get(item.messageId);
    if (knownIndex !== undefined) return knownIndex;

    if (nextMessages === messages) nextMessages = messages.slice();
    const message: UIMessage = {
      id: item.messageId,
      role: inferStubRole(nextMessages),
      parts: [],
    };
    const index = nextMessages.length;
    nextMessages.push(message);
    messageIndexById.set(item.messageId, index);
    return index;
  };

  const draftMessage = (messageId: string, index: number) => {
    const existingDraft = draftsByMessageId.get(messageId);
    if (existingDraft) return existingDraft;

    const current = nextMessages[index];
    if (!current) return null;
    const parts = current.parts.slice();
    const message = { ...current, parts };
    if (nextMessages === messages) nextMessages = messages.slice();
    nextMessages[index] = message;
    const partIndexById = partIndexesByMessageId.get(messageId) ?? indexMessageParts(parts);
    partIndexesByMessageId.set(messageId, partIndexById);
    const draft = { message, partIndexById };
    draftsByMessageId.set(messageId, draft);
    return draft;
  };

  for (const item of items) {
    const messageIndex = ensureMessage(item);
    const currentMessage = nextMessages[messageIndex];
    if (!currentMessage) {
      unapplied.push(item);
      continue;
    }

    let partIndexById = partIndexesByMessageId.get(item.messageId);
    if (!partIndexById) {
      partIndexById = indexMessageParts(currentMessage.parts);
      partIndexesByMessageId.set(item.messageId, partIndexById);
    }
    const ownerPartIndex = partIndexById.get(item.partId);
    if (ownerPartIndex === undefined) {
      unapplied.push(item);
      continue;
    }

    const draft = draftMessage(item.messageId, messageIndex);
    if (!draft) {
      unapplied.push(item);
      continue;
    }
    const ownerPart = draft.message.parts[ownerPartIndex];
    if (ownerPart?.type === "text" || ownerPart?.type === "reasoning") {
      draft.message.parts[ownerPartIndex] = {
        ...ownerPart,
        text: `${ownerPart.text}${item.delta}`,
        state: "streaming",
      };
      continue;
    }

    const part: UIMessage["parts"][number] = {
      type: "text",
      text: item.delta,
      state: "streaming",
      providerMetadata: { opencode: { partId: item.partId } },
    };
    draft.partIndexById.set(item.partId, draft.message.parts.length);
    draft.message.parts.push(part);
  }

  return { messages: nextMessages, unapplied };
}

export function coalescePendingDeltas(items: PendingDelta[]) {
  if (items.length < 2) return items;

  const ordered: PendingDelta[] = [];
  const byKey = new Map<string, PendingDelta>();
  for (const item of items) {
    const key = `${item.sessionId}\u0000${item.messageId}\u0000${item.partId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.delta += item.delta;
      existing.reasoning = existing.reasoning || item.reasoning;
      continue;
    }

    const next = { ...item };
    byKey.set(key, next);
    ordered.push(next);
  }
  return ordered;
}

export function selectDeltaFlushLane(
  items: PendingDelta[],
  visibleSessionId?: string | null,
): DeltaFlushLane {
  const visible = visibleSessionId?.trim();
  return visible && items.some((item) => item.sessionId === visible)
    ? "foreground"
    : "background";
}

export function partitionPendingDeltasByLane(
  items: PendingDelta[],
  visibleSessionId: string | null | undefined,
  lane: DeltaFlushLane,
) {
  const visible = visibleSessionId?.trim();
  const flushing: PendingDelta[] = [];
  const deferred: PendingDelta[] = [];
  for (const item of items) {
    const itemLane = visible === item.sessionId ? "foreground" : "background";
    if (itemLane === lane) flushing.push(item);
    else deferred.push(item);
  }
  return { flushing, deferred };
}

export function partitionPendingDeltasBySession(items: PendingDelta[], sessionId: string) {
  const flushing: PendingDelta[] = [];
  const deferred: PendingDelta[] = [];
  for (const item of items) {
    if (item.sessionId === sessionId) flushing.push(item);
    else deferred.push(item);
  }
  return { flushing, deferred };
}
