import type { UIMessage } from "ai";
import { create } from "zustand";
import type { FilePart, Part, PermissionRequest, PermissionV2Request, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { getReactQueryClient } from "../../../infra/query-client";
import { captureAnalyticsEvent, takeTaskRunStart } from "@/app/lib/analytics";
import { trackTaskCompleted, trackTaskFailed } from "@/app/lib/den-telemetry";
import { createClient, unwrap } from "@/app/lib/opencode";
import { perfNow, recordPerfLog } from "@/app/lib/perf-log";
import { isGeneratedSessionTitle } from "@/app/lib/session-title";
import { normalizeEvent } from "@/app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX, type OpencodeEvent, type PendingPermission, type PendingQuestion } from "@/app/types";
import {
  createSessionErrorUIMessage,
  snapshotToUIMessages,
} from "./usechat-adapter";
import {
  describeOpencodeSessionError,
  presentOpencodeSessionError,
} from "./session-error";
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
import { notifyDesktopEvent } from "../../../shell/desktop-notifications";
import { notifyAlert } from "../../../shell/notifications";
import { t } from "@/i18n";
import {
  createSessionTitleRecovery,
  type SessionTitleRecovery,
} from "./session-title-recovery";
import {
  applyPendingDeltasToTranscript,
  coalescePendingDeltas,
  getPartMetadataId,
  inferStubRole,
  partitionPendingDeltasByLane,
  partitionPendingDeltasBySession,
  selectDeltaFlushLane,
  type DeltaFlushLane,
  type PendingDelta,
} from "./session-transcript-deltas";
import { startSyncStreamLifecycle, type SyncStreamPhase } from "./sync-stream-lifecycle";

export { type SyncStreamPhase } from "./sync-stream-lifecycle";
export {
  applyPendingDeltasToTranscript,
  coalescePendingDeltas,
  type DeltaFlushLane,
  type PendingDelta,
} from "./session-transcript-deltas";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
  visibleSessionId?: string | null;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

type ListenerRegistry<Listener> = Map<Listener, number>;

type SyncEntry = {
  input: SyncOptions;
  openworkToken: string;
  // Reattachment can rotate the token after the stream already failed. This
  // hook advances the stream lifecycle's connection generation so a stream
  // parked in auth backoff restarts immediately with the new credential.
  notifyStreamGenerationChanged: (() => void) | null;
  refs: number;
  dispose: () => void;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  trackedSessionRefs: Map<string, number>;
  retainedSessionTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionCreatedListeners: ListenerRegistry<NonNullable<SyncOptions["onSessionCreated"]>>;
  sessionUpdatedListeners: ListenerRegistry<NonNullable<SyncOptions["onSessionUpdated"]>>;
  sessionDeletedListeners: ListenerRegistry<NonNullable<SyncOptions["onSessionDeleted"]>>;
  sessionStatusListeners: ListenerRegistry<NonNullable<SyncOptions["onSessionStatus"]>>;
  pendingDeltas: Map<string, { messageId: string; reasoning: boolean; text: string }>;
  // Coalesce rapid-fire delta events from the SSE stream into one visible
  // cache commit per animation frame. Background transcripts use a slower
  // lane because they have no renderer waiting on token-sized updates.
  deltaFlushBuffer: PendingDelta[];
  deltaFlushLane: DeltaFlushLane | null;
  cancelDeltaFlush: (() => void) | null;
  liveSessionIds: Set<string>;
  statusReconcileTimer: ReturnType<typeof setTimeout> | null;
  statusReconcileAbort: AbortController | null;
  runActiveObservedAt: Map<string, number>;
  assistantMessageCompletedAt: Map<string, number>;
  titleRecovery: SessionTitleRecovery | null;
};

type DeltaFlushScheduler = (
  lane: DeltaFlushLane,
  run: () => void,
) => () => void;

const idleStatus: SessionStatus = { type: "idle" };
const syncs = new Map<string, SyncEntry>();
const sessionSnapshotFetchStarts = new WeakMap<OpenworkSessionSnapshot, number>();
const workspaceSyncDisposeGraceMs = 2_000;
const retainedSessionTtlMs = 10 * 60_000;
const idleRetainedSessionTtlMs = 10_000;
const backgroundDeltaFlushMs = 100;
// OpenCode's own run client polls the authoritative status level every 250ms
// because a transport can keep delivering message events after losing a
// terminal status edge. This is a reconciliation cadence, not a completion
// timeout: elapsed time never marks a task done.
const activeSessionStatusReconcileIntervalMs = 250;

type SessionStatusSource = "stream" | "connect-reconcile" | "active-reconcile";

function developerDiagnosticsEnabled() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("openwork.developerMode") === "1";
  } catch {
    return false;
  }
}

