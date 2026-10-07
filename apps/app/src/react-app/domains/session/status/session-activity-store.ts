/** @jsxImportSource react */
import { create } from "zustand";
import { isToolUIPart, type UIMessage } from "ai";
import { isTaskToolPart, taskChildSessionId } from "../../../../lib/build-in-tools";
import { isToolPartInFlight } from "../../../../lib/tool-activity";
import { transcriptProgress } from "./session-progress";
import { messageActivity, messageNotice, readRunActivities, type RunActivity, type SessionNotice } from "../../../../lib/session-run";

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
  runs: Record<string, RunActivity>;
  currentRunId: string | null;
  pendingNotice: SessionNotice | null;
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
  foregroundChildIds: string[];
  independentToolActive: boolean;
  updatedAt: number;
};

type SessionLike = {
  id: string;
  parentID?: string | null;
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
  bindRunTimingScope: (workspaceId: string, sessionId: string, owner: string | null) => void;
  beginRun: (workspaceId: string, sessionId: string, promptId: string, startedAt: number) => void;
  cancelUnadmittedRun: (workspaceId: string, sessionId: string, promptId: string) => void;
  markRunStopped: (workspaceId: string, sessionId: string) => void;
  observeTranscript: (
    workspaceId: string,
    sessionId: string,
    messages: UIMessage[],
    snapshot?: boolean,
    options?: { snapshotStartedAt?: number },
  ) => void;
  markMessageRole: (workspaceId: string, sessionId: string, messageId: string, role: SessionMessageRole) => void;
  markAssistantOutput: (workspaceId: string, sessionId: string, messageId?: string, options?: { allowUnknownMessageRole?: boolean; markDeltaProgress?: boolean }) => void;
  setWaitingRequest: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestId: string, waiting: boolean) => void;
  replaceWaitingRequests: (workspaceId: string, sessionId: string, kind: "permission" | "question", requestIds: string[]) => void;
  setError: (workspaceId: string, sessionId: string, message?: string) => void;
  clearError: (workspaceId: string, sessionId: string) => void;
  setCompacting: (workspaceId: string, sessionId: string, compacting: boolean) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
};

const createRecord = (): SessionActivityRecord => ({
  runs: {},
  currentRunId: null,
  pendingNotice: null,
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
  foregroundChildIds: [],
  independentToolActive: false,
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
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
    && current.runs === next.runs
    && current.currentRunId === next.currentRunId
    && current.pendingNotice === next.pendingNotice
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
    && sameStrings(current.childSessionIds, next.childSessionIds)
    && sameStrings(current.foregroundChildIds, next.foregroundChildIds)
    && current.independentToolActive === next.independentToolActive;
}

type SessionActivityDerivedState = Pick<SessionActivityStore, "recordsByWorkspaceId" | "statusesByWorkspaceId" | "waitingByWorkspaceId">;

// The history owner includes the principal, server, workspace and session.
// Until a surface supplies it, activity is live-only and is never persisted.
const timingOwners = new Map<string, string | null>();
const timingIdentity = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
function readTiming(owner: string | null | undefined) {
  if (!owner || typeof localStorage === "undefined") return {};
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`openwork:run-timing:${owner}`) ?? "null");
    return saved && typeof saved === "object" && "runs" in saved ? readRunActivities(saved.runs) : {};
  } catch { return {}; }
}

