import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

/**
 * Provenance for imported sessions.
 *
 * Sessions live in the OpenCode database, which OpenWork does not own, so the
 * fact that a session arrived from a bundle is recorded here instead — the same
 * per-workspace store that backs session groups.
 *
 * An imported session is a record of a conversation that happened somewhere
 * else, so its transcript is permanently read-only. Management actions (rename,
 * archive, group, delete) stay available; only writes that would change the
 * conversation are refused.
 */

export type SessionImportMark = {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceSessionId: string;
  importedAt: number;
};

export type SessionImportState = {
  /** Keyed by the local session id created during import. */
  marks: Record<string, SessionImportMark>;
};

const EMPTY_SESSION_IMPORT_STATE: SessionImportState = { marks: {} };

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 256) : "";
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeSessionImportState(value: unknown): SessionImportState {
  if (!isRecord(value) || !isRecord(value.marks)) return EMPTY_SESSION_IMPORT_STATE;

  const marks: Record<string, SessionImportMark> = {};
  for (const [sessionId, rawMark] of Object.entries(value.marks)) {
    const localSessionId = normalizeId(sessionId);
    if (!localSessionId || !isRecord(rawMark)) continue;
    marks[localSessionId] = {
      sourceWorkspaceId: normalizeId(rawMark.sourceWorkspaceId),
      sourceWorkspaceName: normalizeName(rawMark.sourceWorkspaceName),
      sourceSessionId: normalizeId(rawMark.sourceSessionId),
      importedAt: normalizeTimestamp(rawMark.importedAt),
    };
  }
  return { marks };
}

function parseSessionImportState(stateJson: string): SessionImportState {
  try {
    return normalizeSessionImportState(JSON.parse(stateJson));
  } catch {
    return EMPTY_SESSION_IMPORT_STATE;
  }
}

const sessionImportStateStore = createWorkspaceKvStore<SessionImportState>({
  tableName: "session_import_states",
  valueColumn: "state_json",
  extraColumns: { schemaVersion: { name: "schema_version", definition: "INTEGER NOT NULL DEFAULT 1", value: 1 } },
  parse: parseSessionImportState,
  serialize: (value) => JSON.stringify(value),
});

export async function readSessionImportState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ state: SessionImportState; updatedAt: number | null }> {
  const row = await sessionImportStateStore.getRow(config, workspaceId);
  if (!row || row.updatedAt === null) return { state: EMPTY_SESSION_IMPORT_STATE, updatedAt: null };
  return { state: row.value, updatedAt: row.updatedAt };
}

const updateQueueByWorkspace = new Map<string, Promise<void>>();

export async function updateSessionImportState(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: SessionImportState) => SessionImportState,
): Promise<{ state: SessionImportState; updatedAt: number }> {
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
    const current = await readSessionImportState(config, workspaceId);
    const next = normalizeSessionImportState(updater(current.state));
    const updatedAt = Date.now();
    await sessionImportStateStore.set(config, workspaceId, next, updatedAt);
    return { state: next, updatedAt };
  } finally {
    release();
    if (updateQueueByWorkspace.get(key) === currentQueue) {
      updateQueueByWorkspace.delete(key);
    }
  }
}

export async function recordSessionImports(
  config: ServerConfig,
  workspaceId: string,
  entries: Array<{ sessionId: string; mark: SessionImportMark }>,
): Promise<void> {
  if (!entries.length) return;
  await updateSessionImportState(config, workspaceId, (current) => {
    const marks = { ...current.marks };
    for (const entry of entries) {
      marks[entry.sessionId] = entry.mark;
    }
    return { marks };
  });
}

export async function forgetSessionImport(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const current = await readSessionImportState(config, workspaceId);
  if (!current.state.marks[sessionId]) return;
  await updateSessionImportState(config, workspaceId, (state) => {
    const marks = { ...state.marks };
    delete marks[sessionId];
    return { marks };
  });
}

export async function isSessionImported(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const current = await readSessionImportState(config, workspaceId);
  return Boolean(current.state.marks[sessionId]);
}

/**
 * Requests that would change a conversation. Reads, aborts, forks, and
 * session-level management calls are deliberately absent: an imported session
 * can still be renamed, archived, grouped, forked, or deleted.
 */
const TRANSCRIPT_MUTATION_PATTERNS: readonly RegExp[] = [
  /^\/session\/([^/]+)\/(?:prompt|prompt_async|command|shell|revert|unrevert|summarize|compact)$/,
  /^\/session\/([^/]+)\/message(?:\/[^/]+)?$/,
];

export function transcriptMutationSessionId(method: string, normalizedPath: string): string | null {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return null;
  for (const pattern of TRANSCRIPT_MUTATION_PATTERNS) {
    const match = normalizedPath.match(pattern);
    const captured = match?.[1];
    if (captured) return decodeURIComponent(captured);
  }
  return null;
}
