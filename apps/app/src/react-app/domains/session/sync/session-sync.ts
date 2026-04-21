import type { UIMessage } from "ai";
import type { Part, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { getReactQueryClient } from "../../../infra/query-client";
import { createClient } from "../../../../app/lib/opencode";
import { normalizeEvent } from "../../../../app/utils";
import type { OpencodeEvent } from "../../../../app/types";
import { snapshotToUIMessages } from "./usechat-adapter";
import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
};

type PendingDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  reasoning: boolean;
  delta: string;
};

type SyncEntry = {
  refs: number;
  dispose: () => void;
  trackedSessionRefs: Map<string, number>;
  pendingDeltas: Map<string, { messageId: string; reasoning: boolean; text: string }>;
  // Coalesce rapid-fire delta events from the SSE stream into one cache
  // commit per animation frame. Without this, a long response produces a
  // setQueryData per token; each triggers a full transcript re-render
  // (~27ms on large sessions) which starves the main thread and looks to
  // the user like the app "freezes after 2 words."
  deltaFlushBuffer: PendingDelta[];
  deltaFlushScheduled: boolean;
};

const idleStatus: SessionStatus = { type: "idle" };
const syncs = new Map<string, SyncEntry>();

export const transcriptKey = (workspaceId: string, sessionId: string) =>
  ["react-session-transcript", workspaceId, sessionId] as const;
export const statusKey = (workspaceId: string, sessionId: string) =>
  ["react-session-status", workspaceId, sessionId] as const;
export const todoKey = (workspaceId: string, sessionId: string) =>
  ["react-session-todos", workspaceId, sessionId] as const;

function syncKey(input: SyncOptions) {
  return `${input.workspaceId}:${input.baseUrl}:${input.openworkToken}`;
}

function isTrackedSession(entry: SyncEntry, sessionId: string) {
  return (entry.trackedSessionRefs.get(sessionId) ?? 0) > 0;
}

function toUIPart(part: Part): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    return {
      type: "text",
      text: typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "file") {
    const file = part as Part & { url?: string; filename?: string; mime?: string };
    if (!file.url) return null;
    return {
      type: "file",
      url: file.url,
      filename: file.filename,
      mediaType: file.mime ?? "application/octet-stream",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "tool") {
    const record = part as Part & { tool?: string; state?: Record<string, unknown> };
    const state = record.state ?? {};
    const toolName = typeof record.tool === "string" ? record.tool : "tool";
    if (typeof state.error === "string" && state.error.trim()) {
      return {
        type: "dynamic-tool",
        toolName,
        toolCallId: part.id,
        state: "output-error",
        input: state.input,
        errorText: state.error,
      };
    }
    if (state.output !== undefined) {
      return {
        type: "dynamic-tool",
        toolName,
        toolCallId: part.id,
        state: "output-available",
        input: state.input,
        output: state.output,
      };
    }
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId: part.id,
      state: "input-available",
      input: state.input,
    };
  }
  if (part.type === "step-start") return { type: "step-start" };
  return null;
}

function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "file") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  return "partId" in metadata ? (metadata as { partId?: string }).partId ?? null : null;
}

function upsertMessage(messages: UIMessage[], next: UIMessage) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? {
          ...message,
          ...next,
          parts: next.parts.length > 0 ? next.parts : message.parts,
        }
      : message,
  );
}

/**
 * When a message.part.updated or message.part.delta event arrives for a
 * messageID we haven't seen a message.updated for yet, we have to stub the
 * message so the part has somewhere to live. The stub's role used to be
 * hard-coded to "assistant", which meant that if part events beat the
 * message.updated event for a *user* turn (a common race during
 * promptAsync), that user message flashed as an assistant-styled block
 * until the real role arrived a tick later.
 *
 * Infer the stub role from the conversation instead. Chat sessions
 * alternate, so the new message is almost always the opposite role of the
 * most recent known message. If the transcript is empty the first message
 * is always the user's.
 */
function inferStubRole(messages: UIMessage[]): UIMessage["role"] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "user";
  if (lastMessage.role === "user") return "assistant";
  if (lastMessage.role === "assistant") return "user";
  return "assistant";
}

