/**
 * Thread approvals: OpenWork's own memory of what a user approved on a thread.
 *
 * The engine keeps an "always" reply in the memory of the per-directory
 * instance that received it — not on the session and not on disk. OpenWork
 * rebuilds those instances routinely (config, skill, and MCP reload events,
 * idle eviction, engine rollover), so a grant made mid-thread is forgotten
 * while the thread itself lives on, and the same command asks again.
 *
 * This module records every "always" reply against its thread and, when the
 * engine asks the same thread for something that grant already covers,
 * answers on the user's behalf — with "always" again so the fresh instance
 * remembers too. The engine stays the only adjudicator: OpenWork never
 * approves anything the user did not approve on that very thread, and a
 * `deny` rule never reaches the ask stage in the first place.
 */
import type { EnginePoolConnection, EnginePoolLogger } from "./engine-pool.js";
import { BoundedSseFrameBuffer } from "./engine-pool.js";
import { buildEngineAuthProbeHeader } from "./engine-registry.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export interface ThreadApprovalGrant {
  permission: string;
  patterns: string[];
}

interface WorkspaceThreadApprovals {
  sessions: Record<string, ThreadApprovalGrant[]>;
}

function parseGrants(value: unknown): ThreadApprovalGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.permission !== "string" || !Array.isArray(entry.patterns)) return [];
    const patterns = entry.patterns.filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0);
    return patterns.length ? [{ permission: entry.permission, patterns }] : [];
  });
}

function parseWorkspaceThreadApprovals(json: string): WorkspaceThreadApprovals {
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !isRecord(value.sessions)) return { sessions: {} };
    return {
      sessions: Object.fromEntries(
        Object.entries(value.sessions).map(([sessionId, grants]) => [sessionId, parseGrants(grants)]),
      ),
    };
  } catch {
    return { sessions: {} };
  }
}

const threadApprovalStore = createWorkspaceKvStore<WorkspaceThreadApprovals>({
  tableName: "thread_approvals",
  valueColumn: "approvals_json",
  parse: parseWorkspaceThreadApprovals,
  serialize: (value) => JSON.stringify(value),
});

