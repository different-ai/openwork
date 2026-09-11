import type { UIMessage } from "ai";

import type { OpenworkSessionHistory } from "../../../../app/lib/openwork-server";
import { mergeSnapshotAndLiveMessages } from "../sync/message-merge";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { parseConnectSkillToken } from "./composer/connect-skill-token";
import { parseSlashCommandInvocation } from "./composer/slash-command";

export function resolveRenderedSessionSnapshot(input: {
  sessionId: string;
  currentSnapshot: OpenworkSessionHistory | null | undefined;
  cachedRendered: { sessionId: string; snapshot: OpenworkSessionHistory } | null | undefined;
}) {
  if (input.currentSnapshot?.session.id === input.sessionId) {
    return input.currentSnapshot;
  }
  if (
    input.cachedRendered?.sessionId === input.sessionId &&
    input.cachedRendered.snapshot.session.id === input.sessionId
  ) {
    return input.cachedRendered.snapshot;
  }
  return null;
}

export type LatestSessionHistory = {
  messages: UIMessage[];
  source: UIMessage[];
};

const historyProjections = new WeakMap<OpenworkSessionHistory["messages"], UIMessage[]>();

export function projectHistoryRead(snapshot: OpenworkSessionHistory) {
  let projected = historyProjections.get(snapshot.messages);
  if (!projected) {
    const messages = snapshot.messages.every(({ info }) => Number.isFinite(info.time?.created))
      ? snapshot.messages.toSorted((left, right) => left.info.time.created - right.info.time.created)
      : snapshot.messages;
    projected = snapshotToUIMessages({ ...snapshot, messages });
    historyProjections.set(snapshot.messages, projected);
  }
  return projected;
}

const historyIndexes = new WeakMap<UIMessage[], Map<string, number>>();
const historyValues = new WeakMap<object, string>();

function historyIndex(messages: UIMessage[]) {
  let index = historyIndexes.get(messages);
  if (!index) {
    index = new Map(messages.map((message, position) => [message.id, position]));
    historyIndexes.set(messages, index);
  }
  return index;
}

function historyValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  let serialized = historyValues.get(value);
  if (serialized === undefined) {
    serialized = JSON.stringify(value);
    historyValues.set(value, serialized);
  }
  return serialized;
}

function sameHistoryValue(left: unknown, right: unknown) {
  return left === right || historyValue(left) === historyValue(right);
}

function historyPartKey(part: UIMessage["parts"][number], index: number) {
  return part.type === "dynamic-tool" ? `tool:${part.toolCallId}` : `${part.type}:${index}`;
}

export function mergeHistoryWindow(history: UIMessage[], updates: UIMessage[]): UIMessage[] {
  if (updates.length === 0) return history;
  const positions = historyIndex(history);
  const unique = [...new Map(updates.map((message) => [message.id, message])).values()];
  const nextPositions = new Map<string, number>();
  let next = history.length;
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const message = unique[index];
    const position = positions.get(message.id);
    if (position !== undefined) next = position;
    else nextPositions.set(message.id, next);
  }
  let result = history;
  const additions = new Map<number, UIMessage[]>();
  let previous = -1;
  for (const message of unique) {
    const position = positions.get(message.id);
    if (position !== undefined) {
      previous = position;
      if (history[position] === message) continue;
      if (result === history) result = history.slice();
      result[position] = message;
    } else {
      const following = nextPositions.get(message.id) ?? history.length;
      const slot = following < history.length ? following : previous >= 0 ? previous + 1 : history.length;
      const bucket = additions.get(slot) ?? [];
      bucket.push(message);
      additions.set(slot, bucket);
    }
  }
  if (additions.size === 0) {
    historyIndexes.set(result, positions);
    return result;
  }
  return result.flatMap((message, index) => [...(additions.get(index) ?? []), message])
    .concat(additions.get(history.length) ?? []);
}