function upsertPart(messages: UIMessage[], messageId: string, partId: string, next: UIMessage["parts"][number]) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.parts.findIndex((part) =>
      ("toolCallId" in part && part.toolCallId === partId) || getPartMetadataId(part) === partId,
    );
    if (index === -1) {
      return { ...message, parts: [...message.parts, next] };
    }
    const parts = message.parts.slice();
    parts[index] = next;
    return { ...message, parts };
  });
}

function appendDelta(messages: UIMessage[], messageId: string, partId: string, delta: string, reasoning: boolean) {
  // Fast path: locate the target message by index, only clone that message
  // and its parts array. The previous implementation ran messages.map AND
  // message.parts.map on every delta event, which is O(N * P) per token.
  // For an old session with hundreds of prior messages/parts that allocated
  // thousands of objects per token and crushed the main thread after a
  // handful of tokens.
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) return messages;

  const target = messages[messageIndex]!;
  const lastPart = target.parts[target.parts.length - 1];

  let partIndex = -1;
  for (let i = 0; i < target.parts.length; i++) {
    const part = target.parts[i]!;
    const id = getPartMetadataId(part);
    if (reasoning && part.type === "reasoning") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    } else if (!reasoning && part.type === "text") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    }
  }

  let nextParts: UIMessage["parts"];
  if (partIndex === -1) {
    // No existing matching part — append a fresh one so the delta is not lost.
    const newPart: UIMessage["parts"][number] = reasoning
      ? {
          type: "reasoning",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        }
      : {
          type: "text",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        };
    nextParts = target.parts.slice();
    nextParts.push(newPart);
  } else {
    const existing = target.parts[partIndex]!;
    nextParts = target.parts.slice();
    if (existing.type === "text") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    } else if (existing.type === "reasoning") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    }
  }

  const nextMessages = messages.slice();
  nextMessages[messageIndex] = { ...target, parts: nextParts };
  return nextMessages;
}

function applyEvent(entry: SyncEntry, workspaceId: string, event: OpencodeEvent) {
  const queryClient = getReactQueryClient();

  if (event.type === "session.status") {
    const props = (event.properties ?? {}) as { sessionID?: string; status?: SessionStatus };
    if (!props.sessionID || !props.status) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData(statusKey(workspaceId, props.sessionID), props.status);
    return;
  }

  if (event.type === "todo.updated") {
    const props = (event.properties ?? {}) as { sessionID?: string; todos?: Todo[] };
    if (!props.sessionID || !props.todos) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData(todoKey(workspaceId, props.sessionID), props.todos);
    return;
  }

  if (event.type === "message.updated") {
    const props = (event.properties ?? {}) as { info?: { id?: string; role?: UIMessage["role"] | string; sessionID?: string } };
    const info = props.info;
    if (!info?.id || !info.sessionID || (info.role !== "user" && info.role !== "assistant" && info.role !== "system")) {
      return;
    }
    if (!isTrackedSession(entry, info.sessionID)) return;
    const next = { id: info.id, role: info.role, parts: [] } satisfies UIMessage;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, info.sessionID), (current = []) =>
      upsertMessage(current, next),
    );
    return;
  }

  if (event.type === "message.part.updated") {
    const props = (event.properties ?? {}) as { part?: Part };
    const part = props.part;
    if (!part?.sessionID || !part.messageID) return;
    if (!isTrackedSession(entry, part.sessionID)) return;
    const mapped = toUIPart(part);
    if (!mapped) return;
    const pending = entry.pendingDeltas.get(part.id);
    const seededPart =
      pending && ((mapped.type === "text" && !pending.reasoning) || (mapped.type === "reasoning" && pending.reasoning))
        ? { ...mapped, text: `${mapped.text}${pending.text}`, state: "streaming" as const }
        : mapped;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, part.sessionID), (current = []) => {
      // If we already have this message, keep its role; otherwise infer
      // from the alternation pattern. Only the newly-stubbed case needs
      // the inference — upsertMessage preserves existing role when the
      // stub's role matches what we'd write anyway, and any subsequent
      // message.updated will overwrite both.
      const existing = current.find((m) => m.id === part.messageID);
      const role = existing?.role ?? inferStubRole(current);
      const withMessage = upsertMessage(current, { id: part.messageID, role, parts: [] });
      return upsertPart(withMessage, part.messageID, part.id, seededPart);
    });
    if (pending) entry.pendingDeltas.delete(part.id);
    return;
  }

  if (event.type === "message.part.delta") {
    const props = (event.properties ?? {}) as {
      sessionID?: string;
      messageID?: string;
      partID?: string;
      field?: string;
      delta?: string;
    };
    if (!props.sessionID || !props.messageID || !props.partID || !props.delta) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    // Buffer this delta and let the frame flusher apply all queued deltas
    // for this entry in a single setQueryData call per affected session.
    entry.deltaFlushBuffer.push({
      sessionId: props.sessionID!,
      messageId: props.messageID!,
      partId: props.partID!,
      reasoning: props.field === "reasoning",
      delta: props.delta!,
    });
    scheduleDeltaFlush(entry, workspaceId);
    return;
  }

  if (event.type === "session.idle") {
    const props = (event.properties ?? {}) as { sessionID?: string };
    if (!props.sessionID) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData(statusKey(workspaceId, props.sessionID), idleStatus);
  }
}

