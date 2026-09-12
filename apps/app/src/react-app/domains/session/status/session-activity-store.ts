/** @jsxImportSource react */
import { create } from "zustand";
import { isToolUIPart, type UIMessage } from "ai";
import { isTaskToolPart, taskChildSessionId } from "../../../../lib/build-in-tools";
import { transcriptProgress } from "./session-progress";

import { t } from "../../../../i18n";

export type SessionActivityStatus = "idle" | "thinking" | "responding" | "error" | "compacting" | "waiting";

/** What an unanswered request is asking the person for. */
export type SessionWaitingKind = "permission" | "question";

type SessionMessageRole = "assistant" | "system" | "user";

type TranscriptActivity = {
  startedAt: number;
  latestUserId: string | null;
  assistantOutput: boolean;
  activeStartedAt: number;
};

type SessionActivityRecord = {
  status: SessionActivityStatus;
  runActive: boolean;
  retrying: boolean;
  runStatusAt: number;
  runStartedAt: number;
  // Only an active run first discovered by a read may inherit persisted age.
  // Live status/admission writes cancel this pending hydration, even on ties.
  runHydrationAfter: number | null;
  transcriptActivity: TranscriptActivity | null;
  lastProgressAt: number;
  progressRevision: string | null;
  progressParts: Record<string, string>;
  latestActivity: string | null;
  assistantOutput: boolean;
  errorActive: boolean;
  errorMessage: string | null;
  compacting: boolean;
  waitingPermissionIds: string[];
  waitingQuestionIds: string[];
  messageRoles: Record<string, SessionMessageRole>;
  childSessionIds: string[];
  updatedAt: number;
};

type SessionLike = {
  id: string;
  status?: unknown;
  state?: unknown;
  runStatus?: unknown;
};

type SessionActivityStore = {
  recordsByWorkspaceId: Record<string, Record<string, SessionActivityRecord>>;
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>;
  /**
   * Sessions with an unanswered permission or question, by what they ask for.
   * Derived like `statusesByWorkspaceId` so a parent roll-up can subscribe
   * without re-rendering on every transcript progress write.
   */
  waitingByWorkspaceId: Record<string, Record<string, SessionWaitingKind>>;
  getStatus: (workspaceId: string, sessionId: string) => SessionActivityStatus;
  getSessionError: (workspaceId: string, sessionId: string) => string | null;
  seedWorkspaceSessions: (workspaceId: string, sessions: SessionLike[]) => void;
  seedSessionRun: (
    workspaceId: string,
    sessionId: string,
    status: unknown,
    assistantOutput: boolean | undefined,
    options?: { snapshotStartedAt?: number },
  ) => void;
  setRunStatus: (workspaceId: string, sessionId: string, status: unknown) => void;
  observeTranscript: (
    workspaceId: string,
    sessionId: string,
    messages: UIMessage[],
    snapshot?: boolean,
    options?: { snapshotStartedAt?: number },
  ) => void;
  markMessageRole: (workspaceId: string, sessionId: string, messageId: string, role: SessionMessageRole) => void;
  markAssistantOutput: (workspaceId: string, sessionId: string, messageId?: string, options?: { allowUnknownMessageRole?: boolean }) => void;
  setWaitingRequest: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestId: string, waiting: boolean) => void;
  replaceWaitingRequests: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestIds: string[]) => void;
  setError: (workspaceId: string, sessionId: string, message?: string) => void;
  clearError: (workspaceId: string, sessionId: string) => void;
  setCompacting: (workspaceId: string, sessionId: string, compacting: boolean) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
};

const createRecord = (): SessionActivityRecord => ({
  status: "idle",
  runActive: false,
  retrying: false,
  runStatusAt: 0,
  runStartedAt: 0,
  runHydrationAfter: null,
  transcriptActivity: null,
  lastProgressAt: 0,
  progressRevision: null,
  progressParts: {},
  latestActivity: null,
  assistantOutput: false,
  errorActive: false,
  errorMessage: null,
  compacting: false,
  waitingPermissionIds: [],
  waitingQuestionIds: [],
  messageRoles: {},
  childSessionIds: [],
  updatedAt: 0,
});