function recordSessionCompletionMark(
  event: string,
  payload: Record<string, unknown>,
) {
  recordPerfLog(developerDiagnosticsEnabled(), "session.completion", event, {
    monotonicMs: Math.round(perfNow() * 100) / 100,
    ...payload,
  });
}

function createListenerRegistry<Listener>(listener?: Listener) {
  const registry: ListenerRegistry<Listener> = new Map();
  if (listener !== undefined) registry.set(listener, 1);
  return registry;
}

// Listener identity is not attachment identity: overlapping route lifecycles
// can reuse one stable callback. Count each owner so an older cleanup cannot
// detach a newer observer from the workspace-scoped task stream.
function retainListener<Listener>(registry: ListenerRegistry<Listener>, listener?: Listener) {
  if (listener === undefined) return;
  registry.set(listener, (registry.get(listener) ?? 0) + 1);
}

function releaseListener<Listener>(registry: ListenerRegistry<Listener>, listener?: Listener) {
  if (listener === undefined) return;
  const owners = registry.get(listener);
  if (owners === undefined) return;
  if (owners <= 1) {
    registry.delete(listener);
    return;
  }
  registry.set(listener, owners - 1);
}

type SyncSubscriptionFactory = (
  baseUrl: string,
  openworkToken: string,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>;

type SessionStatusFetcher = (
  baseUrl: string,
  openworkToken: string,
  signal: AbortSignal,
) => Promise<Record<string, SessionStatus>>;

const defaultSyncSubscriptionFactory: SyncSubscriptionFactory = async (baseUrl, openworkToken, signal) => {
  const client = createClient(baseUrl, undefined, { token: openworkToken, mode: "openwork" });
  const subscription = await client.event.subscribe(undefined, { signal });
  return subscription.stream;
};

const defaultSessionStatusFetcher: SessionStatusFetcher = async (baseUrl, openworkToken, signal) => {
  const client = createClient(baseUrl, undefined, { token: openworkToken, mode: "openwork" });
  const result = await client.session.status(undefined, { signal });
  if (result.data !== undefined) return result.data;
  throw result.error;
};

let syncSubscriptionFactory = defaultSyncSubscriptionFactory;
let sessionStatusFetcher = defaultSessionStatusFetcher;

const defaultDeltaFlushScheduler: DeltaFlushScheduler = (lane, run) => {
  if (
    lane === "foreground" &&
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  ) {
    const frame = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(frame);
  }
  if (typeof window !== "undefined") {
    const timer = window.setTimeout(run, lane === "foreground" ? 50 : backgroundDeltaFlushMs);
    return () => window.clearTimeout(timer);
  }
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) run();
  });
  return () => {
    cancelled = true;
  };
};

let deltaFlushScheduler = defaultDeltaFlushScheduler;

export function markSessionSnapshotFetchStart(snapshot: OpenworkSessionSnapshot, startedAt: number) {
  sessionSnapshotFetchStarts.set(snapshot, startedAt);
}

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
  return `${input.workspaceId}:${input.baseUrl}`;
}

type WorkspaceSyncStreamStore = {
  phasesByKey: Record<string, SyncStreamPhase>;
  publishPhase: (key: string, phase: SyncStreamPhase) => void;
  removePhase: (key: string) => void;
};

/**
 * Live health of each workspace event stream so surfaces can tell a live
 * stream from one that is reconnecting, blocked on authentication, or stale.
 * The lifecycle only publishes actual transitions, so subscribers do not see
 * duplicate notifications.
 */
export const useWorkspaceSyncStreamStore = create<WorkspaceSyncStreamStore>((set) => ({
  phasesByKey: {},
  publishPhase: (key, phase) => set((state) => ({
    phasesByKey: { ...state.phasesByKey, [key]: phase },
  })),
  removePhase: (key) => set((state) => {
    if (!(key in state.phasesByKey)) return state;
    const next = { ...state.phasesByKey };
    delete next[key];
    return { phasesByKey: next };
  }),
}));

