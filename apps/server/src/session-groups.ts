import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { shortId } from "./utils.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export type SessionGroupDefinition = {
  id: string;
  label: string;
};

export type SessionGroupState = {
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type SessionGroupEventAction = "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";

export type SessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: SessionGroupEventAction;
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

const EMPTY_SESSION_GROUP_STATE: SessionGroupState = { groups: [], assignments: {} };

type SessionGroupEventState = {
  seq: number;
  events: SessionGroupEvent[];
};

function normalizeGroupId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, 128);
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120);
}

export function createSessionGroupId(): string {
  return `grp_${Date.now().toString(36)}_${shortId()}`;
}

export function normalizeSessionGroupState(value: unknown): SessionGroupState {
  if (!isRecord(value)) return EMPTY_SESSION_GROUP_STATE;

  const groups: SessionGroupDefinition[] = [];
  const seenGroupIds = new Set<string>();
  if (Array.isArray(value.groups)) {
    for (const item of value.groups) {
      if (!isRecord(item)) continue;
      const id = normalizeGroupId(item.id);
      const label = normalizeLabel(item.label);
      if (!id || !label || seenGroupIds.has(id)) continue;
      groups.push({ id, label });
      seenGroupIds.add(id);
    }
  }

  const assignments: Record<string, string> = {};
  if (isRecord(value.assignments)) {
    for (const [sessionId, rawGroupId] of Object.entries(value.assignments)) {
      const normalizedSessionId = sessionId.trim().slice(0, 256);
      const groupId = normalizeGroupId(rawGroupId);
      if (!normalizedSessionId || !groupId || !seenGroupIds.has(groupId)) continue;
      assignments[normalizedSessionId] = groupId;
    }
  }

  return { groups, assignments };
}

const updateQueueByWorkspace = new Map<string, Promise<void>>();

function parseSessionGroupState(stateJson: string): SessionGroupState {
  try {
    return normalizeSessionGroupState(JSON.parse(stateJson));
  } catch {
    return EMPTY_SESSION_GROUP_STATE;
  }
}

const sessionGroupStateStore = createWorkspaceKvStore<SessionGroupState>({
  tableName: "session_group_states",
  valueColumn: "state_json",
  extraColumns: { schemaVersion: { name: "schema_version", definition: "INTEGER NOT NULL DEFAULT 1", value: 1 } },
  parse: parseSessionGroupState,
  serialize: (value) => JSON.stringify(value),
});

export async function readSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ state: SessionGroupState; updatedAt: number | null }> {
  const row = await sessionGroupStateStore.getRow(config, workspaceId);
  if (!row || row.updatedAt === null) return { state: EMPTY_SESSION_GROUP_STATE, updatedAt: null };
  return { state: row.value, updatedAt: row.updatedAt };
}

export async function writeSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
  state: SessionGroupState,
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  const next = normalizeSessionGroupState(state);
  const updatedAt = Date.now();
  await sessionGroupStateStore.set(config, workspaceId, next, updatedAt);
  return { state: next, updatedAt };
}

export async function updateSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: SessionGroupState) => SessionGroupState,
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  const key = `${runtimeDbPath(config)}:${workspaceId}`;
  const previous = updateQueueByWorkspace.get(key) ?? Promise.resolve();
  let release = () => {};
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const currentQueue = previous.then(() => queued, () => queued);
  updateQueueByWorkspace.set(key, currentQueue);

  await previous.catch(() => undefined);
  try {
    const current = await readSessionGroupState(config, workspaceId);
    return await writeSessionGroupState(config, workspaceId, updater(current.state));
  } finally {
    release();
    if (updateQueueByWorkspace.get(key) === currentQueue) {
      updateQueueByWorkspace.delete(key);
    }
  }
}

export class SessionGroupEventStore {
  private eventsByWorkspace = new Map<string, SessionGroupEventState>();
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  record(
    workspaceId: string,
    action: SessionGroupEventAction,
    details?: { groupId?: string; sessionId?: string },
  ): SessionGroupEvent {
    const state = this.eventsByWorkspace.get(workspaceId) ?? { seq: 0, events: [] };
    const event: SessionGroupEvent = {
      id: shortId(),
      seq: ++state.seq,
      workspaceId,
      type: "session_groups.updated",
      action,
      ...(details?.groupId ? { groupId: details.groupId } : {}),
      ...(details?.sessionId ? { sessionId: details.sessionId } : {}),
      timestamp: Date.now(),
    };

    state.events.push(event);
    if (state.events.length > this.maxSize) {
      state.events.splice(0, state.events.length - this.maxSize);
    }
    this.eventsByWorkspace.set(workspaceId, state);
    return event;
  }

  list(workspaceId: string, since?: number): SessionGroupEvent[] {
    const cursor = typeof since === "number" && Number.isFinite(since) ? since : 0;
    const state = this.eventsByWorkspace.get(workspaceId);
    return state ? state.events.filter((event) => event.seq > cursor) : [];
  }

  cursor(workspaceId: string): number {
    return this.eventsByWorkspace.get(workspaceId)?.seq ?? 0;
  }
}