function updateRecord(
  state: SessionActivityDerivedState,
  workspaceId: string,
  sessionId: string,
  updater: (record: SessionActivityRecord) => SessionActivityRecord,
  visited = new Set<string>(),
): SessionActivityDerivedState {
  if (visited.has(sessionId)) return state;
  visited.add(sessionId);
  const workspaceRecords = state.recordsByWorkspaceId[workspaceId] ?? {};
  const currentRecord = workspaceRecords[sessionId];
  let nextRecord = updater(currentRecord ?? createRecord());
  const now = Date.now();
  const previous = currentRecord ?? createRecord();
  const owner = timingOwners.get(timingIdentity(workspaceId, sessionId));
  if (!currentRecord) nextRecord = { ...nextRecord, runs: { ...readTiming(owner), ...nextRecord.runs } };
  if (nextRecord.runActive && !previous.runActive) {
    const id = nextRecord.currentRunId && !nextRecord.runs[nextRecord.currentRunId]?.endedAt ? nextRecord.currentRunId : nextRecord.pendingNotice?.id ?? `run:${nextRecord.runStartedAt || now}`;
    const saved = nextRecord.runs[id];
    nextRecord = { ...nextRecord, currentRunId: id, pendingNotice: null, runs: { ...nextRecord.runs,
      [id]: saved && !saved.endedAt ? saved : { id, initiator: nextRecord.pendingNotice ? "notice" : "restored", startedAt: nextRecord.pendingNotice?.timestamp || nextRecord.runStartedAt || now, waiting: [] } } };
  }
  const runId = nextRecord.currentRunId;
  const run = runId ? nextRecord.runs[runId] : undefined;
  if (run && !run.endedAt) {
    const waiting = nextRecord.waitingPermissionIds.length + nextRecord.waitingQuestionIds.length > 0
      || nextRecord.foregroundChildIds.length > 0 && !nextRecord.independentToolActive && nextRecord.foregroundChildIds.every(id => {
        const child = workspaceRecords[id];
        return (child?.waitingPermissionIds.length ?? 0) + (child?.waitingQuestionIds.length ?? 0) > 0;
      });
    const last = run.waiting.at(-1);
    let waits = run.waiting;
    if (waiting && (!last || last.end !== undefined)) waits = [...waits, { start: now }];
    if (!waiting && last && last.end === undefined) waits = [...waits.slice(0, -1), { ...last, end: now }];
    if (waits !== run.waiting || !nextRecord.runActive) {
      nextRecord = { ...nextRecord, runs: { ...nextRecord.runs, [run.id]: { ...run, waiting: waits,
        ...(!nextRecord.runActive ? { endedAt: now, outcome: run.outcome ?? (nextRecord.errorActive ? "failed" as const : "completed" as const) } : {}) } } };
    }
  }
  if (owner && nextRecord.runs !== previous.runs && typeof localStorage !== "undefined") {
    try { localStorage.setItem(`openwork:run-timing:${owner}`, JSON.stringify({ runs: Object.fromEntries(Object.entries(nextRecord.runs).slice(-200)) })); } catch { /* Storage may be disabled. */ }
  }
  const status = statusForRecord(nextRecord);
  if (currentRecord && sameActivityRecord(currentRecord, nextRecord, status)) return state;
  const recordWithStatus = { ...nextRecord, status, updatedAt: Date.now() };
  let nextState: SessionActivityDerivedState = {
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
  for (const [parentId, parent] of Object.entries(workspaceRecords)) {
    if (parent.foregroundChildIds.includes(sessionId)) nextState = updateRecord(nextState, workspaceId, parentId, record => record, visited);
  }
  return nextState;
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
  bindRunTimingScope: (workspaceId, sessionId, owner) => {
    const identity = timingIdentity(workspaceId, sessionId);
    const previousOwner = timingOwners.get(identity);
    if (timingOwners.has(identity) && previousOwner === owner) return;
    timingOwners.set(identity, owner);
    if (timingOwners.size > 500) timingOwners.delete(timingOwners.keys().next().value!);
    const saved = readTiming(owner);
    set(state => updateRecord(state, workspaceId, sessionId, record => {
      const changedOwner = previousOwner !== undefined && previousOwner !== owner;
      let runs = changedOwner ? saved : { ...record.runs, ...saved };
      const current = !changedOwner && record.currentRunId ? runs[record.currentRunId] : undefined;
      let currentRunId = current ? record.currentRunId : null;
      if (changedOwner && record.runActive) {
        currentRunId = `run:${Date.now()}`;
        runs = { ...runs, [currentRunId]: { id: currentRunId, initiator: "restored", startedAt: Date.now(), waiting: [] } };
      }
      return { ...record, runs, currentRunId,
        ...(changedOwner ? { runStartedAt: record.runActive ? Date.now() : 0 } : {}),
        ...(current && !current.endedAt ? { runStartedAt: current.startedAt } : {}) };
    }));
  },
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
        if (session.parentID && session.parentID !== sessionId) {
          nextState = updateRecord(nextState, id, session.parentID, record => ({ ...record,
            childSessionIds: addValue(record.childSessionIds, sessionId) }));
        }
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
  beginRun: (workspaceId, sessionId, promptId, startedAt) => {
    set(state => updateRecord(state, workspaceId, sessionId, record => {
      if (record.runActive && record.currentRunId) {
        const run = record.runs[record.currentRunId];
        if (run && !run.promptIds?.includes(promptId)) return { ...record, runs: { ...record.runs,
          [run.id]: { ...run, promptIds: [...(run.promptIds ?? [run.id]), promptId] } } };
        return record;
      } // Steering belongs to the current run.
      return { ...record, runActive: true, runStartedAt: startedAt, runStatusAt: startedAt,
        currentRunId: promptId, pendingNotice: null, assistantOutput: false, errorActive: false, errorMessage: null,
        runs: { ...record.runs, [promptId]: { id: promptId, promptIds: [promptId], initiator: "prompt", startedAt, waiting: [] } } };
    }));
  },
  cancelUnadmittedRun: (workspaceId, sessionId, promptId) => {
    set(state => updateRecord(state, workspaceId, sessionId, record => {
      if (record.currentRunId !== promptId) {
        const run = record.currentRunId ? record.runs[record.currentRunId] : undefined;
        if (!run?.promptIds?.includes(promptId)) return record;
        return { ...record, runs: { ...record.runs, [run.id]: { ...run, promptIds: run.promptIds.filter(id => id !== promptId) } } };
      }
      if (record.assistantOutput) return record;
      const runs = { ...record.runs };
      delete runs[promptId];
      return { ...record, runs, currentRunId: null, runActive: false, runStartedAt: 0 };
    }));
  },
  markRunStopped: (workspaceId, sessionId) => {
    set(state => updateRecord(state, workspaceId, sessionId, record => {
      const id = record.currentRunId;
      if (!id || !record.runs[id]) return record;
      return { ...record, runs: { ...record.runs, [id]: { ...record.runs[id], outcome: "stopped" } } };
    }));
  },
  observeTranscript: (workspaceId, sessionId, messages, snapshot = false, options = {}) => {
    set((state) => updateRecord(state, workspaceId, sessionId, (record) => {
      const progress = transcriptProgress(messages, record.progressParts);
      const childSessionIds = new Set(record.childSessionIds);
      const foregroundChildIds: string[] = [];
      let independentToolActive = false;
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const part of message.parts) {
          if (!isToolUIPart(part)) continue;
          if (!isTaskToolPart(part)) { if (isToolPartInFlight(part)) independentToolActive = true; continue; }
          const childId = taskChildSessionId(part);
          if (childId) childSessionIds.add(childId);
          if (childId && isToolPartInFlight(part) && part.input?.background !== true) foregroundChildIds.push(childId);
        }
      }
      const snapshotStartedAt = options.snapshotStartedAt;
      const activeRun = record.currentRunId ? record.runs[record.currentRunId] : undefined;
      // A live admission or native continuation owns its steering messages.
      // A coarse restored busy status does not establish that association:
      // newer transcript prompts must clear the previous turn's activity.
      const joinsBusyRun = record.runActive && Boolean(record.currentRunId)
        && (activeRun?.initiator !== "restored" || Boolean(progress.latestUserId && activeRun.promptIds?.includes(progress.latestUserId)));
      const turnChanged = !joinsBusyRun && record.transcriptActivity !== null
        && record.transcriptActivity.latestUserId !== progress.latestUserId;
      const progressChanged = record.progressRevision !== progress.revision;
      const observedAt = snapshot ? snapshotStartedAt ?? 0 : turnChanged || progressChanged ? Date.now() : 0;
      const next = reconcileTranscriptActivity({
        ...record,
        foregroundChildIds: sameStrings(record.foregroundChildIds, foregroundChildIds) ? record.foregroundChildIds : foregroundChildIds,
        independentToolActive,
        childSessionIds: childSessionIds.size === record.childSessionIds.length ? record.childSessionIds : [...childSessionIds],
        ...(turnChanged ? {
          assistantOutput: false,
          runStartedAt: record.runActive && (!record.currentRunId || record.runs[record.currentRunId]?.initiator === "restored")
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
      // Adopt the initiating prompt once, without restarting a busy run for
      // steering messages. Native notice runs retain their own identity.
      if (next.runActive && next.currentRunId?.startsWith("run:") && progress.latestUserId) {
        const run = next.runs[next.currentRunId];
        if (run) {
          next.currentRunId = progress.latestUserId;
          next.runs = { ...next.runs, [progress.latestUserId]: next.runs[progress.latestUserId] && !next.runs[progress.latestUserId].endedAt
              ? next.runs[progress.latestUserId] : { ...run, id: progress.latestUserId, startedAt: progress.latestUserCreated ?? run.startedAt } };
        }
      }
      const last = messages.at(-1);
      const notice = last ? messageNotice(last) : null;
      if (notice && !next.runActive && !next.runs[notice.id] && next.pendingNotice?.id !== notice.id) next.pendingNotice = notice;
      if (next.runActive && next.currentRunId) {
        const run = next.runs[next.currentRunId];
        const joined = messages.map(messageNotice).filter(notice => notice && notice.timestamp >= (run?.startedAt ?? Infinity))
          .map(notice => notice!.id).filter(id => id !== run?.id && !next.runs[id] && !run?.noticeIds?.includes(id));
        if (run && joined.length) next.runs = { ...next.runs, [run.id]: { ...run, noticeIds: [...(run.noticeIds ?? []), ...joined] } };
      }
      if (last && messageActivity(last).outcome === "stopped" && next.currentRunId && next.runs[next.currentRunId]) {
        next.runs = { ...next.runs, [next.currentRunId]: { ...next.runs[next.currentRunId], outcome: "stopped" } };
      }
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
      return {
        ...record,
        assistantOutput: true,
        lastProgressAt: options?.markDeltaProgress ? Math.max(record.lastProgressAt, Date.now()) : record.lastProgressAt,
      };
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

export type SessionChildIds = Readonly<Record<string, readonly string[]>>;

export function createSessionChildIdsSelector() {
  let previousRecords: SessionActivityStore["recordsByWorkspaceId"] = {};
  let childrenByWorkspaceId: Readonly<Record<string, SessionChildIds>> = {};

  return (state: Pick<SessionActivityStore, "recordsByWorkspaceId">) => {
    if (state.recordsByWorkspaceId === previousRecords) return childrenByWorkspaceId;
    let next = childrenByWorkspaceId;
    for (const [workspaceId, records] of Object.entries(state.recordsByWorkspaceId)) {
      if (records === previousRecords[workspaceId]) continue;
      const previous = childrenByWorkspaceId[workspaceId];
      const children: Record<string, readonly string[]> = {};
      let changed = false;
      for (const [sessionId, record] of Object.entries(records)) {
        if (record.childSessionIds.length === 0) continue;
        const prior = previous?.[sessionId];
        if (prior && sameStrings(prior, record.childSessionIds)) {
          children[sessionId] = prior;
        } else {
          children[sessionId] = record.childSessionIds;
          changed = true;
        }
      }
      const count = Object.keys(children).length;
      if (!changed && count === Object.keys(previous ?? {}).length) continue;
      const updated = { ...next };
      if (count > 0) updated[workspaceId] = children;
      else delete updated[workspaceId];
      next = updated;
    }
    for (const workspaceId of Object.keys(childrenByWorkspaceId)) {
      if (state.recordsByWorkspaceId[workspaceId]) continue;
      const updated = { ...next };
      delete updated[workspaceId];
      next = updated;
    }
    previousRecords = state.recordsByWorkspaceId;
    childrenByWorkspaceId = next;
    return next;
  };
}

export function getSessionActivityStatusLabel(status: SessionActivityStatus) {
  if (status === "thinking") return t("session.assistant_thinking");
  if (status === "responding") return t("session.assistant_responding");
  if (status === "waiting") return t("session.assistant_waiting");
  if (status === "compacting") return t("session.assistant_compacting");
  if (status === "error") return t("session.assistant_error");
  return t("session.assistant_idle");
}
