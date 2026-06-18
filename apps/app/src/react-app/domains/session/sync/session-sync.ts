import type { UIMessage } from "ai";
import type { FilePart, Part, PermissionRequest, PermissionV2Request, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { getReactQueryClient } from "../../../infra/query-client";
import { captureAnalyticsEvent, takeTaskRunStart } from "@/app/lib/analytics";
import { trackTaskCompleted, trackTaskFailed } from "@/app/lib/den-telemetry";
import { createClient } from "@/app/lib/opencode";
import { normalizeEvent } from "@/app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX, type OpencodeEvent, type PendingPermission, type PendingQuestion } from "@/app/types";
import { createSessionErrorUIMessage, describeOpencodeSessionError, snapshotToUIMessages } from "./usechat-adapter";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";
import type { OpenworkSessionSnapshot } from "@/app/lib/openwork-server";
import { applyRevertCursor, reconcileTranscriptMessages } from "./transcript-reconcile";
import {
  useSessionActivityStore,
} from "../status/session-activity-store";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

type PendingDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  reasoning: boolean;
  delta: string;
};

type SyncEntry = {
  input: SyncOptions;
  refs: number;
  dispose: () => void;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  trackedSessionRefs: Map<string, number>;
  retainedSessionTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionUpdatedListeners: Set<NonNullable<SyncOptions["onSessionUpdated"]>>;
  sessionStatusListeners: Set<NonNullable<SyncOptions["onSessionStatus"]>>;
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
const retainedSessionTtlMs = 10 * 60_000;
const idleRetainedSessionTtlMs = 10_000;

export const snapshotKey = (workspaceId: string, sessionId: string) =>
  ["react-session-snapshot", workspaceId, sessionId] as const;
export const transcriptKey = (workspaceId: string, sessionId: string) =>
  ["react-session-transcript", workspaceId, sessionId] as const;
export const statusKey = (workspaceId: string, sessionId: string) =>
  ["react-session-status", workspaceId, sessionId] as const;
export const todoKey = (workspaceId: string, sessionId: string) =>
  ["react-session-todos", workspaceId, sessionId] as const;
export const permissionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-permissions", workspaceId, sessionId] as const;
export const questionKey = (workspaceId: string, sessionId: string) =>
  ["react-session-questions", workspaceId, sessionId] as const;

function syncKey(input: SyncOptions) {
  return `${input.workspaceId}:${input.baseUrl}:${input.openworkToken}`;
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown };
  };
  const status = record.status ?? record.response?.status ?? record.cause?.status;
  return typeof status === "number" ? status : null;
}

function shouldRetrySyncSubscribe(error: unknown) {
  const status = getErrorStatus(error);
  return status !== 401 && status !== 403 && status !== 404;
}

function isTrackedSession(entry: SyncEntry, sessionId: string) {
  return (entry.trackedSessionRefs.get(sessionId) ?? 0) > 0 || entry.retainedSessionTimers.has(sessionId);
}

function getSessionUpdatedInfo(event: OpencodeEvent) {
  if (event.type !== "session.updated") return null;
  const props = event.properties;
  if (!props || typeof props !== "object") return null;
  const record = props as { sessionID?: unknown; info?: unknown };
  const info = record.info;
  if (!info || typeof info !== "object") return null;
  const sessionId = typeof record.sessionID === "string"
    ? record.sessionID
    : typeof (info as { id?: unknown }).id === "string"
      ? (info as { id: string }).id
      : "";
  if (!sessionId) return null;
  return { sessionId, info: info as Record<string, unknown> };
}

function isLiveStatus(status: SessionStatus | null | undefined) {
  return status?.type === "busy" || status?.type === "retry";
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function assistantOutputAfterLatestUser(messages: UIMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).some(messageHasVisibleAssistantOutput);
}

function sessionIdFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return "";
  const sessionID = (properties as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? sessionID : "";
}

function sessionErrorFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined;
  return (properties as { error?: unknown }).error;
}

function latestAssistantMessageId(messages: UIMessage[]) {
  // The snapshot keys each error to its errored assistant message id, so the
  // live event must resolve to that same id to dedupe on reload. Skipping
  // synthetic error messages ensures a follow-up error keys off the real
  // assistant turn rather than overwriting the previous error message.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)) continue;
    return message.id;
  }
  return null;
}