export function getWorkspaceSessionSyncStreamPhase(
  input: Pick<SyncOptions, "workspaceId" | "baseUrl">,
): SyncStreamPhase | null {
  return useWorkspaceSyncStreamStore.getState().phasesByKey[`${input.workspaceId}:${input.baseUrl}`] ?? null;
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

// 401/403/404 can mean a permanently invalid token, but the same statuses
// occur transiently while the local server restarts or the runtime generation
// rotates. They select the slower bounded auth backoff lane instead of
// terminating the stream: the task may still be running on the server, and a
// dead stream would silently stop delivering its events.
function isAuthBlockedSubscribeError(error: unknown) {
  const status = getErrorStatus(error);
  return status === 401 || status === 403 || status === 404;
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

function getSessionCreatedInfo(event: OpencodeEvent): Session | null {
  if (event.type !== "session.created") return null;
  const props = event.properties;
  if (!props || typeof props !== "object") return null;
  const info = (props as { info?: unknown }).info;
  if (!info || typeof info !== "object") return null;
  const record = info as Partial<Session>;
  if (typeof record.id !== "string" || !record.id) return null;
  return record as Session;
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

function permissionNotificationDetail(permission: PermissionRequest | PermissionV2Request) {
  if ("action" in permission) {
    return `A session is waiting for permission to ${permission.action.replace(/[._-]/g, " ")}.`;
  }
  return `A session is waiting for ${permission.permission} permission.`;
}

function questionNotificationText(question: QuestionRequest) {
  const prompt = question.questions.find((item) => item.question.trim())?.question.trim();
  return prompt ? `Question: ${prompt}` : undefined;
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
  if (entry.deltaFlushBuffer.length === 0) {
    entry.cancelDeltaFlush?.();
    entry.deltaFlushLane = null;
    entry.cancelDeltaFlush = null;
  }
  const queryClient = getReactQueryClient();
  queryClient.removeQueries({ queryKey: permissionKey(input.workspaceId, sessionId), exact: true });
  // Status entries are exempt from TanStack GC (see query-client.ts), so the
  // tracked-session lifecycle owns their cleanup.
  queryClient.removeQueries({ queryKey: statusKey(input.workspaceId, sessionId), exact: true });
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
  entry.cancelDeltaFlush?.();
  entry.deltaFlushLane = null;
  entry.cancelDeltaFlush = null;
  if (entry.statusReconcileTimer) clearTimeout(entry.statusReconcileTimer);
  entry.statusReconcileTimer = null;
  entry.statusReconcileAbort?.abort();
  entry.statusReconcileAbort = null;
  entry.liveSessionIds.clear();
  entry.runActiveObservedAt.clear();
  entry.assistantMessageCompletedAt.clear();
  entry.titleRecovery?.dispose();
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

function applyEvent(entry: SyncEntry, workspaceId: string, event: OpencodeEvent) {
  const queryClient = getReactQueryClient();
  const input = entry.input;

  if (event.type === "session.created") {
    const session = getSessionCreatedInfo(event);
    if (!session) return;
    for (const listener of entry.sessionCreatedListeners.keys()) listener(session);
    return;
  }

  if (event.type === "session.updated") {
    const update = getSessionUpdatedInfo(event);
    if (!update) return;
    const title = typeof update.info.title === "string" ? update.info.title : "";
    if (title && !isGeneratedSessionTitle(title)) entry.titleRecovery?.resolve(update.sessionId);
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
    for (const listener of entry.sessionUpdatedListeners.keys()) listener(update);
    return;
  }

  if (event.type === "session.deleted") {
    const props = (event.properties ?? {}) as { sessionID?: string; info?: { id?: string } };
    const sessionId = props.sessionID ?? props.info?.id ?? "";
    if (sessionId) entry.titleRecovery?.resolve(sessionId);
    if (sessionId) useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    if (sessionId) stopTrackingLiveSession(entry, sessionId);
    if (sessionId) {
      for (const listener of entry.sessionDeletedListeners.keys()) listener(sessionId);
    }
    return;
  }

  if (event.type === "session.error") {
    const sessionId = sessionIdFromProperties(event.properties);
    if (sessionId) {
      const sessionError = sessionErrorFromProperties(event.properties);
      const errorPresentation = presentOpencodeSessionError(sessionError);
      const errorText = describeOpencodeSessionError(sessionError);
      const runStartedAt = takeTaskRunStart(sessionId);
      if (runStartedAt !== null) {
        captureAnalyticsEvent("task_run_errored", {
          duration_ms: Date.now() - runStartedAt,
        });
        trackTaskFailed(sessionId, Date.now() - runStartedAt);
      }
      notifyDesktopEvent({ type: "task.failed", sessionId, errorText });
      useSessionActivityStore.getState().setError(workspaceId, sessionId, errorText);
      stopTrackingLiveSession(entry, sessionId);
      if (isTrackedSession(entry, sessionId)) {
        flushSessionDeltas(entry, workspaceId, sessionId);
        // The activity store treats session.error as terminal (setError
        // lowers runActive), but the chat surface derives its thread status
        // from this react-query cache. An engine that errors without a
        // following idle event otherwise leaves the transcript's "Working…"
        // row ticking forever beside the error card. Mirror the idle write.
        queryClient.setQueryData(statusKey(workspaceId, sessionId), idleStatus);
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
          return upsertMessage(current, createSessionErrorUIMessage(turnKey, errorPresentation));
        });
        // Reconcile against the server snapshot immediately after a failed
        // turn. The SSE stream can end before its final part/attachment events
        // reach the renderer; the snapshot is the durable source for partial
        // output and files that completed before the interruption.
        void queryClient.invalidateQueries({
          queryKey: snapshotKey(workspaceId, sessionId),
          exact: true,
        });
      }
      // An errored run is over: give status listeners (like the queued-send
      // drainer) the same idle edge session.idle would have delivered, so
      // queued messages are not wedged behind a run that will never finish.
      for (const listener of entry.sessionStatusListeners.keys()) listener({ sessionId, status: idleStatus });
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
    applySessionRunStatus(entry, workspaceId, props.sessionID, props.status, { source: "stream" });
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
    notifyDesktopEvent({
      type: "permission.asked",
      sessionId: permission.sessionID,
      detail: permissionNotificationDetail(permission),
    });
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
    notifyDesktopEvent({
      type: "permission.asked",
      sessionId: permission.sessionID,
      detail: permissionNotificationDetail(permission),
    });
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
    notifyDesktopEvent({
      type: "question.asked",
      sessionId: question.sessionID,
      question: questionNotificationText(question),
    });
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
      info?: { id?: string; role?: UIMessage["role"] | string; sessionID?: string; time?: { created?: number; completed?: number } };
    };
    const info = props.info;
    if (!info?.id || !info.sessionID || (info.role !== "user" && info.role !== "assistant" && info.role !== "system")) {
      return;
    }
    useSessionActivityStore.getState().markMessageRole(workspaceId, info.sessionID, info.id, info.role);
    if (info.role === "assistant" && typeof info.time?.completed === "number") {
      const observedAt = perfNow();
      entry.assistantMessageCompletedAt.set(info.sessionID, observedAt);
      const runActiveAt = entry.runActiveObservedAt.get(info.sessionID);
      recordSessionCompletionMark("assistant-message-completed", {
        sessionID: info.sessionID,
        ...(runActiveAt === undefined
          ? {}
          : { sinceRunActiveMs: Math.round((observedAt - runActiveAt) * 100) / 100 }),
      });
    }
    if (!isTrackedSession(entry, info.sessionID)) return;
    const created = info.time?.created;
    const completed = info.time?.completed;
    const next = {
      id: info.id,
      role: info.role,
      ...(typeof created === "number"
        ? { metadata: { opencode: { created, ...(typeof completed === "number" ? { completed } : {}) } } }
        : {}),
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
    applySessionRunStatus(entry, workspaceId, props.sessionID, idleStatus, {
      source: "stream",
      terminalEvent: true,
    });
  }
}

function scheduleDeltaFlush(entry: SyncEntry, workspaceId: string) {
  if (entry.deltaFlushBuffer.length === 0) return;
  const lane = selectDeltaFlushLane(entry.deltaFlushBuffer, entry.input.visibleSessionId);
  if (entry.deltaFlushLane === lane || entry.deltaFlushLane === "foreground") return;

  entry.cancelDeltaFlush?.();
  entry.deltaFlushLane = lane;
  entry.cancelDeltaFlush = deltaFlushScheduler(lane, () => {
    if (entry.deltaFlushLane !== lane) return;
    entry.deltaFlushLane = null;
    entry.cancelDeltaFlush = null;
    flushDeltas(entry, workspaceId, lane);
    scheduleDeltaFlush(entry, workspaceId);
  });
}

function flushDeltas(entry: SyncEntry, workspaceId: string, lane: DeltaFlushLane) {
  const pending = coalescePendingDeltas(entry.deltaFlushBuffer);
  const { flushing, deferred } = partitionPendingDeltasByLane(
    pending,
    entry.input.visibleSessionId,
    lane,
  );
  entry.deltaFlushBuffer = deferred;
  commitDeltas(entry, workspaceId, flushing);
}

function flushSessionDeltas(entry: SyncEntry, workspaceId: string, sessionId: string) {
  const { flushing, deferred } = partitionPendingDeltasBySession(
    entry.deltaFlushBuffer,
    sessionId,
  );
  if (flushing.length === 0) return;

  entry.deltaFlushBuffer = deferred;
  if (deferred.length === 0) {
    entry.cancelDeltaFlush?.();
    entry.deltaFlushLane = null;
    entry.cancelDeltaFlush = null;
  }
  commitDeltas(entry, workspaceId, coalescePendingDeltas(flushing));
}

function commitDeltas(entry: SyncEntry, workspaceId: string, items: PendingDelta[]) {
  const queryClient = getReactQueryClient();

  // Group by session id so each transcript cache is touched at most once
  // per flush.
  const bySession = new Map<string, PendingDelta[]>();
  for (const item of items) {
    const bucket = bySession.get(item.sessionId);
    if (bucket) bucket.push(item);
    else bySession.set(item.sessionId, [item]);
  }

  for (const [sessionId, items] of bySession) {
    queryClient.setQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
      (current = []) => {
        const result = applyPendingDeltasToTranscript(current, items);
        for (const item of result.unapplied) {
          // The declaration event is the source of truth for text versus
          // reasoning. Hold early deltas until that event arrives instead of
          // projecting them into the wrong Markdown surface.
          const existing = entry.pendingDeltas.get(item.partId) ?? {
            messageId: item.messageId,
            reasoning: item.reasoning,
            text: "",
          };
          existing.text += item.delta;
          entry.pendingDeltas.set(item.partId, existing);
        }
        return result.messages;
      },
    );
  }
}

function startSync(input: SyncOptions, entry: SyncEntry) {
  const streamKey = syncKey(input);
  const lifecycle = startSyncStreamLifecycle({
    // Read the token at connect time so every retry — including a
    // generation-triggered restart — uses the latest credential.
    subscribe: (signal) => syncSubscriptionFactory(input.baseUrl, entry.openworkToken, signal),
    onEvent: (raw) => {
      const event = normalizeEvent(raw);
      if (!event) return;
      applyEvent(entry, input.workspaceId, event);
    },
    // Level-reconcile run statuses on every (re)connect before trusting any
    // cached idle: the server may have started or finished work while the
    // stream was down.
    onConnected: (signal) => {
      void reconcileSessionRunStatuses(entry, input, signal, "connect-reconcile");
    },
    onPhaseChange: (phase) => {
      useWorkspaceSyncStreamStore.getState().publishPhase(streamKey, phase);
    },
    isAuthError: isAuthBlockedSubscribeError,
  });
  entry.notifyStreamGenerationChanged = lifecycle.notifyGenerationChanged;

  return () => {
    entry.notifyStreamGenerationChanged = null;
    lifecycle.dispose();
    useWorkspaceSyncStreamStore.getState().removePhase(streamKey);
  };
}

/**
 * Apply a session run status through the same path a live `session.status`
 * event takes: the activity store, the react-query status cache for tracked
 * sessions, and the sync listeners. Fetched (level-triggered) statuses pass
 * `snapshotStartedAt` so they are ordered against live writes — a fetch that
 * raced a newer SSE status is dropped instead of clobbering it.
 */
function applySessionRunStatus(
  entry: SyncEntry,
  workspaceId: string,
  sessionId: string,
  status: SessionStatus,
  options: {
    snapshotStartedAt?: number;
    source?: SessionStatusSource;
    terminalEvent?: boolean;
  } = {},
) {
  const snapshotStartedAt = options.snapshotStartedAt;
  const store = useSessionActivityStore.getState();
  const previousRecord = store.recordsByWorkspaceId[workspaceId]?.[sessionId];
  const wasTrackedLive = entry.liveSessionIds.has(sessionId);
  const wasLive = wasTrackedLive || previousRecord?.runActive === true;
  if (typeof snapshotStartedAt === "number") {
    if (snapshotStartedAt < (previousRecord?.runStatusAt ?? 0)) return;
    store.seedSessionRun(workspaceId, sessionId, status, undefined, { snapshotStartedAt });
  } else {
    store.setRunStatus(workspaceId, sessionId, status);
  }

  const live = isLiveStatus(status);
  const observedAt = perfNow();
  if (live) {
    entry.liveSessionIds.add(sessionId);
    if (!wasTrackedLive) {
      entry.runActiveObservedAt.set(sessionId, observedAt);
      recordSessionCompletionMark("run-active", {
        sessionID: sessionId,
        source: options.source ?? "stream",
        status: status.type,
      });
    }
    scheduleActiveSessionStatusReconciliation(entry);
  } else {
    entry.liveSessionIds.delete(sessionId);
    clearActiveSessionStatusReconcileTimer(entry);
  }

  const tracked = isTrackedSession(entry, sessionId);
  if (tracked) getReactQueryClient().setQueryData(statusKey(workspaceId, sessionId), status);
  for (const listener of entry.sessionStatusListeners.keys()) listener({ sessionId, status });
  if (!live) {
    // A level-triggered idle response is as authoritative as the SSE edge.
    // Converge through the same terminal path so a missed status event also
    // flushes final deltas and refreshes any final persisted message parts.
    const runStartedAt = takeTaskRunStart(sessionId);
    if (runStartedAt !== null) {
      captureAnalyticsEvent("task_run_completed", {
        duration_ms: Date.now() - runStartedAt,
      });
      trackTaskCompleted(sessionId, Date.now() - runStartedAt);
      notifyDesktopEvent({ type: "task.completed", sessionId });
      entry.titleRecovery?.observe(sessionId);
    }
    const shouldRecordTerminal = wasLive || runStartedAt !== null;
    const shouldConvergeTerminal = shouldRecordTerminal || options.terminalEvent === true;
    if (tracked && shouldConvergeTerminal) {
      flushSessionDeltas(entry, workspaceId, sessionId);
      void getReactQueryClient().invalidateQueries({
        queryKey: snapshotKey(workspaceId, sessionId),
        exact: true,
      });
    }
    if (shouldRecordTerminal) {
      const assistantCompletedAt = entry.assistantMessageCompletedAt.get(sessionId);
      const runActiveAt = entry.runActiveObservedAt.get(sessionId);
      recordSessionCompletionMark("run-terminal", {
        sessionID: sessionId,
        source: options.source ?? "stream",
        ...(assistantCompletedAt === undefined
          ? {}
          : { sinceAssistantMessageCompletedMs: Math.round((observedAt - assistantCompletedAt) * 100) / 100 }),
        ...(runActiveAt === undefined
          ? {}
          : { sinceRunActiveMs: Math.round((observedAt - runActiveAt) * 100) / 100 }),
      });
    }
    entry.runActiveObservedAt.delete(sessionId);
    entry.assistantMessageCompletedAt.delete(sessionId);
    if (entry.input && tracked) releaseRetainedSessionSoon(entry.input, entry, sessionId);
  }
}

async function reconcileSessionRunStatuses(
  entry: SyncEntry,
  input: SyncOptions,
  signal: AbortSignal,
  source: Exclude<SessionStatusSource, "stream">,
) {
  const startedAt = Date.now();
  let statuses: Record<string, SessionStatus>;
  try {
    statuses = await sessionStatusFetcher(input.baseUrl, entry.openworkToken, signal);
  } catch {
    return;
  }
  if (signal.aborted) return;

  // Level-triggered convergence on every SSE (re)connect: sessions the fetch
  // reports live are seeded busy (heals a subscriber that missed the busy
  // edge), and known records the fetch no longer reports are seeded idle
  // (heals a missed idle edge). Both flow through the same path a
  // session.status event uses so the status cache and listeners converge too.
  const records = useSessionActivityStore.getState().recordsByWorkspaceId[input.workspaceId] ?? {};
  const sessionIds = new Set([
    ...Object.keys(statuses),
    ...Object.keys(records),
    ...entry.liveSessionIds,
  ]);
  for (const sessionId of sessionIds) {
    applySessionRunStatus(entry, input.workspaceId, sessionId, statuses[sessionId] ?? idleStatus, {
      snapshotStartedAt: startedAt,
      source,
    });
  }
}

function clearActiveSessionStatusReconcileTimer(entry: SyncEntry) {
  if (entry.liveSessionIds.size > 0 || !entry.statusReconcileTimer) return;
  clearTimeout(entry.statusReconcileTimer);
  entry.statusReconcileTimer = null;
}

function stopTrackingLiveSession(entry: SyncEntry, sessionId: string) {
  entry.liveSessionIds.delete(sessionId);
  entry.runActiveObservedAt.delete(sessionId);
  entry.assistantMessageCompletedAt.delete(sessionId);
  clearActiveSessionStatusReconcileTimer(entry);
}

function scheduleActiveSessionStatusReconciliation(entry: SyncEntry) {
  if (
    entry.liveSessionIds.size === 0
    || entry.statusReconcileTimer
    || entry.statusReconcileAbort
  ) return;

  entry.statusReconcileTimer = setTimeout(() => {
    entry.statusReconcileTimer = null;
    if (entry.liveSessionIds.size === 0) return;

    const controller = new AbortController();
    entry.statusReconcileAbort = controller;
    void reconcileSessionRunStatuses(
      entry,
      entry.input,
      controller.signal,
      "active-reconcile",
    ).finally(() => {
      if (entry.statusReconcileAbort === controller) entry.statusReconcileAbort = null;
      scheduleActiveSessionStatusReconciliation(entry);
    });
  }, activeSessionStatusReconcileIntervalMs);
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    existing.input = input;
    if (existing.openworkToken !== input.openworkToken) {
      // Reattachment with a rotated token (or a restarted runtime's fresh
      // credential) is a new connection generation: restart a stream parked
      // in auth backoff instead of leaving the task streaming nowhere.
      existing.openworkToken = input.openworkToken;
      existing.notifyStreamGenerationChanged?.();
    }
    if (existing.disposeTimer) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = null;
    }
    retainListener(existing.sessionCreatedListeners, input.onSessionCreated);
    retainListener(existing.sessionUpdatedListeners, input.onSessionUpdated);
    retainListener(existing.sessionDeletedListeners, input.onSessionDeleted);
    retainListener(existing.sessionStatusListeners, input.onSessionStatus);
    existing.refs += 1;
    scheduleDeltaFlush(existing, input.workspaceId);
    return () => releaseWorkspaceSessionSync(input);
  }

  const created: SyncEntry = {
    input,
    openworkToken: input.openworkToken,
    notifyStreamGenerationChanged: null,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionCreatedListeners: createListenerRegistry(input.onSessionCreated),
    sessionUpdatedListeners: createListenerRegistry(input.onSessionUpdated),
    sessionDeletedListeners: createListenerRegistry(input.onSessionDeleted),
    sessionStatusListeners: createListenerRegistry(input.onSessionStatus),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushLane: null,
    cancelDeltaFlush: null,
    liveSessionIds: new Set(),
    statusReconcileTimer: null,
    statusReconcileAbort: null,
    runActiveObservedAt: new Map(),
    assistantMessageCompletedAt: new Map(),
    titleRecovery: null,
  };
  created.titleRecovery = createSessionTitleRecovery({
    fetch: async (sessionId) => {
      const client = createClient(input.baseUrl, undefined, { token: created.openworkToken, mode: "openwork" });
      const [session, messages] = await Promise.all([
        client.session.get({ sessionID: sessionId }).then(unwrap),
        client.session.messages({ sessionID: sessionId, limit: 20 }).then(unwrap),
      ]);
      return {
        title: session.title,
        messages: messages.map((message) => ({
          role: message.info.role,
          synthetic: Reflect.get(message.info, "synthetic") === true,
          error: Reflect.get(message.info, "error"),
        })),
      };
    },
    onResolved: (sessionId, title) => {
      getReactQueryClient().setQueryData<OpenworkSessionSnapshot>(
        snapshotKey(input.workspaceId, sessionId),
        (current) => current
          ? { ...current, session: { ...current.session, title } }
          : current,
      );
      for (const listener of created.sessionUpdatedListeners.keys()) {
        listener({ sessionId, info: { title } });
      }
    },
    onFailure: (sessionId) => {
      notifyAlert({
        kind: "system",
        severity: "warning",
        title: t("session.title_generation_failed_title"),
        body: t("session.title_generation_failed_body"),
        dedupeKey: `session-title-generation:${input.workspaceId}:${sessionId}`,
      });
    },
  });
  syncs.set(key, created);
  created.dispose = startSync(input, created);

  return () => releaseWorkspaceSessionSync(input);
}

function releaseWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (!existing) return;
  releaseListener(existing.sessionCreatedListeners, input.onSessionCreated);
  releaseListener(existing.sessionUpdatedListeners, input.onSessionUpdated);
  releaseListener(existing.sessionDeletedListeners, input.onSessionDeleted);
  releaseListener(existing.sessionStatusListeners, input.onSessionStatus);
  existing.refs = Math.max(0, existing.refs - 1);
  if (existing.refs > 0) return;
  if (existing.retainedSessionTimers.size > 0 || existing.disposeTimer) return;
  existing.disposeTimer = setTimeout(() => {
    existing.disposeTimer = null;
    if (existing.refs === 0 && existing.retainedSessionTimers.size === 0) {
      disposeWorkspaceSync(key, existing);
    }
  }, workspaceSyncDisposeGraceMs);
}

export function seedSessionState(workspaceId: string, snapshot: OpenworkSessionSnapshot) {
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incoming = snapshotToUIMessages(snapshot);
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  const snapshotStartedAt = sessionSnapshotFetchStarts.get(snapshot);
  if (typeof snapshotStartedAt === "number") {
    const record = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[snapshot.session.id];
    useSessionActivityStore.getState().seedSessionRun(
      workspaceId,
      snapshot.session.id,
      snapshot.status,
      assistantOutputAfterLatestUser(incoming),
      { snapshotStartedAt },
    );
    if (snapshotStartedAt >= (record?.runStatusAt ?? 0)) {
      queryClient.setQueryData(statusKey(workspaceId, snapshot.session.id), snapshot.status);
    }
  }

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

/** Clear a server-confirmed revert cursor without discarding cached history. */
export function applySessionUnrevert(workspaceId: string, sessionId: string) {
  const queryClient = getReactQueryClient();
  void queryClient.cancelQueries({ queryKey: snapshotKey(workspaceId, sessionId) });
  queryClient.setQueryData<OpenworkSessionSnapshot>(
    snapshotKey(workspaceId, sessionId),
    (current) => (current ? { ...current, session: { ...current.session, revert: undefined } } : current),
  );
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
    openworkToken: input.openworkToken,
    notifyStreamGenerationChanged: null,
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionCreatedListeners: createListenerRegistry(input.onSessionCreated),
    sessionUpdatedListeners: createListenerRegistry(input.onSessionUpdated),
    sessionDeletedListeners: createListenerRegistry(input.onSessionDeleted),
    sessionStatusListeners: createListenerRegistry(input.onSessionStatus),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushLane: null,
    cancelDeltaFlush: null,
    liveSessionIds: new Set(),
    statusReconcileTimer: null,
    statusReconcileAbort: null,
    runActiveObservedAt: new Map(),
    assistantMessageCompletedAt: new Map(),
    titleRecovery: null,
  });
  return () => {
    const entry = syncs.get(key);
    if (entry) {
      for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
      if (entry.statusReconcileTimer) clearTimeout(entry.statusReconcileTimer);
      entry.statusReconcileAbort?.abort();
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

export function __queueSessionSyncDeltaForTest(input: SyncOptions, delta: PendingDelta) {
  const entry = syncs.get(syncKey(input));
  if (!entry) return;
  entry.deltaFlushBuffer.push(delta);
  scheduleDeltaFlush(entry, input.workspaceId);
}

export function __setSessionSyncDeltaFlushSchedulerForTest(scheduler: DeltaFlushScheduler | null) {
  deltaFlushScheduler = scheduler ?? defaultDeltaFlushScheduler;
}

export function __setWorkspaceSessionSyncSubscriptionFactoryForTest(factory: SyncSubscriptionFactory | null) {
  syncSubscriptionFactory = factory ?? defaultSyncSubscriptionFactory;
}

export function __setWorkspaceSessionSyncStatusFetcherForTest(fetcher: SessionStatusFetcher | null) {
  sessionStatusFetcher = fetcher ?? defaultSessionStatusFetcher;
}
