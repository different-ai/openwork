import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { RegistryService } from "./registry-service.js";
import type { ServerRepositories } from "../database/repositories.js";
import type { WorkspaceRecord } from "../database/types.js";
import type { RuntimeService } from "./runtime-service.js";
import type { ConfigMaterializationService } from "./config-materialization-service.js";
import { RouteError } from "../http.js";
import { requestRemoteOpenwork, requestRemoteOpenworkRaw, resolveRemoteWorkspaceTarget } from "../adapters/remote-openwork.js";

const FILE_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1000;
const FILE_SESSION_MIN_TTL_MS = 30 * 1000;
const FILE_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SESSION_MAX_BATCH_ITEMS = 64;
const FILE_SESSION_MAX_FILE_BYTES = 5_000_000;
const FILE_SESSION_CATALOG_DEFAULT_LIMIT = 2000;
const FILE_SESSION_CATALOG_MAX_LIMIT = 10000;

type ReloadReason = "agents" | "commands" | "config" | "mcp" | "plugins" | "skills";

type ReloadTrigger = {
  action?: "added" | "removed" | "updated";
  name?: string;
  path?: string;
  type: "agent" | "command" | "config" | "mcp" | "plugin" | "skill";
};

type ReloadEvent = {
  id: string;
  reason: ReloadReason;
  seq: number;
  timestamp: number;
  trigger?: ReloadTrigger;
  workspaceId: string;
};

type FileCatalogEntry = {
  kind: "dir" | "file";
  mtimeMs: number;
  path: string;
  revision: string;
  size: number;
};

type FileSessionRecord = {
  actorTokenHash: string;
  canWrite: boolean;
  createdAt: number;
  expiresAt: number;
  id: string;
  workspaceId: string;
  workspaceRoot: string;
};

type FileSessionEvent = {
  id: string;
  path: string;
  revision?: string;
  seq: number;
  timestamp: number;
  toPath?: string;
  type: "delete" | "mkdir" | "rename" | "write";
  workspaceId: string;
};

class LocalFileSessionStore {
  private sessions = new Map<string, FileSessionRecord>();

  private workspaceEvents = new Map<string, { events: FileSessionEvent[]; seq: number }>();

  close(sessionId: string) {
    return this.sessions.delete(sessionId);
  }

  create(input: Omit<FileSessionRecord, "createdAt" | "expiresAt" | "id"> & { ttlMs: number }) {
    const now = nowMs();
    const record: FileSessionRecord = {
      ...input,
      createdAt: now,
      expiresAt: now + input.ttlMs,
      id: randomUUID(),
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(sessionId: string) {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && session.expiresAt <= nowMs()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  listWorkspaceEvents(workspaceId: string, since = 0) {
    const state = this.workspaceEvents.get(workspaceId);
    if (!state) {
      return { cursor: 0, items: [] as FileSessionEvent[] };
    }
    return {
      cursor: state.seq,
      items: state.events.filter((event) => event.seq > since),
    };
  }

  recordWorkspaceEvent(input: Omit<FileSessionEvent, "id" | "seq" | "timestamp">) {
    const state = this.workspaceEvents.get(input.workspaceId) ?? { events: [], seq: 0 };
    const event: FileSessionEvent = {
      ...input,
      id: randomUUID(),
      seq: state.seq + 1,
      timestamp: nowMs(),
    };
    state.seq = event.seq;
    state.events.push(event);
    if (state.events.length > 500) {
      state.events.splice(0, state.events.length - 500);
    }
    this.workspaceEvents.set(input.workspaceId, state);
    return event;
  }

  renew(sessionId: string, ttlMs: number) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }
    session.expiresAt = nowMs() + ttlMs;
    this.sessions.set(sessionId, session);
    return session;
  }
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function recordAuditEntry(workspaceId: string, workspaceRoot: string, action: string, target: string, summary: string) {
  const auditRoot = process.env.OPENWORK_DATA_DIR?.trim()
    ? path.join(process.env.OPENWORK_DATA_DIR.trim(), "audit")
    : path.join(workspaceRoot, ".opencode", "openwork");
  fs.mkdirSync(auditRoot, { recursive: true });
  const filePath = process.env.OPENWORK_DATA_DIR?.trim()
    ? path.join(auditRoot, `${workspaceId}.jsonl`)
    : path.join(auditRoot, "audit.jsonl");
  const entry = {
    action,
    actor: { type: "remote" },
    id: randomUUID(),
    summary,
    target,
    timestamp: nowMs(),
    workspaceId,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function initializeWorkspaceFiles(workspaceRoot: string) {
  fs.mkdirSync(path.join(workspaceRoot, ".opencode"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, ".opencode", "openwork"), { recursive: true });
}

function resolveWorkspaceOrThrow(repositories: ServerRepositories, workspaceId: string) {
  const workspace = repositories.workspaces.getById(workspaceId);
  if (!workspace) {
    throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
  }
  if (!workspace.dataDir?.trim()) {
    throw new RouteError(400, "invalid_request", `Workspace ${workspace.id} does not have a local data directory.`);
  }
  return workspace;
}

function resolveWorkspaceRecordOrThrow(repositories: ServerRepositories, workspaceId: string) {
  const workspace = repositories.workspaces.getById(workspaceId);
  if (!workspace) {
    throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
  }
  return workspace;
}

function resolveWorkspaceRoot(workspace: WorkspaceRecord) {
  const root = workspace.dataDir?.trim();
  if (!root) {
    throw new RouteError(400, "invalid_request", `Workspace ${workspace.id} does not have a local data directory.`);
  }
  return root;
}

function normalizeWorkspaceRelativePath(input: string, options: { allowSubdirs: boolean }) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new RouteError(400, "invalid_request", "Path is required.");
  }
  if (raw.includes("\u0000")) {
    throw new RouteError(400, "invalid_request", "Path contains a null byte.");
  }
  let normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").replace(/^workspace\//, "").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new RouteError(400, "invalid_request", "Path is required.");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new RouteError(400, "invalid_request", "Subdirectories are not allowed.");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new RouteError(400, "invalid_request", "Path traversal is not allowed.");
    }
  }
  normalized = parts.join("/");
  return normalized;
}