/** Mirror of the engine's wildcard matcher (`*` any run, `?` one char, trailing ` *` optional). */
export function matchesPermissionPattern(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

/** A grant covers a request when every requested pattern is matched by one of the granted patterns. */
export function grantCovers(grant: ThreadApprovalGrant, permission: string, patterns: string[]): boolean {
  if (!matchesPermissionPattern(permission, grant.permission)) return false;
  return patterns.length > 0
    && patterns.every((pattern) => grant.patterns.some((granted) => matchesPermissionPattern(pattern, granted)));
}

export async function listThreadApprovals(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
): Promise<ThreadApprovalGrant[]> {
  const stored = await threadApprovalStore.get(config, workspaceId);
  return stored?.sessions[sessionId] ?? [];
}

export async function rememberThreadApproval(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  grant: ThreadApprovalGrant,
): Promise<void> {
  if (grant.patterns.length === 0) return;
  const stored = (await threadApprovalStore.get(config, workspaceId)) ?? { sessions: {} };
  const current = stored.sessions[sessionId] ?? [];
  const duplicate = current.some((entry) =>
    entry.permission === grant.permission
    && entry.patterns.length === grant.patterns.length
    && entry.patterns.every((pattern, index) => pattern === grant.patterns[index]));
  if (duplicate) return;
  await threadApprovalStore.set(config, workspaceId, {
    sessions: { ...stored.sessions, [sessionId]: [...current, grant] },
  });
}

export async function forgetThreadApprovals(config: ServerConfig, workspaceId: string, sessionId: string): Promise<void> {
  const stored = await threadApprovalStore.get(config, workspaceId);
  if (!stored?.sessions[sessionId]) return;
  const { [sessionId]: _removed, ...sessions } = stored.sessions;
  await threadApprovalStore.set(config, workspaceId, { sessions });
}

interface PendingAsk {
  directory: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  always: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function sseFramePayload(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export interface ThreadApprovalReplayerOptions {
  config: ServerConfig;
  /** The engine to observe; null while no primary is serving. */
  primary: () => EnginePoolConnection | null;
  /** Map an engine instance directory to the OpenWork workspace it serves; null for directories OpenWork does not own. */
  workspaceIdForDirectory: (directory: string) => Promise<string | null>;
  logger?: EnginePoolLogger;
  reconnectMs?: number;
  fetchImpl?: typeof loopbackFetch;
}

export interface ThreadApprovalReplayer {
  stop: () => void;
}

/**
 * Follow the engine's global event stream, remember "always" replies per
 * thread, and answer repeat asks on the same thread that a remembered grant
 * already covers. Reconnects when the stream drops or the primary engine
 * changes; a lost connection only pauses replay, never approves anything.
 */
export function startThreadApprovalReplayer(options: ThreadApprovalReplayerOptions): ThreadApprovalReplayer {
  const fetchImpl = options.fetchImpl ?? loopbackFetch;
  const reconnectMs = options.reconnectMs ?? 1_000;
  const pending = new Map<string, PendingAsk>();
  let stopped = false;
  let active: AbortController | null = null;

  const log = (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) =>
    options.logger?.log(level, message, attributes);

  const reply = async (connection: EnginePoolConnection, ask: PendingAsk, requestId: string): Promise<boolean> => {
    const url = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, connection.baseUrl);
    url.searchParams.set("directory", ask.directory);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          Authorization: buildEngineAuthProbeHeader(connection.username, connection.password),
          "content-type": "application/json",
        },
        body: JSON.stringify({ reply: "always" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        log("warn", "Thread approval replay was not accepted by the engine.", {
          "permission.request_id": requestId,
          "engine.status": response.status,
        });
        return false;
      }
      return true;
    } catch (error) {
      log("warn", "Thread approval replay failed.", {
        "permission.request_id": requestId,
        "engine.failure": error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const onAsked = async (connection: EnginePoolConnection, directory: string, properties: Record<string, unknown>) => {
    const requestId = typeof properties.id === "string" ? properties.id : "";
    const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : "";
    const permission = typeof properties.permission === "string" ? properties.permission : "";
    if (!requestId || !sessionId || !permission) return;
    const ask: PendingAsk = {
      directory,
      sessionId,
      permission,
      patterns: stringList(properties.patterns),
      always: stringList(properties.always),
    };
    pending.set(requestId, ask);
    const workspaceId = await options.workspaceIdForDirectory(directory);
    if (!workspaceId) return;
    const grants = await listThreadApprovals(options.config, workspaceId, sessionId);
    const covering = grants.find((grant) => grantCovers(grant, permission, ask.patterns));
    if (!covering) return;
    const replied = await reply(connection, ask, requestId);
    if (replied) {
      log("info", "Replayed a thread approval the user already gave.", {
        "workspace.id": workspaceId,
        "session.id": sessionId,
        "permission.name": permission,
      });
    }
  };

  const onReplied = async (properties: Record<string, unknown>) => {
    const requestId = typeof properties.requestID === "string" ? properties.requestID : "";
    const ask = pending.get(requestId);
    if (!ask) return;
    pending.delete(requestId);
    if (properties.reply !== "always") return;
    const workspaceId = await options.workspaceIdForDirectory(ask.directory);
    if (!workspaceId) return;
    // The engine's suggested `always` patterns are what it would remember
    // itself; fall back to the exact request when it suggests none.
    const patterns = ask.always.length ? ask.always : ask.patterns;
    await rememberThreadApproval(options.config, workspaceId, ask.sessionId, { permission: ask.permission, patterns });
  };

  const handleFrame = async (connection: EnginePoolConnection, frame: string) => {
    const payload = sseFramePayload(frame);
    if (!isRecord(payload) || typeof payload.directory !== "string" || !isRecord(payload.payload)) return;
    const event = payload.payload;
    const properties = isRecord(event.properties) ? event.properties : {};
    if (event.type === "permission.asked") await onAsked(connection, payload.directory, properties);
    else if (event.type === "permission.replied") await onReplied(properties);
  };

  const consume = async (connection: EnginePoolConnection, body: ReadableStream<Uint8Array>, signal: AbortSignal) => {
    const reader = body.getReader();
    const frames = new BoundedSseFrameBuffer();
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const parsed = frames.push(chunk.value);
        for (const frame of parsed.frames) await handleFrame(connection, frame);
        if (parsed.overflow) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

  const run = async () => {
    while (!stopped) {
      const connection = options.primary();
      if (!connection) {
        await sleep(reconnectMs);
        continue;
      }
      const controller = new AbortController();
      active = controller;
      // A rollover leaves this stream attached to the draining engine; follow
      // the primary instead of waiting for the old process to exit.
      const follow = setInterval(() => {
        if (options.primary()?.baseUrl !== connection.baseUrl) controller.abort();
      }, 500);
      follow.unref?.();
      try {
        const response = await fetchImpl(new URL("/global/event", connection.baseUrl).toString(), {
          headers: { Authorization: buildEngineAuthProbeHeader(connection.username, connection.password) },
          signal: controller.signal,
        });
        if (response.ok && response.body) await consume(connection, response.body, controller.signal);
      } catch {
        // Losing the stream only pauses replay; the loop reconnects below.
      } finally {
        clearInterval(follow);
        if (active === controller) active = null;
      }
      pending.clear();
      if (!stopped) await sleep(reconnectMs);
    }
  };

  void run();

  return {
    stop: () => {
      stopped = true;
      active?.abort();
    },
  };
}