function partHasVisibleAssistantOutput(part: Part) {
  if (part.type === "text" && part.synthetic) return false;
  if (part.type === "text" && part.ignored) return false;
  const partType = String(part.type);
  if ("text" in part && typeof part.text === "string" && part.text.trim().length > 0) return true;
  return partType === "tool" || partType === "file" || partType === "agent";
}

function clearTrackedSession(input: SyncOptions, entry: SyncEntry, sessionId: string) {
  entry.trackedSessionRefs.delete(sessionId);
  const retainedTimer = entry.retainedSessionTimers.get(sessionId);
  if (retainedTimer) clearTimeout(retainedTimer);
  entry.retainedSessionTimers.delete(sessionId);
  entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
    (item) => item.sessionId !== sessionId,
  );
  const queryClient = getReactQueryClient();
  queryClient.removeQueries({ queryKey: permissionKey(input.workspaceId, sessionId), exact: true });
  if (entry.refs <= 0 && entry.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(syncKey(input), entry);
  }
}

function retainSession(input: SyncOptions, entry: SyncEntry, sessionId: string, ttlMs = retainedSessionTtlMs) {
  const existing = entry.retainedSessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  entry.retainedSessionTimers.set(sessionId, setTimeout(() => {
    clearTrackedSession(input, entry, sessionId);
  }, ttlMs));
}

function disposeWorkspaceSync(key: string, entry: SyncEntry) {
  if (entry.refs > 0) return;
  if (entry.disposeTimer) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
  entry.retainedSessionTimers.clear();
  entry.dispose();
  if (syncs.get(key) === entry) syncs.delete(key);
}

function releaseRetainedSessionSoon(input: SyncOptions, entry: SyncEntry, sessionId: string) {
  if (!entry.retainedSessionTimers.has(sessionId)) return;
  retainSession(input, entry, sessionId, idleRetainedSessionTtlMs);
}

type PermissionSeed = PermissionRequest | PermissionV2Request;

function isV2PermissionRequest(permission: PermissionSeed): permission is PermissionV2Request {
  return "action" in permission;
}

function legacyPermissionWithReceivedAt(permission: PermissionRequest, receivedAt: number): PendingPermission {
  return { ...permission, receivedAt, protocol: "legacy" };
}

function v2PermissionKind(action: string): string {
  if (action === "external_directory") return "external_directory";
  if (action.endsWith(".external_directory")) return "external_directory";
  if (action === "file.read") return "read";
  if (action === "file.edit" || action === "file.write") return "edit";
  return action;
}

function v2PermissionWithReceivedAt(permission: PermissionV2Request, receivedAt: number): PendingPermission {
  const metadata: Record<string, unknown> = {
    ...(permission.metadata ?? {}),
    action: permission.action,
  };
  if (permission.save?.length) metadata.save = permission.save.join(", ");
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    permission: v2PermissionKind(permission.action),
    patterns: permission.resources,
    metadata,
    always: permission.save ?? [],
    ...(permission.source ? { tool: { messageID: permission.source.messageID, callID: permission.source.callID } } : {}),
    receivedAt,
    protocol: "v2",
    v2: {
      action: permission.action,
      resources: permission.resources,
      ...(permission.save ? { save: permission.save } : {}),
    },
  };
}

function permissionWithReceivedAt(permission: PermissionSeed, receivedAt: number): PendingPermission {
  return isV2PermissionRequest(permission)
    ? v2PermissionWithReceivedAt(permission, receivedAt)
    : legacyPermissionWithReceivedAt(permission, receivedAt);
}

function questionWithReceivedAt(question: QuestionRequest, receivedAt: number): PendingQuestion {
  return { ...question, receivedAt };
}

function sortPermissions(a: PendingPermission, b: PendingPermission) {
  return a.receivedAt - b.receivedAt || a.id.localeCompare(b.id);
}

function sortQuestions(a: PendingQuestion, b: PendingQuestion) {
  return a.receivedAt - b.receivedAt || a.id.localeCompare(b.id);
}