function scheduleDeltaFlush(entry: SyncEntry, workspaceId: string) {
  if (entry.deltaFlushScheduled) return;
  entry.deltaFlushScheduled = true;
  const run = () => {
    entry.deltaFlushScheduled = false;
    if (entry.deltaFlushBuffer.length === 0) return;
    flushDeltas(entry, workspaceId);
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(run);
  } else {
    queueMicrotask(run);
  }
}

function flushDeltas(entry: SyncEntry, workspaceId: string) {
  const queryClient = getReactQueryClient();
  const pending = entry.deltaFlushBuffer;
  entry.deltaFlushBuffer = [];

  // Group by session id so each transcript cache is touched at most once
  // per flush.
  const bySession = new Map<string, PendingDelta[]>();
  for (const item of pending) {
    const bucket = bySession.get(item.sessionId);
    if (bucket) bucket.push(item);
    else bySession.set(item.sessionId, [item]);
  }

  for (const [sessionId, items] of bySession) {
    queryClient.setQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
      (current = []) => {
        let next = current;
        // Track which message shells we've ensured exist this flush so we
        // don't call upsertMessage for the same message on every delta.
        const ensuredMessageIds = new Set<string>();
        for (const item of items) {
          if (!ensuredMessageIds.has(item.messageId)) {
            // Preserve the existing role if the message is already in
            // state; otherwise infer it from the alternation pattern
            // so the brief "stub before message.updated" window doesn't
            // mislabel the message's bubble style.
            const existing = next.find((m) => m.id === item.messageId);
            const role = existing?.role ?? inferStubRole(next);
            next = upsertMessage(next, { id: item.messageId, role, parts: [] });
            ensuredMessageIds.add(item.messageId);
          }
          next = appendDelta(next, item.messageId, item.partId, item.delta, item.reasoning);
          // If the delta landed on a synthetic "no matching part" case, keep
          // the text so a later message.part.updated event can stitch it.
          const message = next.find((m) => m.id === item.messageId);
          const matched = message?.parts.some((part) =>
            (part.type === "dynamic-tool" && part.toolCallId === item.partId) ||
              getPartMetadataId(part) === item.partId,
          );
          if (!matched) {
            const existing = entry.pendingDeltas.get(item.partId) ?? {
              messageId: item.messageId,
              reasoning: item.reasoning,
              text: "",
            };
            existing.text += item.delta;
            entry.pendingDeltas.set(item.partId, existing);
          }
        }
        return next;
      },
    );
  }
}