function reconcileHistoryMessage(current: UIMessage, incoming: UIMessage, baseline?: UIMessage) {
  const merged = mergeSnapshotAndLiveMessages([incoming], [current])[0];
  const priorParts = new Map(baseline?.parts.map((part, index) => [historyPartKey(part, index), part]));
  const changes = new Map<string, UIMessage["parts"][number]>();
  current.parts.forEach((part, index) => {
    const key = historyPartKey(part, index);
    if (!sameHistoryValue(part, priorParts.get(key))) changes.set(key, part);
  });
  if (changes.size === 0 && sameHistoryValue(current.metadata, baseline?.metadata)) return merged;
  const next: UIMessage = {
    ...merged,
    metadata: sameHistoryValue(current.metadata, baseline?.metadata) ? merged.metadata : current.metadata,
    parts: merged.parts.map((part, index) => {
      const change = changes.get(historyPartKey(part, index));
      if (!change) return part;
      if ((part.type === "text" || part.type === "reasoning") && change.type === part.type
        && part.text.length > change.text.length) return part;
      return change;
    }),
  };
  return sameHistoryValue(next, current) ? current : next;
}

export function reconcileHistoryRead(current: UIMessage[], incoming: UIMessage[], baseline: UIMessage[] = []) {
  const currentIndex = historyIndex(current);
  const baselineIndex = historyIndex(baseline);
  return mergeHistoryWindow(current, incoming.map((message) => {
    const existing = current[currentIndex.get(message.id) ?? -1];
    return existing ? reconcileHistoryMessage(existing, message, baseline[baselineIndex.get(message.id) ?? -1]) : message;
  }));
}

export function applyHistorySourceChanges(history: LatestSessionHistory, source: UIMessage[]): LatestSessionHistory {
  if (source === history.source) return history;
  const before = historyIndex(history.source);
  const displayed = historyIndex(history.messages);
  const changes = source.flatMap((message) => {
    const previous = history.source[before.get(message.id) ?? -1];
    if (sameHistoryValue(message, previous)) return [];
    const current = history.messages[displayed.get(message.id) ?? -1];
    return [current ? reconcileHistoryMessage(message, current, previous) : message];
  });
  if (source.length === history.source.length && source.every((message, index) => message.id === history.source[index].id)) {
    historyIndexes.set(source, before);
  }
  return { messages: mergeHistoryWindow(history.messages, changes), source };
}

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: OpenworkSessionHistory | null | undefined;
  historyComplete?: boolean;
  latestHistory?: LatestSessionHistory | null;
}) {
  const revertMessageId = input.snapshot?.session.revert?.messageID ?? null;
  // Neither a newest window nor saved neighbors prove their position relative
  // to a revert cursor. Withhold them until the ordered full history arrives.
  if (input.historyComplete === false && revertMessageId) return [];
  const liveMessages = input.transcriptState ?? [];

  if (input.latestHistory && input.historyComplete) {
    return applyRevertCursor(input.latestHistory.messages, revertMessageId);
  }

  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
    ? snapshotToUIMessages(input.snapshot)
    : [];

  // Render the server snapshot as the history floor and layer live stream
  // updates on top. During prompt submission the live cache can briefly contain
  // only the new turn; it must not replace the older persisted transcript.
  const messages = snapshotMessages.length > 0
    ? mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, { appendLiveOnlyMessages: true })
    : liveMessages;

  return applyRevertCursor(messages, revertMessageId);
}

export function deriveComposerHistory(messages: readonly UIMessage[]): string[] {
  const history: string[] = [];
  // Use the reconciled transcript: native projections already exclude synthetic
  // and ignored text, and message identity reconciles snapshots with live sends.
  for (const message of messages) {
    if (message.role !== "user") continue;
    let unsafe = false;
    const text = message.parts.flatMap((part) => {
      if (part.type !== "text") return [];
      const metadata = part.providerMetadata?.opencode;
      const token = metadata && typeof metadata === "object" && "composerToken" in metadata
        ? metadata.composerToken : undefined;
      if (typeof token === "string") {
        const skill = parseConnectSkillToken(token);
        if (skill && part.text === `/${skill.slug}`) return [token];
        unsafe = true;
      }
      // Older labels have no durable skill identity. Never recall them as commands
      // or try to recover that identity from generated model instructions.
      if (parseSlashCommandInvocation(part.text.replace(/\s+/g, " "))) unsafe = true;
      return [part.text];
    }).join("\n").trim();
    if (unsafe) continue;
    if (text && history.at(-1) !== text) history.push(text);
  }
  return history.slice(-50);
}
