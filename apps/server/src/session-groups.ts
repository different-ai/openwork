import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ServerConfig } from "./types.js";
import { ensureDir, shortId } from "./utils.js";

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

const sessionGroupStates = sqliteTable("session_group_states", {
  workspaceId: text("workspace_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type SessionGroupDb = {
  get: (workspaceId: string) => { stateJson: string; updatedAt: number } | undefined;
  upsert: (value: { workspaceId: string; stateJson: string; updatedAt: number }) => void;
};

type SessionGroupEventState = {
  seq: number;
  events: SessionGroupEvent[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.OPENWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "openwork");
  return join(configDir, "runtime.sqlite");
}

async function openSessionGroupDb(path: string): Promise<SessionGroupDb> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    sqlite.run("CREATE TABLE IF NOT EXISTS session_group_states (workspace_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)");
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) => db
        .select()
        .from(sessionGroupStates)
        .where(eq(sessionGroupStates.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, stateJson, updatedAt }) => {
        db
          .insert(sessionGroupStates)
          .values({ workspaceId, stateJson, schemaVersion: 1, updatedAt })
          .onConflictDoUpdate({
            target: sessionGroupStates.workspaceId,
            set: { stateJson, schemaVersion: 1, updatedAt },
          })
          .run();
      },
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("CREATE TABLE IF NOT EXISTS session_group_states (workspace_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT state_json AS stateJson, updated_at AS updatedAt FROM session_group_states WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO session_group_states (workspace_id, state_json, schema_version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, schema_version = excluded.schema_version, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.stateJson !== "string" || typeof row.updatedAt !== "number") return undefined;
      return { stateJson: row.stateJson, updatedAt: row.updatedAt };
    },
    upsert: ({ workspaceId, stateJson, updatedAt }) => {
      upsert.run(workspaceId, stateJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<SessionGroupDb>>();
const updateQueueByWorkspace = new Map<string, Promise<void>>();

async function sessionGroupDb(config: ServerConfig): Promise<SessionGroupDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openSessionGroupDb(path);
  dbByPath.set(path, db);
  return db;
}

export async function readSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ state: SessionGroupState; updatedAt: number | null }> {
  const db = await sessionGroupDb(config);
  const row = db.get(workspaceId);
  if (!row) return { state: EMPTY_SESSION_GROUP_STATE, updatedAt: null };
  try {
    return { state: normalizeSessionGroupState(JSON.parse(row.stateJson)), updatedAt: row.updatedAt };
  } catch {
    return { state: EMPTY_SESSION_GROUP_STATE, updatedAt: row.updatedAt };
  }
}

export async function writeSessionGroupState(
  config: ServerConfig,
  workspaceId: string,
  state: SessionGroupState,
): Promise<{ state: SessionGroupState; updatedAt: number }> {
  const db = await sessionGroupDb(config);
  const next = normalizeSessionGroupState(state);
  const updatedAt = Date.now();
  db.upsert({ workspaceId, stateJson: JSON.stringify(next), updatedAt });
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