function startSync(input: SyncOptions) {
  const client = createClient(input.baseUrl, undefined, { token: input.openworkToken, mode: "openwork" });
  const controller = new AbortController();
  const entry = syncs.get(syncKey(input));

  void client.event.subscribe(undefined, { signal: controller.signal }).then((sub) => {
    void (async () => {
      for await (const raw of sub.stream) {
        if (controller.signal.aborted) return;
        const event = normalizeEvent(raw);
        if (!event) continue;
        if (!entry) continue;
        applyEvent(entry, input.workspaceId, event);
      }
    })();
  });

  return () => controller.abort();
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    existing.refs += 1;
    return () => releaseWorkspaceSessionSync(input);
  }

  syncs.set(key, {
    refs: 1,
    dispose: () => {},
    trackedSessionRefs: new Map(),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });

  const created = syncs.get(key)!;
  created.dispose = startSync(input);

  return () => releaseWorkspaceSessionSync(input);
}

function releaseWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs > 0) return;
  // Immediate disposal is important here: a single OpenCode runtime is shared
  // across local workspaces, and keeping old workspace subscriptions alive for
  // 10s means rapid workspace switches accumulate multiple parallel event
  // streams. Under larger transcripts that duplicates cache writes and can make
  // the UI feel frozen after a handful of switches.
  existing.dispose();
  syncs.delete(key);
}

export function seedSessionState(workspaceId: string, snapshot: OpenworkSessionSnapshot) {
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incoming = snapshotToUIMessages(snapshot);
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  if (existing && existing.length > 0 && (snapshot.status.type === "busy" || snapshot.status.type === "retry")) {
    // During active streaming the server snapshot may have empty/stale text
    // for in-progress parts while the cache already accumulated text via
    // deltas.  Merge so we never overwrite longer cached text with shorter
    // server text.
    const merged = incoming.map((incomingMsg) => {
      const cachedMsg = existing.find((m) => m.id === incomingMsg.id);
      if (!cachedMsg) return incomingMsg;
      const parts = incomingMsg.parts.map((inPart, index) => {
        const cachedPart = cachedMsg.parts[index];
        if (!cachedPart) return inPart;
        if (
          (inPart.type === "text" || inPart.type === "reasoning") &&
          (cachedPart.type === "text" || cachedPart.type === "reasoning") &&
          cachedPart.text.length > inPart.text.length
        ) {
          return { ...inPart, text: cachedPart.text };
        }
        return inPart;
      });
      // Keep any extra cached parts the server doesn't know about yet
      if (cachedMsg.parts.length > incomingMsg.parts.length) {
        for (let i = incomingMsg.parts.length; i < cachedMsg.parts.length; i++) {
          parts.push(cachedMsg.parts[i]);
        }
      }
      return { ...incomingMsg, parts };
    });
    queryClient.setQueryData(key, merged);
  } else {
    queryClient.setQueryData(key, incoming);
  }

  queryClient.setQueryData(statusKey(workspaceId, snapshot.session.id), snapshot.status);
  queryClient.setQueryData(todoKey(workspaceId, snapshot.session.id), snapshot.todos);
}

export function trackWorkspaceSessionSync(input: SyncOptions, sessionId: string | null | undefined) {
  const normalizedSessionId = sessionId?.trim() ?? "";
  if (!normalizedSessionId) return () => {};

  const entry = syncs.get(syncKey(input));
  if (!entry) return () => {};

  entry.trackedSessionRefs.set(
    normalizedSessionId,
    (entry.trackedSessionRefs.get(normalizedSessionId) ?? 0) + 1,
  );

  return () => {
    const current = entry.trackedSessionRefs.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
      entry.trackedSessionRefs.delete(normalizedSessionId);
      entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
        (item) => item.sessionId !== normalizedSessionId,
      );
      const queryClient = getReactQueryClient();
      queryClient.removeQueries({ queryKey: transcriptKey(input.workspaceId, normalizedSessionId), exact: true });
      queryClient.removeQueries({ queryKey: statusKey(input.workspaceId, normalizedSessionId), exact: true });
      queryClient.removeQueries({ queryKey: todoKey(input.workspaceId, normalizedSessionId), exact: true });
      return;
    }
    entry.trackedSessionRefs.set(normalizedSessionId, current - 1);
  };
}
