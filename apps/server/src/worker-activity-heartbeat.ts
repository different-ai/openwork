import { externalFetch } from "./server-fetch.js";
import { createWorkspaceOpencodeClient } from "./server.js";
import type { ServerConfig } from "./types.js";

const DEFAULT_ACTIVITY_WINDOW_MS = 5 * 60_000;
const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export type WorkerActivityHeartbeatConfig = {
  enabled: boolean;
  workerId: string;
  url: string;
  token: string;
  intervalMs: number;
  activeWindowMs: number;
};

export type WorkerActivityHeartbeatHandle = {
  stop: () => void;
};

export type WorkerActivityHeartbeatLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

export type WorkerActivityHeartbeatPayload = {
  sentAt: string;
  isActiveRecently: boolean;
  lastActivityAt: string | null;
  openSessionCount: number;
};

type HeartbeatEnv = Record<string, string | undefined>;
type HeartbeatFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function parsePositiveNumberEnv(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseSessionActivityAt(session: unknown): number | null {
  if (!isRecord(session) || !isRecord(session.time)) return null;
  const updated = session.time.updated;
  if (typeof updated === "number" && Number.isFinite(updated) && updated > 0) return updated;
  const created = session.time.created;
  if (typeof created === "number" && Number.isFinite(created) && created > 0) return created;
  return null;
}

export function resolveWorkerActivityHeartbeatConfig(env: HeartbeatEnv = process.env): WorkerActivityHeartbeatConfig {
  const enabled = (env.DEN_ACTIVITY_HEARTBEAT_ENABLED ?? "").trim().toLowerCase();
  const provider = (env.DEN_RUNTIME_PROVIDER ?? "").trim().toLowerCase();
  const workerId = (env.DEN_WORKER_ID ?? "").trim();
  const url = (env.DEN_ACTIVITY_HEARTBEAT_URL ?? "").trim();
  const token = (env.DEN_ACTIVITY_HEARTBEAT_TOKEN ?? "").trim();
  const featureEnabled = enabled === "1" || enabled === "true" || enabled === "yes";

  if (!featureEnabled || provider !== "daytona" || !workerId || !url || !token) {
    return {
      enabled: false,
      workerId: "",
      url: "",
      token: "",
      intervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
      activeWindowMs: DEFAULT_ACTIVITY_WINDOW_MS,
    };
  }

  const intervalSeconds = parsePositiveNumberEnv(
    env.DEN_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS / 1000,
  );
  const activeWindowSeconds = parsePositiveNumberEnv(
    env.DEN_ACTIVITY_WINDOW_SECONDS,
    DEFAULT_ACTIVITY_WINDOW_MS / 1000,
  );

  return {
    enabled: true,
    workerId,
    url,
    token,
    intervalMs: Math.round(intervalSeconds * 1000),
    activeWindowMs: Math.round(activeWindowSeconds * 1000),
  };
}

export function buildWorkerActivityHeartbeatPayload(
  sessions: readonly unknown[],
  now: number,
  activeWindowMs: number,
): WorkerActivityHeartbeatPayload {
  let latestActivityAt = 0;
  for (const session of sessions) {
    const activityAt = parseSessionActivityAt(session);
    if (activityAt && activityAt > latestActivityAt) latestActivityAt = activityAt;
  }

  return {
    sentAt: new Date(now).toISOString(),
    isActiveRecently: latestActivityAt > 0 && now - latestActivityAt <= activeWindowMs,
    lastActivityAt: latestActivityAt > 0 ? new Date(latestActivityAt).toISOString() : null,
    openSessionCount: sessions.length,
  };
}

export async function postWorkerActivityHeartbeat(input: {
  config: WorkerActivityHeartbeatConfig;
  sessions: readonly unknown[];
  fetchImpl?: HeartbeatFetch;
  now?: () => number;
}): Promise<WorkerActivityHeartbeatPayload | null> {
  if (!input.config.enabled) return null;

  const payload = buildWorkerActivityHeartbeatPayload(
    input.sessions,
    input.now ? input.now() : Date.now(),
    input.config.activeWindowMs,
  );
  const response = await (input.fetchImpl ?? externalFetch)(input.config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`heartbeat_failed:${response.status}`);
  return payload;
}

async function listOpenSessions(config: ServerConfig): Promise<readonly unknown[]> {
  const workspace = config.workspaces[0];
  if (!workspace) return [];
  const opencode = createWorkspaceOpencodeClient(config, workspace);
  const result = await opencode.session.list({ limit: 200 });
  if (result.data != null) return result.data;
  if (result.error === undefined) throw new Error("opencode_empty_response");
  throw new Error(`opencode_request_failed:${result.response.status}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startWorkerActivityHeartbeat(
  config: ServerConfig,
  logger: WorkerActivityHeartbeatLogger,
  options?: {
    env?: HeartbeatEnv;
    fetchImpl?: HeartbeatFetch;
    listSessions?: () => Promise<readonly unknown[]>;
    now?: () => number;
  },
): WorkerActivityHeartbeatHandle | null {
  const heartbeatConfig = resolveWorkerActivityHeartbeatConfig(options?.env);
  if (!heartbeatConfig.enabled) return null;

  logger.log("info", "Worker activity heartbeat enabled", {
    workerId: heartbeatConfig.workerId,
    intervalMs: heartbeatConfig.intervalMs,
    activeWindowMs: heartbeatConfig.activeWindowMs,
  });

  const listSessions = options?.listSessions ?? (() => listOpenSessions(config));
  const runHeartbeat = () => {
    void listSessions()
      .then((sessions) => postWorkerActivityHeartbeat({
        config: heartbeatConfig,
        sessions,
        fetchImpl: options?.fetchImpl,
        now: options?.now,
      }))
      .catch((error) => {
        logger.log("warn", "Worker activity heartbeat failed", { error: errorMessage(error) });
      });
  };

  runHeartbeat();
  const interval = setInterval(runHeartbeat, heartbeatConfig.intervalMs);
  return { stop: () => clearInterval(interval) };
}