export function seedPermissionState(
  workspaceId: string,
  sessionId: string,
  permissions: PermissionSeed[],
  options: { snapshotStartedAt?: number } = {},
) {
  useSessionActivityStore.getState().replaceWaitingRequests(
    workspaceId,
    sessionId,
    "permission",
    permissions.flatMap((permission) => permission.sessionID === sessionId ? [permission.id] : []),
  );
  const queryClient = getReactQueryClient();
  const now = Date.now();
  queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, sessionId), (current = []) => {
    const receivedAtById = new Map(current.map((permission) => [permission.id, permission.receivedAt]));
    const seeded = permissions.flatMap((permission) =>
      permission.sessionID === sessionId ? [permissionWithReceivedAt(permission, receivedAtById.get(permission.id) ?? now)] : [],
    );
    const seededIds = new Set(seeded.map((permission) => permission.id));
    const snapshotStartedAt = options.snapshotStartedAt;
    const liveAfterSnapshot =
      typeof snapshotStartedAt === "number"
        ? current.filter(
            (permission) =>
              permission.sessionID === sessionId &&
              permission.receivedAt > snapshotStartedAt &&
              !seededIds.has(permission.id),
          )
        : [];
    return [...seeded, ...liveAfterSnapshot].sort(sortPermissions);
  });
}

export function seedQuestionState(
  workspaceId: string,
  sessionId: string,
  questions: QuestionRequest[],
  options: { snapshotStartedAt?: number } = {},
) {
  useSessionActivityStore.getState().replaceWaitingRequests(
    workspaceId,
    sessionId,
    "question",
    questions.flatMap((question) => question.sessionID === sessionId ? [question.id] : []),
  );
  const queryClient = getReactQueryClient();
  const now = Date.now();
  queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId), (current = []) => {
    const receivedAtById = new Map(current.map((question) => [question.id, question.receivedAt]));
    const seeded = questions.flatMap((question) =>
      question.sessionID === sessionId ? [questionWithReceivedAt(question, receivedAtById.get(question.id) ?? now)] : [],
    );
    const seededIds = new Set(seeded.map((question) => question.id));
    const snapshotStartedAt = options.snapshotStartedAt;
    const liveAfterSnapshot =
      typeof snapshotStartedAt === "number"
        ? current.filter(
            (question) =>
              question.sessionID === sessionId &&
              question.receivedAt > snapshotStartedAt &&
              !seededIds.has(question.id),
          )
        : [];
    return [...seeded, ...liveAfterSnapshot].sort(sortQuestions);
  });
}

function fileProviderMetadata(part: FilePart) {
  if (part.source) {
    return { opencode: { partId: part.id, source: part.source } };
  }
  return { opencode: { partId: part.id } };
}

function toFileUIPart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function toFileSourceUIPart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = { opencode: { partId: sourceId, sourcePartId: part.id, source } };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    if (source.uri.startsWith("https://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.uri, providerMetadata };
  }

  if (source.type === "symbol") {
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.name, filename: source.path, providerMetadata };
  }

  return { type: "source-document", sourceId, mediaType: part.mime, title: source.path, filename: source.path, providerMetadata };
}

function toFileUIParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = toFileSourceUIPart(part);
  if (sourcePart) return [toFileUIPart(part), sourcePart];
  return [toFileUIPart(part)];
}

function toUIPart(part: Part): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    if (part.synthetic || part.ignored) return null;
    return {
      type: "text",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "file") {
    return toFileUIPart(part);
  }
  if (part.type === "tool") {
    if (part.tool === STRUCTURED_OUTPUT_TOOL) {
      return parseStructuredOutputUIPart(part);
    }
    return parseDynamicToolUIPart(part);
  }
  if (part.type === "agent") {
    return {
      type: "text",
      text: part.name ? `@${part.name}` : "@agent",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "step-start") return { type: "step-start" };
  return null;
}

function toUIParts(part: Part): UIMessage["parts"] {
  if (part.type === "file") return toFileUIParts(part);
  const mapped = toUIPart(part);
  if (!mapped) return [];
  if (part.type === "tool" && part.tool === STRUCTURED_OUTPUT_TOOL) return [mapped];
  if (part.type === "tool" && part.state.status === "completed" && part.state.attachments) {
    return [mapped, ...part.state.attachments.flatMap(toFileUIParts)];
  }
  return [mapped];
}

function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type === "dynamic-tool") {
    const metadata = part.callProviderMetadata?.opencode;
    if (!metadata || typeof metadata !== "object") return null;
    return "partId" in metadata ? (metadata as { partId?: string }).partId ?? null : null;
  }
  if (part.type !== "text" && part.type !== "reasoning" && part.type !== "file" && part.type !== "source-url" && part.type !== "source-document") return null;
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