function resolveSafeChildPath(root: string, child: string) {
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, child);
  if (candidate === rootResolved || !candidate.startsWith(rootResolved + path.sep)) {
    throw new RouteError(400, "invalid_request", "Path traversal is not allowed.");
  }
  return candidate;
}

function fileRevision(info: { mtimeMs: number; size: number }) {
  return `${Math.floor(info.mtimeMs)}:${info.size}`;
}

function parseFileSessionTtlMs(input: unknown) {
  const raw = typeof input === "number" && Number.isFinite(input) ? input : Number.NaN;
  if (Number.isNaN(raw)) return FILE_SESSION_DEFAULT_TTL_MS;
  const ttlMs = Math.floor(raw * 1000);
  if (ttlMs < FILE_SESSION_MIN_TTL_MS) return FILE_SESSION_MIN_TTL_MS;
  if (ttlMs > FILE_SESSION_MAX_TTL_MS) return FILE_SESSION_MAX_TTL_MS;
  return ttlMs;
}

function parseCatalogLimit(input: string | null) {
  if (!input) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), FILE_SESSION_CATALOG_MAX_LIMIT);
}

function parseCursor(input: string | null) {
  if (!input) return 0;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parsePathFilter(input: string | null) {
  if (!input?.trim()) return null;
  return normalizeWorkspaceRelativePath(input, { allowSubdirs: true });
}

function matchesCatalogFilter(pathValue: string, filter: string | null) {
  if (!filter) return true;
  return pathValue === filter || pathValue.startsWith(`${filter}/`);
}

function parseBatchPathList(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RouteError(400, "invalid_request", "paths must be a non-empty array.");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new RouteError(400, "invalid_request", `paths must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items.`);
  }
  return input.map((item) => normalizeWorkspaceRelativePath(String(item ?? ""), { allowSubdirs: true }));
}

function parseBatchWriteList(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RouteError(400, "invalid_request", "writes must be a non-empty array.");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new RouteError(400, "invalid_request", `writes must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items.`);
  }
  return input.map((item) => {
    if (!item || typeof item !== "object") {
      throw new RouteError(400, "invalid_request", "Write entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64.trim() : "";
    if (!contentBase64) {
      throw new RouteError(400, "invalid_request", "contentBase64 is required.");
    }
    return {
      contentBase64,
      force: record.force === true,
      ifMatchRevision: typeof record.ifMatchRevision === "string" && record.ifMatchRevision.trim() ? record.ifMatchRevision.trim() : undefined,
      path: normalizeWorkspaceRelativePath(String(record.path ?? ""), { allowSubdirs: true }),
    };
  });
}

function parseOperations(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RouteError(400, "invalid_request", "operations must be a non-empty array.");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new RouteError(400, "invalid_request", `operations must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items.`);
  }
  return input as Array<Record<string, unknown>>;
}

function resolveInboxDir(workspaceRoot: string) {
  return path.join(workspaceRoot, ".opencode", "openwork", "inbox");
}

function resolveOutboxDir(workspaceRoot: string) {
  return path.join(workspaceRoot, ".opencode", "openwork", "outbox");
}