function normalizeRunStatus(status: unknown): "idle" | "running" | "retry" {
  if (typeof status === "string") {
    if (status === "busy" || status === "running") return "running";
    if (status === "retry") return "retry";
    return "idle";
  }

  if (!status || typeof status !== "object") return "idle";
  const type = "type" in status ? status.type : undefined;
  if (type === "busy" || type === "running") return "running";
  if (type === "retry") return "retry";
  return "idle";
}

function sessionRunStatus(session: SessionLike) {
  return session.status ?? session.state ?? session.runStatus;
}

function statusForRecord(record: SessionActivityRecord): SessionActivityStatus {
  if (record.errorActive) return "error";
  if (record.waitingPermissionIds.length > 0 || record.waitingQuestionIds.length > 0) return "waiting";
  if (record.compacting) return "compacting";
  if (!record.runActive) return "idle";
  return record.assistantOutput ? "responding" : "thinking";
}

function updateWorkspaceStatus(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
  workspaceId: string,
  sessionId: string,
  status: SessionActivityStatus,
) {
  const current = statusesByWorkspaceId[workspaceId] ?? {};
  if (current[sessionId] === status) return statusesByWorkspaceId;
  return {
    ...statusesByWorkspaceId,
    [workspaceId]: {
      ...current,
      [sessionId]: status,
    },
  };
}

function waitingKindForRecord(record: SessionActivityRecord): SessionWaitingKind | undefined {
  if (record.waitingPermissionIds.length > 0) return "permission";
  if (record.waitingQuestionIds.length > 0) return "question";
  return undefined;
}

function updateWorkspaceWaiting(
  waitingByWorkspaceId: Record<string, Record<string, SessionWaitingKind>>,
  workspaceId: string,
  sessionId: string,
  kind: SessionWaitingKind | undefined,
) {
  const current = waitingByWorkspaceId[workspaceId] ?? {};
  if (current[sessionId] === kind) return waitingByWorkspaceId;
  const next = { ...current };
  if (kind) next[sessionId] = kind;
  else delete next[sessionId];
  return { ...waitingByWorkspaceId, [workspaceId]: next };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMessageRoles(
  left: Record<string, SessionMessageRole>,
  right: Record<string, SessionMessageRole>,
): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([messageId, role]) => right[messageId] === role);
}

function sameActivityRecord(
  current: SessionActivityRecord,
  next: SessionActivityRecord,
  status: SessionActivityStatus,
): boolean {
  return current.status === status
    && current.runActive === next.runActive
    && current.retrying === next.retrying
    && current.runStatusAt === next.runStatusAt
    && current.runStartedAt === next.runStartedAt
    && current.runHydrationAfter === next.runHydrationAfter
    && current.transcriptActivity?.startedAt === next.transcriptActivity?.startedAt
    && current.transcriptActivity?.latestUserId === next.transcriptActivity?.latestUserId
    && current.transcriptActivity?.assistantOutput === next.transcriptActivity?.assistantOutput
    && current.transcriptActivity?.activeStartedAt === next.transcriptActivity?.activeStartedAt
    && current.lastProgressAt === next.lastProgressAt
    && current.progressRevision === next.progressRevision
    && current.latestActivity === next.latestActivity
    && current.assistantOutput === next.assistantOutput
    && current.errorActive === next.errorActive
    && current.errorMessage === next.errorMessage
    && current.compacting === next.compacting
    && sameStrings(current.waitingPermissionIds, next.waitingPermissionIds)
    && sameStrings(current.waitingQuestionIds, next.waitingQuestionIds)
    && sameMessageRoles(current.messageRoles, next.messageRoles)
    && sameStrings(current.childSessionIds, next.childSessionIds);
}

type SessionActivityDerivedState = Pick<SessionActivityStore, "recordsByWorkspaceId" | "statusesByWorkspaceId" | "waitingByWorkspaceId">;

function updateRecord(
  state: SessionActivityDerivedState,
  workspaceId: string,
  sessionId: string,
  updater: (record: SessionActivityRecord) => SessionActivityRecord,
): SessionActivityDerivedState {
  const workspaceRecords = state.recordsByWorkspaceId[workspaceId] ?? {};
  const currentRecord = workspaceRecords[sessionId];
  const nextRecord = updater(currentRecord ?? createRecord());
  const status = statusForRecord(nextRecord);
  if (currentRecord && sameActivityRecord(currentRecord, nextRecord, status)) return state;
  const recordWithStatus = { ...nextRecord, status, updatedAt: Date.now() };
  return {
    recordsByWorkspaceId: {
      ...state.recordsByWorkspaceId,
      [workspaceId]: {
        ...workspaceRecords,
        [sessionId]: recordWithStatus,
      },
    },
    statusesByWorkspaceId: updateWorkspaceStatus(state.statusesByWorkspaceId, workspaceId, sessionId, status),
    waitingByWorkspaceId: updateWorkspaceWaiting(state.waitingByWorkspaceId, workspaceId, sessionId, waitingKindForRecord(nextRecord)),
  };
}