function applyEvent(entry: SyncEntry, workspaceId: string, event: OpencodeEvent) {
  const queryClient = getReactQueryClient();
  const input = entry.input;

  if (event.type === "session.updated") {
    const update = getSessionUpdatedInfo(event);
    if (!update) return;
    if (!isTrackedSession(entry, update.sessionId)) return;
    // Keep the cached snapshot's revert cursor in sync with the server. The
    // renderer derives the visible transcript from this cursor, so a revert
    // (or its cleanup on the next prompt) must reach the snapshot cache or
    // the transcript stays frozen on stale history.
    queryClient.setQueryData<OpenworkSessionSnapshot>(
      snapshotKey(workspaceId, update.sessionId),
      (current) => {
        if (!current) return current;
        const revert = (update.info as { revert?: OpenworkSessionSnapshot["session"]["revert"] }).revert;
        return { ...current, session: { ...current.session, revert } };
      },
    );
    for (const listener of entry.sessionUpdatedListeners) listener(update);
    return;
  }

  if (event.type === "session.deleted") {
    const props = (event.properties ?? {}) as { sessionID?: string; info?: { id?: string } };
    const sessionId = props.sessionID ?? props.info?.id ?? "";
    if (sessionId) useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    return;
  }

  if (event.type === "session.error") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (sessionId) {
      const errorText = describeOpencodeSessionError(sessionErrorFromProperties(event.properties));
      const runStartedAt = takeTaskRunStart(sessionId);
      if (runStartedAt !== null) {
        captureAnalyticsEvent("task_run_errored", {
          duration_ms: Date.now() - runStartedAt,
        });
        trackTaskFailed(sessionId, Date.now() - runStartedAt);
      }
      useSessionActivityStore.getState().setError(workspaceId, sessionId, errorText);
      if (isTrackedSession(entry, sessionId)) {
        queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId), (current = []) => {
          // Key the error to the latest assistant turn so it lands beside the
          // turn that failed and a later turn's error becomes its own message
          // instead of overwriting this one. Falls back to the session id when
          // no assistant turn exists yet (e.g. error before any output).
          const turnKey = latestAssistantMessageId(current) ?? sessionId;
          // Note: turnKey matches the snapshot's per-turn key (the errored
          // assistant message id) so a reload reconciles instead of
          // duplicating; the sessionId fallback only applies when the run
          // errored before any assistant message existed.
          return upsertMessage(current, createSessionErrorUIMessage(turnKey, errorText));
        });
      }
    }
    return;
  }

  if (event.type === "session.next.compaction.started") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (sessionId) useSessionActivityStore.getState().setCompacting(workspaceId, sessionId, true);
    return;
  }

  if (event.type === "session.next.compaction.ended" || event.type === "session.compacted") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (sessionId) useSessionActivityStore.getState().setCompacting(workspaceId, sessionId, false);
    return;
  }

  if (event.type === "session.status") {
    const props = (event.properties ?? {}) as { sessionID?: string; status?: SessionStatus };
    if (!props.sessionID || !props.status) return;
    useSessionActivityStore.getState().setRunStatus(workspaceId, props.sessionID, props.status);
    const tracked = isTrackedSession(entry, props.sessionID);
    if (tracked) queryClient.setQueryData(statusKey(workspaceId, props.sessionID), props.status);
    for (const listener of entry.sessionStatusListeners) listener({ sessionId: props.sessionID, status: props.status });
    if (input && tracked && !isLiveStatus(props.status)) releaseRetainedSessionSoon(input, entry, props.sessionID);
    return;
  }

  if (event.type === "todo.updated") {
    const props = (event.properties ?? {}) as { sessionID?: string; todos?: Todo[] };
    if (!props.sessionID || !props.todos) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData(todoKey(workspaceId, props.sessionID), props.todos);
    return;
  }

  if (event.type === "permission.asked") {
    const permission = event.properties as PermissionRequest;
    if (!permission?.id || !permission.sessionID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, permission.sessionID, "permission", permission.id, true);
    if (!isTrackedSession(entry, permission.sessionID)) return;
    const receivedAt = Date.now();
    queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, permission.sessionID), (current = []) => {
      const existing = current.find((item) => item.id === permission.id);
      const next = permissionWithReceivedAt(permission, existing?.receivedAt ?? receivedAt);
      if (existing) {
        return current.map((item) => (item.id === permission.id ? next : item)).sort(sortPermissions);
      }
      return [...current, next].sort(sortPermissions);
    });
    return;
  }

  if (event.type === "permission.v2.asked") {
    const permission = event.properties as PermissionV2Request;
    if (!permission?.id || !permission.sessionID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, permission.sessionID, "permission", permission.id, true);
    if (!isTrackedSession(entry, permission.sessionID)) return;
    const receivedAt = Date.now();
    queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, permission.sessionID), (current = []) => {
      const existing = current.find((item) => item.id === permission.id);
      const next = permissionWithReceivedAt(permission, existing?.receivedAt ?? receivedAt);
      if (existing) {
        return current.map((item) => (item.id === permission.id ? next : item)).sort(sortPermissions);
      }
      return [...current, next].sort(sortPermissions);
    });
    return;
  }

  if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
    const props = (event.properties ?? {}) as { sessionID?: string; requestID?: string };
    if (!props.sessionID || !props.requestID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, props.sessionID, "permission", props.requestID, false);
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData<PendingPermission[]>(permissionKey(workspaceId, props.sessionID), (current = []) =>
      current.filter((permission) => permission.id !== props.requestID),
    );
    return;
  }

  if (event.type === "question.asked") {
    const question = event.properties as QuestionRequest;
    if (!question?.id || !question.sessionID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, question.sessionID, "question", question.id, true);
    if (!isTrackedSession(entry, question.sessionID)) return;
    const receivedAt = Date.now();
    queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, question.sessionID), (current = []) => {
      const existing = current.find((item) => item.id === question.id);
      const next = questionWithReceivedAt(question, existing?.receivedAt ?? receivedAt);
      if (existing) {
        return current.map((item) => (item.id === question.id ? next : item)).sort(sortQuestions);
      }
      return [...current, next].sort(sortQuestions);
    });
    return;
  }

  if (event.type === "question.replied" || event.type === "question.rejected") {
    const props = (event.properties ?? {}) as { sessionID?: string; requestID?: string };
    if (!props.sessionID || !props.requestID) return;
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, props.sessionID, "question", props.requestID, false);
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData<PendingQuestion[]>(questionKey(workspaceId, props.sessionID), (current = []) =>
      current.filter((question) => question.id !== props.requestID),
    );
    return;
  }

  if (event.type === "message.updated") {
    const props = (event.properties ?? {}) as {
      info?: { id?: string; role?: UIMessage["role"] | string; sessionID?: string; time?: { created?: number } };
    };
    const info = props.info;
    if (!info?.id || !info.sessionID || (info.role !== "user" && info.role !== "assistant" && info.role !== "system")) {
      return;
    }
    useSessionActivityStore.getState().markMessageRole(workspaceId, info.sessionID, info.id, info.role);
    if (!isTrackedSession(entry, info.sessionID)) return;
    const created = info.time?.created;
    const next = {
      id: info.id,
      role: info.role,
      ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
      parts: [],
    } satisfies UIMessage;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, info.sessionID), (current = []) =>
      upsertMessage(current, next),
    );
    return;
  }

  if (event.type === "message.removed") {
    // Revert cleanup (and explicit message deletion) removes messages
    // server-side; drop them from both the live transcript cache and the
    // cached snapshot so they can't be resurrected by later merges.
    const props = (event.properties ?? {}) as { sessionID?: string; messageID?: string };
    if (!props.sessionID || !props.messageID) return;
    if (!isTrackedSession(entry, props.sessionID)) return;
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, props.sessionID), (current = []) =>
      current.filter((message) => message.id !== props.messageID),
    );
    queryClient.setQueryData<OpenworkSessionSnapshot>(
      snapshotKey(workspaceId, props.sessionID),
      (current) => {
        if (!current) return current;
        return { ...current, messages: current.messages.filter((message) => message.info.id !== props.messageID) };
      },
    );
    return;
  }

  if (event.type === "message.part.updated") {
    const props = (event.properties ?? {}) as { part?: Part };
    const part = props.part;
    if (!part?.sessionID || !part.messageID) return;
    if (partHasVisibleAssistantOutput(part)) {
      useSessionActivityStore.getState().markAssistantOutput(workspaceId, part.sessionID, part.messageID);
    }
    if (!isTrackedSession(entry, part.sessionID)) return;
    const [mapped, ...attachments] = toUIParts(part);
    if (!mapped) return;
    const pending = entry.pendingDeltas.get(part.id);
    // Seed the new part with any deltas that arrived before this
    // declaration. We deliberately ignore `pending.reasoning` — it
    // can't be trusted because opencode emits `field: "text"` for
    // both text and reasoning streams. The part's actual kind
    // (`mapped.type`) is the source of truth.
    //
    // Both `pending.text` and `mapped.text` are cumulative views of the
    // same stream, so we keep whichever is longer instead of
    // concatenating (concatenation double-counts the bytes that landed
    // in both). Without this, reasoning text shows up duplicated in the
    // streaming UI.
    const seededPart =
      pending && (mapped.type === "text" || mapped.type === "reasoning")
        ? {
            ...mapped,
            text: pending.text.length > mapped.text.length ? pending.text : mapped.text,
            state: "streaming" as const,
          }
        : mapped;
    // Drop any deltas for this partID still queued in the rAF flush
    // buffer — they've already been incorporated into `mapped.text`.
    // Without this, the rAF flush would re-append them on top of the
    // cumulative text we just wrote, duplicating bytes mid-stream.
    if (entry.deltaFlushBuffer.length > 0) {
      entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
        (item) => item.partId !== part.id,
      );
    }
    queryClient.setQueryData<UIMessage[]>(transcriptKey(workspaceId, part.sessionID), (current = []) => {
      // If we already have this message, keep its role; otherwise infer
      // from the alternation pattern. Only the newly-stubbed case needs
      // the inference — upsertMessage preserves existing role when the
      // stub's role matches what we'd write anyway, and any subsequent
      // message.updated will overwrite both.
      const existing = current.find((m) => m.id === part.messageID);
      const role = existing?.role ?? inferStubRole(current);
      const withMessage = upsertMessage(current, { id: part.messageID, role, parts: [] });
      const seededPartId = getPartMetadataId(seededPart) ?? part.id;
      let next = upsertPart(withMessage, part.messageID, seededPartId, seededPart);
      for (const attachment of attachments) {
        const attachmentId = getPartMetadataId(attachment);
        if (attachmentId) next = upsertPart(next, part.messageID, attachmentId, attachment);
      }
      return next;
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
    useSessionActivityStore.getState().markAssistantOutput(workspaceId, props.sessionID, props.messageID, { allowUnknownMessageRole: true });
    if (!isTrackedSession(entry, props.sessionID)) return;
    // Note: we do NOT trust `props.field` to disambiguate reasoning vs
    // text. Opencode emits `field: "text"` for both kinds; the actual
    // distinction lives on the part's `type`, which we only see via
    // `message.part.updated`. The flusher resolves the kind at apply
    // time, falling back to `pendingDeltas` if the part hasn't been
    // declared yet.
    entry.deltaFlushBuffer.push({
      sessionId: props.sessionID!,
      messageId: props.messageID!,
      partId: props.partID!,
      reasoning: false,
      delta: props.delta!,
    });
    scheduleDeltaFlush(entry, workspaceId);
    return;
  }

  if (event.type === "session.idle") {
    const props = (event.properties ?? {}) as { sessionID?: string };
    if (!props.sessionID) return;
    // Only emits for runs this client instrumented (markTaskRunStart in the
    // send path); also dedupes idle events from multiple workspace syncs.
    const runStartedAt = takeTaskRunStart(props.sessionID);
    if (runStartedAt !== null) {
      captureAnalyticsEvent("task_run_completed", {
        duration_ms: Date.now() - runStartedAt,
      });
      trackTaskCompleted(props.sessionID, Date.now() - runStartedAt);
    }
    useSessionActivityStore.getState().setRunStatus(workspaceId, props.sessionID, idleStatus);
    const tracked = isTrackedSession(entry, props.sessionID);
    if (tracked) queryClient.setQueryData(statusKey(workspaceId, props.sessionID), idleStatus);
    for (const listener of entry.sessionStatusListeners) listener({ sessionId: props.sessionID, status: idleStatus });
    if (input && tracked) releaseRetainedSessionSoon(input, entry, props.sessionID);
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
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  ) {
    window.requestAnimationFrame(run);
  } else if (typeof window !== "undefined") {
    window.setTimeout(run, 50);
  } else {
    queueMicrotask(run);
  }
}