function encodeArtifactId(relativePath: string) {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function decodeArtifactId(id: string) {
  const raw = id.trim();
  if (!raw) {
    throw new RouteError(400, "invalid_request", "Artifact id is required.");
  }
  try {
    return normalizeWorkspaceRelativePath(Buffer.from(raw, "base64url").toString("utf8"), { allowSubdirs: true });
  } catch {
    throw new RouteError(400, "invalid_request", "Artifact id is invalid.");
  }
}

class ReloadEventStore {
  private events: ReloadEvent[] = [];

  private lastRecorded = new Map<string, number>();

  private seq = 0;

  list(workspaceId: string, since = 0) {
    return {
      cursor: this.seq,
      items: this.events.filter((event) => event.workspaceId === workspaceId && event.seq > since),
    };
  }

  record(workspaceId: string, reason: ReloadReason, trigger?: ReloadTrigger, debounceMs = 750) {
    const key = `${workspaceId}:${reason}:${trigger?.type ?? "unknown"}:${trigger?.path ?? ""}`;
    const now = nowMs();
    const last = this.lastRecorded.get(key) ?? 0;
    if (now - last < debounceMs) {
      return null;
    }
    this.lastRecorded.set(key, now);
    const event: ReloadEvent = {
      id: randomUUID(),
      reason,
      seq: ++this.seq,
      timestamp: now,
      ...(trigger ? { trigger } : {}),
      workspaceId,
    };
    this.events.push(event);
    if (this.events.length > 500) {
      this.events.splice(0, this.events.length - 500);
    }
    return event;
  }
}

export type WorkspaceFileService = ReturnType<typeof createWorkspaceFileService>;

export function createWorkspaceFileService(input: {
  config: ConfigMaterializationService;
  registry: RegistryService;
  repositories: ServerRepositories;
  runtime: RuntimeService;
  serverId: string;
}) {
  const fileSessions = new LocalFileSessionStore();
  const reloadEvents = new ReloadEventStore();
  const watcherClosers = new Map<string, () => void>();

  function getRemoteServerOrThrow(workspace: WorkspaceRecord) {
    const server = input.repositories.servers.getById(workspace.serverId);
    if (!server) {
      throw new RouteError(502, "bad_gateway", `Workspace ${workspace.id} points at missing remote server ${workspace.serverId}.`);
    }
    return server;
  }

  function getRemoteWorkspacePath(workspace: WorkspaceRecord, suffix: string) {
    const server = getRemoteServerOrThrow(workspace);
    const target = resolveRemoteWorkspaceTarget(server, workspace);
    return {
      path: `/workspaces/${encodeURIComponent(target.remoteWorkspaceId)}${suffix}`,
      server,
    };
  }

  function updateRuntimeHealth(details: Record<string, unknown>) {
    const current = input.repositories.serverRuntimeState.getByServerId(input.serverId);
    const health = current?.health && typeof current.health === "object" ? { ...current.health } : {};
    const runtime = health.runtime && typeof health.runtime === "object" ? { ...(health.runtime as Record<string, unknown>) } : {};
    runtime.phase7 = {
      ...(runtime.phase7 && typeof runtime.phase7 === "object" ? runtime.phase7 as Record<string, unknown> : {}),
      ...details,
    };
    health.runtime = runtime;
    input.repositories.serverRuntimeState.upsert({
      health,
      lastExit: current?.lastExit ?? null,
      lastStartedAt: current?.lastStartedAt ?? null,
      opencodeBaseUrl: current?.opencodeBaseUrl ?? null,
      opencodeStatus: current?.opencodeStatus ?? "unknown",
      opencodeVersion: current?.opencodeVersion ?? null,
      restartPolicy: current?.restartPolicy ?? null,
      routerStatus: current?.routerStatus ?? "disabled",
      routerVersion: current?.routerVersion ?? null,
      runtimeVersion: current?.runtimeVersion ?? null,
      serverId: input.serverId,
    });
  }

  function classifyReloadTrigger(changedPath: string): { reason: ReloadReason; trigger: ReloadTrigger } {
    const normalized = changedPath.replace(/\\/g, "/");
    if (normalized.includes("/.opencode/skills/")) {
      const parts = normalized.split("/");
      const name = parts[parts.length - 2] ?? "skill";
      return { reason: "skills", trigger: { action: "updated", name, path: changedPath, type: "skill" } };
    }
    if (normalized.includes("/.opencode/commands/")) {
      const name = path.basename(changedPath).replace(/\.md$/i, "");
      return { reason: "commands", trigger: { action: "updated", name, path: changedPath, type: "command" } };
    }
    return {
      reason: "config",
      trigger: { action: "updated", name: path.basename(changedPath), path: changedPath, type: "config" },
    };
  }

  function startWorkspaceWatchers(workspaceId: string) {
    const roots = input.config.listWatchRoots(workspaceId);
    const watchers: fs.FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (changedPath: string) => {
      const { reason, trigger } = classifyReloadTrigger(changedPath);
      reloadEvents.record(workspaceId, reason, trigger);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        try {
          input.config.absorbWorkspaceConfig(workspaceId);
        } catch {
          // ignore best-effort watcher repair failures
        }
      }, 200);
    };

    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      try {
        const watcher = fs.watch(root, { persistent: false }, (_eventType, filename) => {
          schedule(filename ? path.join(root, filename.toString()) : root);
        });
        watchers.push(watcher);
      } catch {
        // ignore unsupported watcher roots
      }
    }

    const close = () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
    };
    watcherClosers.set(workspaceId, close);
  }

  function startWatchers() {
    for (const close of watcherClosers.values()) {
      close();
    }
    watcherClosers.clear();
    const workspaces = input.repositories.workspaces.list({ includeHidden: true }).filter((workspace) => workspace.kind !== "remote");
    for (const workspace of workspaces) {
      startWorkspaceWatchers(workspace.id);
    }
    updateRuntimeHealth({
      watchedWorkspaceIds: workspaces.map((workspace) => workspace.id),
      watchersStartedAt: nowMs(),
    });
  }

  function reconcileAll() {
    const result = input.config.reconcileAllWorkspaces();
    updateRuntimeHealth({
      lastReconciledAt: result.reconciledAt,
      reconciledWorkspaceIds: result.workspaceIds,
    });
    return result;
  }

  reconcileAll();
  startWatchers();
  const periodicRepair = setInterval(() => {
    reconcileAll();
  }, 30_000);
  (periodicRepair as any).unref?.();

  function buildActorKey(actorKey: string | undefined, kind: "client" | "host") {
    return `${kind}:${actorKey?.trim() || kind}`;
  }

  function resolveFileSession(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host") {
    const session = fileSessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new HTTPException(404, { message: "File session not found." });
    }
    if (session.actorTokenHash !== buildActorKey(actorKey, actorKind)) {
      throw new HTTPException(403, { message: "File session does not belong to this actor." });
    }
    const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
    return { session, workspace, workspaceRoot: resolveWorkspaceRoot(workspace) };
  }

  async function listArtifacts(rootDir: string) {
    if (!fs.existsSync(rootDir)) {
      return [] as Array<{ id: string; path: string; size: number; updatedAt: number }>;
    }
    const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const relativePath = normalizeWorkspaceRelativePath(path.relative(rootDir, absolute), { allowSubdirs: true });
        const info = fs.statSync(absolute);
        items.push({
          id: encodeArtifactId(relativePath),
          path: relativePath,
          size: info.size,
          updatedAt: info.mtimeMs,
        });
      }
    };
    walk(rootDir);
    items.sort((left, right) => right.updatedAt - left.updatedAt);
    return items;
  }

  function listWorkspaceCatalogEntries(workspaceRoot: string) {
    const items: FileCatalogEntry[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(directory, entry.name);
        const relativePath = normalizeWorkspaceRelativePath(path.relative(workspaceRoot, absolute), { allowSubdirs: true });
        const info = fs.statSync(absolute);
        if (entry.isDirectory()) {
          items.push({ kind: "dir", mtimeMs: info.mtimeMs, path: relativePath, revision: fileRevision({ mtimeMs: info.mtimeMs, size: 0 }), size: 0 });
          visit(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        items.push({ kind: "file", mtimeMs: info.mtimeMs, path: relativePath, revision: fileRevision(info), size: info.size });
      }
    };
    if (fs.existsSync(workspaceRoot)) {
      visit(workspaceRoot);
    }
    items.sort((left, right) => left.path.localeCompare(right.path));
    return items;
  }

  async function audit(workspace: WorkspaceRecord, action: string, target: string, summary: string) {
    recordAuditEntry(workspace.id, resolveWorkspaceRoot(workspace), action, target, summary);
  }

  return {
    activateWorkspace(workspaceId: string) {
      const workspace = input.repositories.workspaces.getById(workspaceId);
      if (!workspace) {
        throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
      }
      updateRuntimeHealth({ activeWorkspaceId: workspaceId, activeWorkspaceUpdatedAt: nowIso() });
      return workspaceId;
    },

    deleteWorkspace(workspaceId: string) {
      const workspace = input.repositories.workspaces.getById(workspaceId);
      if (!workspace) {
        throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
      }
      const deleted = input.repositories.workspaces.deleteById(workspaceId);
      updateRuntimeHealth({ activeWorkspaceId: null, activeWorkspaceUpdatedAt: nowIso() });
      startWatchers();
      return { deleted, workspaceId };
    },

    async disposeWorkspaceInstance(workspaceId: string) {
      const workspace = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspace.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspace, "/engine/reload");
        await requestRemoteOpenwork<{ reloadedAt: number }>({
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 20_000,
        });
        return { disposed: true, workspaceId };
      }

      await input.runtime.dispose();
      await input.runtime.bootstrap();
      updateRuntimeHealth({ activeWorkspaceId: null, activeWorkspaceUpdatedAt: nowIso() });
      reloadEvents.record(workspace.id, "config", { action: "updated", name: "engine", type: "config" }, 0);
      await audit(workspace, "engine.dispose", workspace.dataDir ?? workspace.id, "Disposed workspace runtime instance through Server V2.");
      return { disposed: true, workspaceId };
    },

    async createLocalWorkspace(inputValue: { folderPath: string; name: string; preset: string }) {
      const folderPath = inputValue.folderPath.trim();
      if (!folderPath) {
        throw new RouteError(400, "invalid_request", "folderPath is required.");
      }
      const workspaceRoot = path.resolve(folderPath);
      fs.mkdirSync(workspaceRoot, { recursive: true });
      initializeWorkspaceFiles(workspaceRoot);
      const record = input.registry.importLocalWorkspace({
        dataDir: workspaceRoot,
        displayName: inputValue.name.trim() || path.basename(workspaceRoot),
        status: "ready",
      });
      input.repositories.workspaces.upsert({
        ...record,
        displayName: inputValue.name.trim() || record.displayName,
        status: "ready",
      });
      input.config.absorbWorkspaceConfig(record.id);
      startWatchers();
      updateRuntimeHealth({ activeWorkspaceId: record.id, activeWorkspaceUpdatedAt: nowIso() });
      return resolveWorkspaceOrThrow(input.repositories, record.id);
    },

    createWorkspaceFileSession(workspaceId: string, inputValue: { actorKey?: string; actorKind: "client" | "host"; ttlSeconds?: number; write?: boolean }) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, "/file-sessions");
        return requestRemoteOpenwork<{
          canWrite: boolean;
          createdAt: number;
          expiresAt: number;
          id: string;
          ttlMs: number;
          workspaceId: string;
        }>({
          body: { ttlSeconds: inputValue.ttlSeconds, write: inputValue.write },
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 15_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const workspaceRoot = resolveWorkspaceRoot(workspace);
      const requestWrite = inputValue.write !== false;
      const canWrite = requestWrite && (inputValue.actorKind === "host" || inputValue.actorKind === "client");
      const session = fileSessions.create({
        actorTokenHash: buildActorKey(inputValue.actorKey, inputValue.actorKind),
        canWrite,
        ttlMs: parseFileSessionTtlMs(inputValue.ttlSeconds),
        workspaceId,
        workspaceRoot,
      });
      return {
        canWrite: session.canWrite,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        id: session.id,
        ttlMs: Math.max(0, session.expiresAt - nowMs()),
        workspaceId,
      };
    },

    async dispose() {
      clearInterval(periodicRepair);
      for (const close of watcherClosers.values()) {
        close();
      }
      watcherClosers.clear();
    },

    emitReloadEvent(workspaceId: string, reason: ReloadReason, trigger?: ReloadTrigger) {
      const workspace = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspace.kind === "remote") {
        return null;
      }
      return reloadEvents.record(workspaceId, reason, trigger, 0);
    },

    async downloadArtifact(workspaceId: string, artifactId: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/artifacts/${encodeURIComponent(artifactId)}`);
        const response = await requestRemoteOpenworkRaw({
          path: remote.path,
          server: remote.server,
          timeoutMs: 30_000,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          buffer,
          filename: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? artifactId,
          size: buffer.byteLength,
        };
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const rootDir = resolveOutboxDir(resolveWorkspaceRoot(workspace));
      const relativePath = decodeArtifactId(artifactId);
      const absolutePath = resolveSafeChildPath(rootDir, relativePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new HTTPException(404, { message: "Artifact not found." });
      }
      return { absolutePath, filename: path.basename(relativePath), size: fs.statSync(absolutePath).size };
    },

    async downloadInboxItem(workspaceId: string, inboxId: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/inbox/${encodeURIComponent(inboxId)}`);
        const response = await requestRemoteOpenworkRaw({
          path: remote.path,
          server: remote.server,
          timeoutMs: 30_000,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          buffer,
          filename: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? inboxId,
          size: buffer.byteLength,
        };
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const rootDir = resolveInboxDir(resolveWorkspaceRoot(workspace));
      const relativePath = decodeArtifactId(inboxId);
      const absolutePath = resolveSafeChildPath(rootDir, relativePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new HTTPException(404, { message: "Inbox item not found." });
      }
      return { absolutePath, filename: path.basename(relativePath), size: fs.statSync(absolutePath).size };
    },

    getReloadEvents(workspaceId: string, since?: number) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/reload-events${typeof since === "number" ? `?since=${since}` : ""}`);
        return requestRemoteOpenwork<{ cursor: number; items: ReloadEvent[] }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 10_000,
        });
      }
      resolveWorkspaceOrThrow(input.repositories, workspaceId);
      return reloadEvents.list(workspaceId, since ?? 0);
    },

    async recordWorkspaceAudit(workspaceId: string, action: string, target: string, summary: string) {
      const workspace = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspace.kind === "remote") {
        return null;
      }
      await audit(workspace, action, target, summary);
    },

    async listArtifacts(workspaceId: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, "/artifacts");
        return requestRemoteOpenwork<{ items: Array<Record<string, unknown>> }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 15_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      return { items: await listArtifacts(resolveOutboxDir(resolveWorkspaceRoot(workspace))) };
    },

    async listFileSessionCatalogSnapshot(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", inputValue: { after?: string | null; includeDirs?: boolean; limit?: string | null; prefix?: string | null }) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const query = new URLSearchParams();
        if (inputValue.after) query.set("after", inputValue.after);
        if (inputValue.includeDirs === false) query.set("includeDirs", "false");
        if (inputValue.limit) query.set("limit", inputValue.limit);
        if (inputValue.prefix) query.set("prefix", inputValue.prefix);
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query.size ? `?${query.toString()}` : ""}`);
        return requestRemoteOpenwork<{
          cursor: number;
          generatedAt: number;
          items: FileCatalogEntry[];
          nextAfter?: string;
          sessionId: string;
          total: number;
          truncated: boolean;
          workspaceId: string;
        }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 20_000,
        });
      }
      const { workspaceRoot } = resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      const prefix = parsePathFilter(inputValue.prefix ?? null);
      const after = parsePathFilter(inputValue.after ?? null);
      const includeDirs = inputValue.includeDirs !== false;
      const limit = parseCatalogLimit(inputValue.limit ?? null);
      const entries = listWorkspaceCatalogEntries(workspaceRoot).filter((entry) => {
        if (!includeDirs && entry.kind === "dir") return false;
        if (!matchesCatalogFilter(entry.path, prefix)) return false;
        if (after && entry.path <= after) return false;
        return true;
      });
      const items = entries.slice(0, limit);
      const cursor = fileSessions.listWorkspaceEvents(workspaceId, Number.MAX_SAFE_INTEGER).cursor;
      return {
        cursor,
        generatedAt: nowMs(),
        items,
        nextAfter: entries.length > items.length ? items[items.length - 1]?.path : undefined,
        sessionId,
        total: entries.length,
        truncated: entries.length > items.length,
        workspaceId,
      };
    },

    listFileSessionEvents(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", since?: string | null) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/catalog/events${since?.trim() ? `?since=${encodeURIComponent(since.trim())}` : ""}`);
        return requestRemoteOpenwork<{ cursor: number; items: FileSessionEvent[] }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 10_000,
        });
      }
      resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      return fileSessions.listWorkspaceEvents(workspaceId, parseCursor(since ?? null));
    },

    async listInbox(workspaceId: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, "/inbox");
        return requestRemoteOpenwork<{ items: Array<Record<string, unknown>> }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 15_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const items = await listArtifacts(resolveInboxDir(resolveWorkspaceRoot(workspace)));
      return {
        items: items.map((item) => ({ ...item, id: encodeArtifactId(item.path), name: path.basename(item.path) })),
      };
    },

    async readSimpleContent(workspaceId: string, relativePathInput: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/files/content?path=${encodeURIComponent(relativePathInput)}`);
        return requestRemoteOpenwork<{ bytes: number; content: string; path: string; updatedAt: number; revision?: string }>({
          path: remote.path,
          server: remote.server,
          timeoutMs: 15_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const relativePath = normalizeWorkspaceRelativePath(relativePathInput, { allowSubdirs: true });
      if (!/\.(md|mdx|markdown)$/i.test(relativePath)) {
        throw new RouteError(400, "invalid_request", "Only markdown files are supported by the simple content routes.");
      }
      const absolutePath = resolveSafeChildPath(resolveWorkspaceRoot(workspace), relativePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new HTTPException(404, { message: "File not found." });
      }
      const info = fs.statSync(absolutePath);
      if (info.size > FILE_SESSION_MAX_FILE_BYTES) {
        throw new RouteError(413, "invalid_request", "File exceeds the maximum supported size.");
      }
      return {
        bytes: info.size,
        content: fs.readFileSync(absolutePath, "utf8"),
        path: relativePath,
        updatedAt: info.mtimeMs,
      };
    },

    async readWorkspaceFiles(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", paths: unknown) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/read-batch`);
        return requestRemoteOpenwork<{ items: Array<Record<string, unknown>> }>({
          body: { paths },
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 20_000,
        });
      }
      const { workspaceRoot } = resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      const items = parseBatchPathList(paths).map((relativePath) => {
        try {
          const absolutePath = resolveSafeChildPath(workspaceRoot, relativePath);
          if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
            return { code: "file_not_found", message: "File not found", ok: false, path: relativePath };
          }
          const info = fs.statSync(absolutePath);
          if (info.size > FILE_SESSION_MAX_FILE_BYTES) {
            return { code: "file_too_large", maxBytes: FILE_SESSION_MAX_FILE_BYTES, message: "File exceeds size limit", ok: false, path: relativePath, size: info.size };
          }
          return {
            bytes: info.size,
            contentBase64: fs.readFileSync(absolutePath).toString("base64"),
            kind: "file",
            ok: true,
            path: relativePath,
            revision: fileRevision(info),
            updatedAt: info.mtimeMs,
          };
        } catch (error) {
          return { code: "read_failed", message: error instanceof Error ? error.message : "Unable to read file", ok: false, path: relativePath };
        }
      });
      return { items };
    },

    async reloadWorkspaceEngine(workspaceId: string) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, "/engine/reload");
        return requestRemoteOpenwork<{ reloadedAt: number }>({
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 20_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      await input.runtime.dispose();
      await input.runtime.bootstrap();
      reloadEvents.record(workspace.id, "config", { action: "updated", name: "engine", type: "config" }, 0);
      await audit(workspace, "engine.reload", workspace.dataDir ?? workspace.id, "Reloaded workspace engine through Server V2.");
      return { reloadedAt: nowMs() };
    },

    reconcileAll,

    updateWorkspaceDisplayName(workspaceId: string, displayName: string | null) {
      const workspace = input.repositories.workspaces.getById(workspaceId);
      if (!workspace) {
        throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
      }
      return input.repositories.workspaces.upsert({
        ...workspace,
        displayName: displayName?.trim() || workspace.displayName,
      });
    },

    renewWorkspaceFileSession(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", ttlSeconds?: number) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/renew`);
        return requestRemoteOpenwork<{
          canWrite: boolean;
          createdAt: number;
          expiresAt: number;
          id: string;
          ttlMs: number;
          workspaceId: string;
        }>({
          body: ttlSeconds === undefined ? {} : { ttlSeconds },
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 10_000,
        });
      }
      resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      const renewed = fileSessions.renew(sessionId, parseFileSessionTtlMs(ttlSeconds));
      if (!renewed) {
        throw new HTTPException(404, { message: "File session not found." });
      }
      return {
        canWrite: renewed.canWrite,
        createdAt: renewed.createdAt,
        expiresAt: renewed.expiresAt,
        id: renewed.id,
        ttlMs: Math.max(0, renewed.expiresAt - nowMs()),
        workspaceId,
      };
    },

    closeWorkspaceFileSession(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host") {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}`);
        return requestRemoteOpenwork<{ closed?: boolean }>({
          method: "DELETE",
          path: remote.path,
          server: remote.server,
          timeoutMs: 10_000,
        });
      }
      resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      fileSessions.close(sessionId);
      return { closed: true };
    },

    async uploadInboxItem(workspaceId: string, requestedPath: string, file: File) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const form = new FormData();
        form.append("file", file);
        if (requestedPath.trim()) {
          form.append("path", requestedPath.trim());
        }
        const remote = getRemoteWorkspacePath(workspaceRecord, "/inbox");
        const response = await requestRemoteOpenworkRaw({
          body: form,
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 30_000,
        });
        const text = await response.text();
        return text.trim() ? JSON.parse(text) as { bytes: number; path: string } : { bytes: file.size, path: requestedPath || file.name };
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const rootDir = resolveInboxDir(resolveWorkspaceRoot(workspace));
      const relativePath = normalizeWorkspaceRelativePath(requestedPath || file.name, { allowSubdirs: true });
      if (file.size > FILE_SESSION_MAX_FILE_BYTES) {
        throw new RouteError(413, "invalid_request", "File exceeds the maximum supported size.");
      }
      const absolutePath = resolveSafeChildPath(rootDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, Buffer.from(await file.arrayBuffer()));
      await audit(workspace, "workspace.inbox.upload", absolutePath, `Uploaded ${relativePath} to the workspace inbox.`);
      return { bytes: file.size, path: relativePath };
    },

    async writeSimpleContent(workspaceId: string, inputValue: { baseUpdatedAt?: number | null; content: string; force?: boolean; path: string }) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, "/files/content");
        return requestRemoteOpenwork<{ bytes: number; path: string; revision?: string; updatedAt: number }>({
          body: inputValue,
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 20_000,
        });
      }
      const workspace = resolveWorkspaceOrThrow(input.repositories, workspaceId);
      const relativePath = normalizeWorkspaceRelativePath(inputValue.path, { allowSubdirs: true });
      if (!/\.(md|mdx|markdown)$/i.test(relativePath)) {
        throw new RouteError(400, "invalid_request", "Only markdown files are supported by the simple content routes.");
      }
      const absolutePath = resolveSafeChildPath(resolveWorkspaceRoot(workspace), relativePath);
      const before = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
      if (before && !before.isFile()) {
        throw new RouteError(400, "invalid_request", "Path must point to a file.");
      }
      if (!inputValue.force && before && inputValue.baseUpdatedAt !== undefined && inputValue.baseUpdatedAt !== null && before.mtimeMs !== inputValue.baseUpdatedAt) {
        throw new RouteError(409, "conflict", "File changed since it was loaded.");
      }
      if (Buffer.byteLength(inputValue.content, "utf8") > FILE_SESSION_MAX_FILE_BYTES) {
        throw new RouteError(413, "invalid_request", "File exceeds the maximum supported size.");
      }
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, inputValue.content, "utf8");
      const after = fs.statSync(absolutePath);
      fileSessions.recordWorkspaceEvent({ path: relativePath, revision: fileRevision(after), type: "write", workspaceId });
      reloadEvents.record(workspaceId, "config", { action: "updated", name: path.basename(relativePath), path: absolutePath, type: "config" });
      await audit(workspace, "workspace.file.write", absolutePath, `Wrote ${relativePath} through the simple content route.`);
      return { bytes: Buffer.byteLength(inputValue.content, "utf8"), path: relativePath, revision: fileRevision(after), updatedAt: after.mtimeMs };
    },

    async writeWorkspaceFiles(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", writes: unknown) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/write-batch`);
        return requestRemoteOpenwork<{ cursor: number; items: Array<Record<string, unknown>> }>({
          body: { writes },
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 30_000,
        });
      }
      const { session, workspace, workspaceRoot } = resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      if (!session.canWrite) {
        throw new HTTPException(403, { message: "File session is read-only." });
      }
      const items: Array<Record<string, unknown>> = [];
      for (const write of parseBatchWriteList(writes)) {
        try {
          const absolutePath = resolveSafeChildPath(workspaceRoot, write.path);
          const bytes = Buffer.from(write.contentBase64, "base64");
          if (bytes.byteLength > FILE_SESSION_MAX_FILE_BYTES) {
            items.push({ code: "file_too_large", maxBytes: FILE_SESSION_MAX_FILE_BYTES, message: "File exceeds size limit", ok: false, path: write.path, size: bytes.byteLength });
            continue;
          }
          const before = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
          const currentRevision = before ? fileRevision(before) : null;
          if (!write.force && write.ifMatchRevision && currentRevision !== write.ifMatchRevision) {
            items.push({ code: "conflict", currentRevision, expectedRevision: write.ifMatchRevision, message: "File changed since it was loaded", ok: false, path: write.path });
            continue;
          }
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, bytes);
          const after = fs.statSync(absolutePath);
          const revision = fileRevision(after);
          fileSessions.recordWorkspaceEvent({ path: write.path, revision, type: "write", workspaceId });
          reloadEvents.record(workspaceId, "config", { action: "updated", name: path.basename(write.path), path: absolutePath, type: "config" });
          await audit(workspace, "workspace.files.session.write", absolutePath, `Wrote ${write.path} through a file session.`);
          items.push({ bytes: bytes.byteLength, ok: true, path: write.path, previousRevision: currentRevision, revision, updatedAt: after.mtimeMs });
        } catch (error) {
          items.push({ code: "write_failed", message: error instanceof Error ? error.message : "Failed to write file", ok: false, path: write.path });
        }
      }
      return { cursor: fileSessions.listWorkspaceEvents(workspaceId, Number.MAX_SAFE_INTEGER).cursor, items };
    },

    async workspaceFileOperations(workspaceId: string, sessionId: string, actorKey: string, actorKind: "client" | "host", operations: unknown) {
      const workspaceRecord = resolveWorkspaceRecordOrThrow(input.repositories, workspaceId);
      if (workspaceRecord.kind === "remote") {
        const remote = getRemoteWorkspacePath(workspaceRecord, `/file-sessions/${encodeURIComponent(sessionId)}/operations`);
        return requestRemoteOpenwork<{ cursor: number; items: Array<Record<string, unknown>> }>({
          body: { operations },
          method: "POST",
          path: remote.path,
          server: remote.server,
          timeoutMs: 30_000,
        });
      }
      const { session, workspace, workspaceRoot } = resolveFileSession(workspaceId, sessionId, actorKey, actorKind);
      if (!session.canWrite) {
        throw new HTTPException(403, { message: "File session is read-only." });
      }
      const items: Array<Record<string, unknown>> = [];
      for (const operation of parseOperations(operations)) {
        const type = String(operation.type ?? "").trim();
        try {
          if (type === "mkdir") {
            const relativePath = normalizeWorkspaceRelativePath(String(operation.path ?? ""), { allowSubdirs: true });
            const absolutePath = resolveSafeChildPath(workspaceRoot, relativePath);
            fs.mkdirSync(absolutePath, { recursive: true });
            fileSessions.recordWorkspaceEvent({ path: relativePath, type: "mkdir", workspaceId });
            reloadEvents.record(workspaceId, "config", { action: "updated", name: path.basename(relativePath), path: absolutePath, type: "config" });
            items.push({ ok: true, path: relativePath, type });
            continue;
          }
          if (type === "delete") {
            const relativePath = normalizeWorkspaceRelativePath(String(operation.path ?? ""), { allowSubdirs: true });
            const absolutePath = resolveSafeChildPath(workspaceRoot, relativePath);
            if (!fs.existsSync(absolutePath)) {
              items.push({ code: "file_not_found", message: "Path not found", ok: false, path: relativePath, type });
              continue;
            }
            fs.rmSync(absolutePath, { force: false, recursive: operation.recursive === true });
            fileSessions.recordWorkspaceEvent({ path: relativePath, type: "delete", workspaceId });
            reloadEvents.record(workspaceId, "config", { action: "removed", name: path.basename(relativePath), path: absolutePath, type: "config" });
            await audit(workspace, "workspace.files.session.delete", absolutePath, `Deleted ${relativePath} through a file session.`);
            items.push({ ok: true, path: relativePath, type });
            continue;
          }
          if (type === "rename") {
            const from = normalizeWorkspaceRelativePath(String(operation.from ?? ""), { allowSubdirs: true });
            const to = normalizeWorkspaceRelativePath(String(operation.to ?? ""), { allowSubdirs: true });
            const fromAbsolute = resolveSafeChildPath(workspaceRoot, from);
            const toAbsolute = resolveSafeChildPath(workspaceRoot, to);
            if (!fs.existsSync(fromAbsolute)) {
              items.push({ code: "file_not_found", from, message: "Source path not found", ok: false, to, type });
              continue;
            }
            fs.mkdirSync(path.dirname(toAbsolute), { recursive: true });
            fs.renameSync(fromAbsolute, toAbsolute);
            fileSessions.recordWorkspaceEvent({ path: from, toPath: to, type: "rename", workspaceId });
            reloadEvents.record(workspaceId, "config", { action: "updated", name: path.basename(to), path: toAbsolute, type: "config" });
            await audit(workspace, "workspace.files.session.rename", `${fromAbsolute} -> ${toAbsolute}`, `Renamed ${from} to ${to} through a file session.`);
            items.push({ from, ok: true, to, type });
            continue;
          }
          items.push({ code: "invalid_operation", message: `Unsupported operation type: ${type}`, ok: false, type });
        } catch (error) {
          items.push({ code: "operation_failed", message: error instanceof Error ? error.message : "Operation failed", ok: false, type });
        }
      }
      return { cursor: fileSessions.listWorkspaceEvents(workspaceId, Number.MAX_SAFE_INTEGER).cursor, items };
    },
  };
}