// Message roles are only consulted while a run is active to decide whether a
// streaming part belongs to an assistant message. Without a cap the dict grows
// by one entry per message for a session's whole lifetime, so keep only the
// most recently marked messages.
export const MAX_TRACKED_MESSAGE_ROLES = 200;

function withMessageRole(
  roles: Record<string, SessionMessageRole>,
  messageId: string,
  role: SessionMessageRole,
): Record<string, SessionMessageRole> {
  if (roles[messageId] === role) return roles;
  const next: Record<string, SessionMessageRole> = { ...roles, [messageId]: role };
  const ids = Object.keys(next);
  const overflow = ids.length - MAX_TRACKED_MESSAGE_ROLES;
  if (overflow <= 0) return next;
  for (const id of ids.slice(0, overflow)) {
    delete next[id];
  }
  return next;
}

function removeValue(values: string[], value: string) {
  return values.filter((item) => item !== value);
}

function addValue(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

function reconcileTranscriptActivity(record: SessionActivityRecord): SessionActivityRecord {
  const snapshot = record.transcriptActivity;
  if (!record.runActive || !snapshot) return record;
  const hydrateRun = typeof record.runHydrationAfter === "number" && snapshot.startedAt > record.runHydrationAfter;
  // Fresh history can reveal output for an already observed live run, but only
  // a run first discovered by a read may inherit its persisted execution age.
  const assistantOutput = record.assistantOutput
    || ((hydrateRun || snapshot.startedAt > record.runStatusAt) && snapshot.assistantOutput);
  if (!hydrateRun && assistantOutput === record.assistantOutput) return record;
  return {
    ...record,
    assistantOutput,
    runStartedAt: hydrateRun && snapshot.activeStartedAt > 0
      ? Math.min(record.runStartedAt || snapshot.activeStartedAt, snapshot.activeStartedAt)
      : record.runStartedAt,
    runHydrationAfter: hydrateRun ? null : record.runHydrationAfter,
  };
}

export const useSessionActivityStore = create<SessionActivityStore>((set, get) => ({
  recordsByWorkspaceId: {},
  statusesByWorkspaceId: {},
  waitingByWorkspaceId: {},
  getStatus: (workspaceId, sessionId) => (
    get().statusesByWorkspaceId[workspaceId]?.[sessionId] ?? "idle"
  ),
  getSessionError: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();

    if (!workspace || !session) {
      return null;
    }

    const record = get().recordsByWorkspaceId[workspace]?.[session];

    if (!record?.errorActive) {
      return null;
    }

    return record.errorMessage;
  },
  seedWorkspaceSessions: (workspaceId, sessions) => {
    const id = workspaceId.trim();
    if (!id) return;
    set((state) => {
      let nextState: SessionActivityDerivedState = state;
      for (const session of sessions) {
        const sessionId = session.id.trim();
        if (!sessionId) continue;
        const status = sessionRunStatus(session);
        if (status === undefined || status === null) continue;
        nextState = updateRecord(nextState, id, sessionId, (record) => {
          const normalized = normalizeRunStatus(status);
          const runActive = normalized === "running" || normalized === "retry";
          if (!runActive && record.status !== "idle") return record;
          return {
            ...record,
            runActive,
            retrying: normalized === "retry",
            runStartedAt: runActive && !record.runActive ? Date.now() : record.runStartedAt,
            assistantOutput: runActive && record.runActive ? record.assistantOutput : false,
            errorActive: runActive ? false : record.errorActive,
            errorMessage: runActive ? null : record.errorMessage,
            compacting: runActive ? record.compacting : false,
            waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
            waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
          };
        });
      }
      if (nextState === state) return state;
      return { ...state, ...nextState };
    });
  },
  seedSessionRun: (workspaceId, sessionId, status, assistantOutput, options) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const normalized = normalizeRunStatus(status);
      const runActive = normalized === "running" || normalized === "retry";
      const snapshotStartedAt = options?.snapshotStartedAt;
      // Order snapshot seeds against live writes so stale idle cannot kill a
      // live spinner and stale busy cannot resurrect a run that already ended.
      if (typeof snapshotStartedAt === "number" && snapshotStartedAt < record.runStatusAt) return record;
      if (typeof snapshotStartedAt !== "number" && !runActive && record.status !== "idle") return record;
      return reconcileTranscriptActivity({
        ...record,
        runActive,
        runStatusAt: snapshotStartedAt ?? record.runStatusAt,
        retrying: normalized === "retry",
        runStartedAt: runActive && !record.runActive ? Date.now() : record.runStartedAt,
        runHydrationAfter: !runActive ? null
          : typeof snapshotStartedAt === "number" && (!record.runActive || record.runStatusAt === 0)
            ? record.runStatusAt
            : record.runHydrationAfter,
        assistantOutput: runActive && (assistantOutput ?? record.assistantOutput),
        errorActive: runActive ? false : record.errorActive,
        errorMessage: runActive ? null : record.errorMessage,
        compacting: runActive ? record.compacting : false,
        waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
        waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
      });
    }));
  },
  setRunStatus: (workspaceId, sessionId, status) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const normalized = normalizeRunStatus(status);
      const runActive = normalized === "running" || normalized === "retry";
      return {
        ...record,
        runActive,
        runStatusAt: Date.now(),
        runHydrationAfter: null,
        retrying: normalized === "retry",
        runStartedAt: runActive && !record.runActive ? Date.now() : record.runStartedAt,
        assistantOutput: runActive && record.runActive ? record.assistantOutput : false,
        errorActive: runActive ? false : record.errorActive,
        errorMessage: runActive ? null : record.errorMessage,
        compacting: runActive ? record.compacting : false,
        waitingPermissionIds: runActive ? record.waitingPermissionIds : [],
        waitingQuestionIds: runActive ? record.waitingQuestionIds : [],
      };
    }));
  },
  observeTranscript: (workspaceId, sessionId, messages, snapshot = false, options = {}) => {
    set((state) => updateRecord(state, workspaceId, sessionId, (record) => {
      const progress = transcriptProgress(messages, record.progressParts);
      const childSessionIds = new Set(record.childSessionIds);
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const part of message.parts) {
          if (!isToolUIPart(part) || !isTaskToolPart(part)) continue;
          const childId = taskChildSessionId(part);
          if (childId) childSessionIds.add(childId);
        }
      }
      const snapshotStartedAt = options.snapshotStartedAt;
      const turnChanged = record.transcriptActivity !== null
        && record.transcriptActivity.latestUserId !== progress.latestUserId;
      const progressChanged = record.progressRevision !== progress.revision;
      const observedAt = snapshot ? snapshotStartedAt ?? 0 : turnChanged || progressChanged ? Date.now() : 0;
      const next = reconcileTranscriptActivity({
        ...record,
        childSessionIds: childSessionIds.size === record.childSessionIds.length ? record.childSessionIds : [...childSessionIds],
        ...(turnChanged ? {
          assistantOutput: false,
          runStartedAt: record.runActive
            ? Math.max(record.runStartedAt, progress.latestUserCreated ?? (snapshot ? 0 : Date.now()))
            : record.runStartedAt,
          runHydrationAfter: null,
          latestActivity: null,
        } : {}),
        transcriptActivity: {
          startedAt: Math.max(turnChanged ? 0 : record.transcriptActivity?.startedAt ?? 0, observedAt),
          latestUserId: progress.latestUserId,
          assistantOutput: progress.assistantOutput,
          activeStartedAt: progress.activeStartedAt,
        },
      });
      // History may have established progress before status arrived. Activity
      // enrichment must still run when its fingerprint is already known.
      if (!progressChanged) return next;
      const hydratedActiveStartedAt = snapshot && snapshotStartedAt === undefined
        && record.progressRevision === null && next.runActive && next.runHydrationAfter !== null
        ? progress.activeStartedAt
        : 0;
      return {
        ...next,
        // Snapshot fetch time establishes ordering, not execution age. Only a
        // persisted in-flight part can move the first hydrated run anchor back;
        // old terminal transcript rows must not age a newer accepted run.
        runStartedAt: hydratedActiveStartedAt > 0
          ? Math.min(record.runStartedAt || hydratedActiveStartedAt, hydratedActiveStartedAt)
          : next.runStartedAt,
        runHydrationAfter: hydratedActiveStartedAt > 0 ? null : next.runHydrationAfter,
        progressRevision: progress.revision,
        progressParts: progress.parts,
        latestActivity: turnChanged && !progress.assistantOutput ? null : progress.label ?? next.latestActivity,
        lastProgressAt: progress.label
          ? Math.max(record.lastProgressAt, snapshot && record.progressRevision === null ? progress.timestamp : Date.now())
          : record.lastProgressAt,
      };
    }));
  },
  markMessageRole: (workspaceId, sessionId, messageId, role) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const message = messageId.trim();
    if (!workspace || !session || !message) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      messageRoles: withMessageRole(record.messageRoles, message, role),
    })));
  },
  markAssistantOutput: (workspaceId, sessionId, messageId, options) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const message = messageId?.trim() ?? "";
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      if (!record.runActive) return record;
      if (message && record.messageRoles[message] && record.messageRoles[message] !== "assistant") return record;
      if (message && !record.messageRoles[message] && options?.allowUnknownMessageRole !== true) return record;
      return { ...record, assistantOutput: true };
    }));
  },
  setWaitingRequest: (workspaceId, sessionId, kind, requestId, waiting) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    const request = requestId.trim();
    if (!workspace || !session || !request) return;
    set((state) => updateRecord(state, workspace, session, (record) => {
      const key = kind === "permission" ? "waitingPermissionIds" : "waitingQuestionIds";
      return {
        ...record,
        [key]: waiting ? addValue(record[key], request) : removeValue(record[key], request),
      };
    }));
  },
  replaceWaitingRequests: (workspaceId, sessionId, kind, requestIds) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    const ids = Array.from(new Set(requestIds.map((requestId) => requestId.trim()).filter(Boolean)));
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      [kind === "permission" ? "waitingPermissionIds" : "waitingQuestionIds"]: ids,
    })));
  },
  setError: (workspaceId, sessionId, message) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      errorActive: true,
      errorMessage: message ? message : "Session failed",
      runActive: false,
      retrying: false,
      runStatusAt: Date.now(),
      runHydrationAfter: null,
      assistantOutput: false,
      compacting: false,
    })));
  },
  clearError: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      errorActive: false,
      errorMessage: null,
    })));
  },
  setCompacting: (workspaceId, sessionId, compacting) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => updateRecord(state, workspace, session, (record) => ({
      ...record,
      compacting,
      errorActive: compacting ? false : record.errorActive,
      errorMessage: compacting ? null : record.errorMessage,
    })));
  },
  removeSession: (workspaceId, sessionId) => {
    const workspace = workspaceId.trim();
    const session = sessionId.trim();
    if (!workspace || !session) return;
    set((state) => {
      const workspaceRecords = state.recordsByWorkspaceId[workspace];
      const workspaceStatuses = state.statusesByWorkspaceId[workspace];
      if (!workspaceRecords?.[session] && !workspaceStatuses?.[session]) return state;
      const nextRecords = { ...(workspaceRecords ?? {}) };
      const nextStatuses = { ...(workspaceStatuses ?? {}) };
      delete nextRecords[session];
      delete nextStatuses[session];
      return {
        ...state,
        recordsByWorkspaceId: {
          ...state.recordsByWorkspaceId,
          [workspace]: nextRecords,
        },
        statusesByWorkspaceId: {
          ...state.statusesByWorkspaceId,
          [workspace]: nextStatuses,
        },
        waitingByWorkspaceId: updateWorkspaceWaiting(state.waitingByWorkspaceId, workspace, session, undefined),
      };
    });
  },
}));

export function getSessionActivityStatusLabel(status: SessionActivityStatus) {
  if (status === "thinking") return t("session.assistant_thinking");
  if (status === "responding") return t("session.assistant_responding");
  if (status === "waiting") return t("session.assistant_waiting");
  if (status === "compacting") return t("session.assistant_compacting");
  if (status === "error") return t("session.assistant_error");
  return t("session.assistant_idle");
}