function flushDeltas(entry: SyncEntry, workspaceId: string) {
  const queryClient = getReactQueryClient();
  const pending = coalescePendingDeltas(entry.deltaFlushBuffer);
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
        const nextById = new Map(next.map((message) => [message.id, message]));
        // Track which message shells we've ensured exist this flush so we
        // don't call upsertMessage for the same message on every delta.
        const ensuredMessageIds = new Set<string>();
        for (const item of items) {
          if (!ensuredMessageIds.has(item.messageId)) {
            // Preserve the existing role if the message is already in
            // state; otherwise infer it from the alternation pattern
            // so the brief "stub before message.updated" window doesn't
            // mislabel the message's bubble style.
            const existing = nextById.get(item.messageId);
            const role = existing?.role ?? inferStubRole(next);
            const ensuredMessage = { id: item.messageId, role, parts: existing?.parts ?? [] };
            next = upsertMessage(next, ensuredMessage);
            nextById.set(item.messageId, ensuredMessage);
            ensuredMessageIds.add(item.messageId);
          }
          // Resolve the part kind from the transcript instead of trusting
          // the inbound delta event (opencode emits `field: "text"` for
          // both text and reasoning parts). If the part hasn't been
          // declared yet via `message.part.updated`, defer the delta into
          // `entry.pendingDeltas` so the part can be created with the
          // correct kind later. Without this, every delta lands as a text
          // part — and reasoning content leaks into the response markdown
          // until the next reload reconstructs the transcript from the
          // snapshot.
          const ownerMessage = nextById.get(item.messageId);
          const ownerPartsById = new Map(
            (ownerMessage?.parts ?? []).flatMap((part) => {
              const id = part.type === "dynamic-tool" ? part.toolCallId : getPartMetadataId(part);
              return id ? [[id, part] as const] : [];
            }),
          );
          const ownerPart = ownerPartsById.get(item.partId);

          if (!ownerPart) {
            const existing = entry.pendingDeltas.get(item.partId) ?? {
              messageId: item.messageId,
              reasoning: item.reasoning,
              text: "",
            };
            existing.text += item.delta;
            entry.pendingDeltas.set(item.partId, existing);
            continue;
          }

          const reasoning = ownerPart.type === "reasoning";
          next = appendDelta(next, item.messageId, item.partId, item.delta, reasoning);
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
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let activeConnectionController: AbortController | null = null;
  let lastEventAt = Date.now();
  let retryDelayMs = 1_000;
  const staleStreamMs = 30_000;

  const scheduleRetry = () => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    activeConnectionController = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
  };

  const connect = async () => {
    const connectionController = new AbortController();
    activeConnectionController = connectionController;
    try {
      const sub = await client.event.subscribe(undefined, { signal: connectionController.signal });
      retryDelayMs = 1_000;
      lastEventAt = Date.now();
      for await (const raw of sub.stream) {
        if (controller.signal.aborted || connectionController.signal.aborted) return;
        lastEventAt = Date.now();
        const event = normalizeEvent(raw);
        if (!event) continue;
        if (!entry) continue;
        applyEvent(entry, input.workspaceId, event);
      }
      if (!controller.signal.aborted && activeConnectionController === connectionController) scheduleRetry();
    } catch (error) {
      if (
        !controller.signal.aborted &&
        (connectionController.signal.aborted || shouldRetrySyncSubscribe(error))
      ) {
        scheduleRetry();
      }
    } finally {
      if (activeConnectionController === connectionController) activeConnectionController = null;
    }
  };

  void connect();
  watchdogTimer = setInterval(() => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    const active = activeConnectionController;
    if (!active || active.signal.aborted) return;
    if (Date.now() - lastEventAt < staleStreamMs) return;
    active.abort();
    scheduleRetry();
  }, 10_000);

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    activeConnectionController?.abort();
    controller.abort();
  };
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    if (existing.disposeTimer) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = null;
    }
    if (input.onSessionUpdated) existing.sessionUpdatedListeners.add(input.onSessionUpdated);
    if (input.onSessionStatus) existing.sessionStatusListeners.add(input.onSessionStatus);
    existing.refs += 1;
    return () => releaseWorkspaceSessionSync(input);
  }

  syncs.set(key, {
    input,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionUpdatedListeners: new Set(input.onSessionUpdated ? [input.onSessionUpdated] : []),
    sessionStatusListeners: new Set(input.onSessionStatus ? [input.onSessionStatus] : []),
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
  if (input.onSessionUpdated) existing.sessionUpdatedListeners.delete(input.onSessionUpdated);
  if (input.onSessionStatus) existing.sessionStatusListeners.delete(input.onSessionStatus);
  existing.refs -= 1;
  if (existing.refs > 0) return;
  if (existing.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(key, existing);
  }
}

export function seedSessionState(workspaceId: string, snapshot: OpenworkSessionSnapshot) {
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incoming = snapshotToUIMessages(snapshot);
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  useSessionActivityStore.getState().seedSessionRun(
    workspaceId,
    snapshot.session.id,
    snapshot.status,
    assistantOutputAfterLatestUser(incoming),
  );

  // The snapshot's revert cursor is authoritative: messages at/after it are
  // reverted server-side, so the cache must not keep them alive (a later
  // merge would resurrect them once the server deletes them on next prompt).
  queryClient.setQueryData(key, applyRevertCursor(
    reconcileTranscriptMessages({
      currentMessages: existing ?? [],
      snapshotMessages: incoming,
      reason: "snapshot",
    }),
    snapshot.session.revert?.messageID ?? null,
  ));

  queryClient.setQueryData(statusKey(workspaceId, snapshot.session.id), snapshot.status);
  queryClient.setQueryData(todoKey(workspaceId, snapshot.session.id), snapshot.todos);
}

/**
 * Apply a server-confirmed revert to the local session caches.
 *
 * `session.revert` only reaches the renderer through the snapshot cache, so
 * after a successful `session.revert` call this stamps the returned revert
 * cursor into the cached snapshot, truncates the live transcript cache, and
 * refetches the snapshot to pick up the server's post-revert truth. Without
 * this the UI keeps rendering the old transcript until a full reload.
 */
export function applySessionRevert(workspaceId: string, session: Session) {
  const queryClient = getReactQueryClient();
  const revertMessageId = session.revert?.messageID ?? null;

  queryClient.setQueryData<OpenworkSessionSnapshot>(
    snapshotKey(workspaceId, session.id),
    (current) => (current ? { ...current, session: { ...current.session, revert: session.revert } } : current),
  );
  queryClient.setQueryData<UIMessage[]>(
    transcriptKey(workspaceId, session.id),
    (current = []) => applyRevertCursor(current, revertMessageId),
  );
  void queryClient.invalidateQueries({ queryKey: snapshotKey(workspaceId, session.id) });
}

export function trackWorkspaceSessionSync(input: SyncOptions, sessionId: string | null | undefined) {
  const normalizedSessionId = sessionId?.trim() ?? "";
  if (!normalizedSessionId) return () => {};

  const entry = syncs.get(syncKey(input));
  if (!entry) return () => {};

  const retainedTimer = entry.retainedSessionTimers.get(normalizedSessionId);
  if (retainedTimer) {
    clearTimeout(retainedTimer);
    entry.retainedSessionTimers.delete(normalizedSessionId);
  }

  entry.trackedSessionRefs.set(
    normalizedSessionId,
    (entry.trackedSessionRefs.get(normalizedSessionId) ?? 0) + 1,
  );

  return () => {
    const current = entry.trackedSessionRefs.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
      entry.trackedSessionRefs.delete(normalizedSessionId);
      retainSession(input, entry, normalizedSessionId);
      return;
    }
    entry.trackedSessionRefs.set(normalizedSessionId, current - 1);
  };
}

export function trackWorkspaceSessionsSync(input: SyncOptions, sessionIds: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const releases = sessionIds.flatMap((sessionId) => {
    const id = sessionId?.trim() ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [trackWorkspaceSessionSync(input, id)];
  });
  return () => {
    for (const release of releases) release();
  };
}

export function __createWorkspaceSessionSyncForTest(input: SyncOptions) {
  const key = syncKey(input);
  syncs.set(key, {
    input,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionUpdatedListeners: new Set(),
    sessionStatusListeners: new Set(),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });
  return () => {
    const entry = syncs.get(key);
    if (entry) {
      for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
    }
    syncs.delete(key);
  };
}

export function __hasWorkspaceSessionSyncForTest(input: SyncOptions) {
  return syncs.has(syncKey(input));
}

export function __disposeWorkspaceSessionSyncForTest(input: SyncOptions) {
  const key = syncKey(input);
  const entry = syncs.get(key);
  if (!entry) return;
  entry.refs = 0;
  disposeWorkspaceSync(key, entry);
}

export function __applySessionSyncEventForTest(input: SyncOptions, event: OpencodeEvent) {
  const entry = syncs.get(syncKey(input));
  if (!entry) return;
  applyEvent(entry, input.workspaceId, event);
}
