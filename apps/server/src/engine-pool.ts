/**
 * Blue/green rollover for the managed OpenCode engine.
 *
 * A config change the engine can only read at instance build time (provider
 * blocks, plugins, agents, permissions) normally forces a dispose, which
 * aborts every run in flight. Deferring the dispose until the engine idles
 * avoids the abort but leaves config hostage to long sessions.
 *
 * This pool takes the third option when a reload lands on a busy engine:
 * spawn a standby with the new config, point every new request at it, and
 * keep the old engine alive only until its running sessions finish. Sessions
 * live in OpenCode's shared SQLite, so only the live run is process-bound.
 *
 * Steady state stays one engine. During a drain there are two, and never more
 * than two long-lived ones: a config change arriving mid-drain coalesces into
 * a single pending rollover (latest wins) instead of stacking processes.
 *
 * Always on for managed engines. Attached engines have no pool, so their
 * callers keep the defer-while-busy behavior instead.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildEngineAuthProbeHeader,
  registerEngineInstance,
  removeEngineInstance,
  updateEngineInstanceRole,
} from "./engine-registry.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type EnginePoolLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

/** Everything needed to spawn a replacement engine identical to the first one. */
export type EngineSpawnTemplate = {
  bin?: string;
  cwd: string;
  runtimeConfigPath: string;
  env: Record<string, string | undefined>;
  /** Ports a standby must avoid (the OpenWork server, and the live engine). */
  reservedPorts: () => number[];
  /** Readiness budget for a standby spawn. Defaults to the managed-engine default. */
  spawnTimeoutMs?: number;
};

export type EnginePoolHooks = {
  /** Today's in-place dispose. Used when the engine is idle. */
  reloadInPlace: (
    config: ServerConfig,
    workspace: WorkspaceInfo,
    options?: { awaitPostRefreshSync?: boolean },
  ) => Promise<void>;
  /** Whether the given engine has non-idle sessions. */
  engineBusy: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<boolean>;
  /** Re-register runtime MCPs and reconcile cloud MCP against a fresh engine. */
  postRefreshSync: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<void>;
  /** Rebuild the engine-visible runtime config file (workspace-independent). */
  writeRuntimeConfigFile: (config: ServerConfig) => Promise<{ path: string }>;
  registerTrusted: (config: ServerConfig, generation: { baseUrl: string; identity: string; isAlive: () => boolean }) => void;
  clearTrusted: (config: ServerConfig, identity: string) => void;
  spawn?: (template: EngineSpawnTemplate) => Promise<ManagedOpencodeServer>;
  now?: () => number;
  schedule?: (operation: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  waitForHealthy?: (handle: ManagedOpencodeServer) => Promise<void>;
  logger?: EnginePoolLogger;
};

export type RolloverReason = string;

export type RolloverOutcome =
  | { action: "skipped"; reason: "unchanged" }
  | { action: "reloaded_in_place" }
  | { action: "coalesced" }
  | { action: "rolled_over"; generationId: string; drainingSessions: number };

type GenerationStatus = "starting" | "primary" | "draining" | "dead";

type Generation = {
  id: string;
  handle: ManagedOpencodeServer;
  status: GenerationStatus;
  spawnedAt: number;
  fingerprint: string;
  registryId: string | null;
  trustedIdentity: string | null;
  drainTimer: ReturnType<typeof setInterval> | null;
  drainDeadline: number | null;
  drainActivityWatch: AbortController | null;
};

export type EnginePoolSnapshot = {
  generations: Array<{
    role: GenerationStatus;
    pid: number | null;
    port: number | null;
    spawnedAt: number;
    drainRemainingMs: number | null;
  }>;
};

export type EnginePoolConnection = {
  generationId: string;
  role: "primary" | "draining";
  baseUrl: string;
  username: string;
  password: string;
};

export type EnginePoolRoute = {
  target: EnginePoolConnection;
  fallback: EnginePoolConnection | null;
};

export type EngineEventProxyLease = {
  signal: AbortSignal;
  release: () => void;
};

export type EnginePoolProcess = {
  pid: number | null;
  isAlive: () => boolean;
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Same, but an explicit 0 is meaningful (it disables the throttle). */
function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * How long a draining engine may go without any owned-session activity before
 * its sessions are aborted. Activity on the engine event stream pushes the
 * deadline out, so this bounds inactivity, not total drain time.
 */
function drainTimeoutMs(): number {
  return positiveIntFromEnv("OPENWORK_ENGINE_DRAIN_TIMEOUT_MS", 15 * 60_000);
}

/** Delay before the drain activity watch reconnects to a lost engine event stream. */
function drainActivityReconnectMs(): number {
  return positiveIntFromEnv("OPENWORK_ENGINE_DRAIN_ACTIVITY_RECONNECT_MS", 1_000);
}

/** Floor between automatic spawns, so a burst of triggers cannot thrash. 0 disables it. */
function minSpawnIntervalMs(): number {
  return nonNegativeIntFromEnv("OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS", 30_000);
}

function drainPollIntervalMs(): number {
  return positiveIntFromEnv("OPENWORK_ENGINE_DRAIN_POLL_MS", 5_000);
}

/** Grace given to aborted sessions to unwind before the engine is closed. */
function abortSettleMs(): number {
  return nonNegativeIntFromEnv("OPENWORK_ENGINE_ABORT_SETTLE_MS", 5_000);
}

function portOf(url: string): number {
  try {
    return Number(new URL(url).port) || 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEngineConnectionFailure(error: unknown): boolean {
  // Node/undici occasionally drops the transport cause. This classifier is
  // only used for managed OpenCode engine traffic, never external egress.
  if (error instanceof TypeError && error.message === "fetch failed" && error.cause === undefined) return true;
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|socket hang up|Unable to connect|Headers Timeout Error/i.test(current);
    }
    if (!isRecord(current) || visited.has(current)) return false;
    visited.add(current);
    const code = current.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") return true;
    const message = current.message;
    if (typeof message === "string" && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|socket hang up|Unable to connect|Headers Timeout Error/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

export function isConnectionRefusedClassError(error: unknown): boolean {
  return isEngineConnectionFailure(error);
}

function isRoutableGeneration(
  generation: Generation,
): generation is Generation & { status: "primary" | "draining" } {
  return generation.status === "primary" || generation.status === "draining";
}

function normalizeProxyPath(proxyPath: string): string {
  const raw = proxyPath.trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function decodePathPart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sessionIdFromPath(proxyPath: string): string | null {
  const match = normalizeProxyPath(proxyPath).match(/^\/(?:api\/)?session\/([^/]+)(?:\/|$)/);
  const sessionId = decodePathPart(match?.[1]);
  return sessionId === "status" ? null : sessionId;
}

function requestIdFromPath(proxyPath: string): string | null {
  const normalized = normalizeProxyPath(proxyPath);
  const legacy = normalized.match(/^\/(?:permission|question)\/([^/]+)\/(?:reply|reject)$/);
  if (legacy) return decodePathPart(legacy[1]);
  const scoped = normalized.match(/^\/api\/session\/[^/]+\/(?:permission|question)\/([^/]+)\/(?:reply|reject)$/);
  return decodePathPart(scoped?.[1]);
}

function isLegacyPromptReply(proxyPath: string): boolean {
  return /^\/(?:permission|question)\/[^/]+\/(?:reply|reject)$/.test(normalizeProxyPath(proxyPath));
}

function isPromptishSessionRequest(method: string, proxyPath: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const normalized = normalizeProxyPath(proxyPath);
  return /^\/(?:api\/)?session\/[^/]+\/(?:message|prompt(?:_async)?|command|shell)(?:\/|$)/.test(normalized);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function requestRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of ["items", "permissions", "questions", "requests"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function eventIdentifiers(payload: unknown): { sessionIds: Set<string>; requestIds: Set<string> } {
  const sessionIds = new Set<string>();
  const requestIds = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || !isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") {
        if (["sessionID", "sessionId", "session_id"].includes(key)) sessionIds.add(item);
        if (["requestID", "requestId", "permissionID", "questionID"].includes(key)) requestIds.add(item);
        continue;
      }
      if (Array.isArray(item)) {
        for (const child of item) visit(child, depth + 1);
      } else {
        visit(item, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return { sessionIds, requestIds };
}

/**
 * Cap on the text one unterminated SSE frame may buffer before the stream is
 * treated as malformed. Sized well above any legitimate single engine event
 * (large tool outputs included) so real frames are never truncated; only a
 * stream that stops terminating frames hits it.
 */
export const ENGINE_SSE_FRAME_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Incremental SSE frame splitter shared by the client event fan-in and the
 * drain activity watch. It bounds the memory a single unterminated frame can
 * hold: completed frames are always returned, and `overflow` turns true once
 * the pending remainder exceeds the cap so the caller can drop that
 * connection instead of buffering it forever.
 */
export class BoundedSseFrameBuffer {
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(private readonly maxFrameChars = ENGINE_SSE_FRAME_MAX_CHARS) {}

  push(chunk: Uint8Array): { frames: string[]; overflow: boolean } {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    const frames: string[] = [];
    while (true) {
      const delimiter = this.buffered.match(/\r?\n\r?\n/);
      if (!delimiter || delimiter.index === undefined) break;
      frames.push(this.buffered.slice(0, delimiter.index));
      this.buffered = this.buffered.slice(delimiter.index + delimiter[0].length);
    }
    return { frames, overflow: this.buffered.length > this.maxFrameChars };
  }
}

/** Decode one SSE frame's `data:` payload; null when the frame carries none. */
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

/**
 * Everything a spawned engine reads at build time. Comparing this is what
 * lets a repeated no-op reload skip spawning a replacement.
 */
export async function computeEngineConfigFingerprint(template: EngineSpawnTemplate): Promise<string> {
  const content = await readFile(template.runtimeConfigPath, "utf8").catch(() => "");
  return createHash("sha256")
    .update(content)
    .update("\u0000")
    .update(template.bin?.trim() ?? "")
    .update("\u0000")
    .update(template.env.OPENCODE_MODELS_URL ?? "")
    .digest("hex");
}

export class EnginePool {
  private readonly config: ServerConfig;
  private readonly template: EngineSpawnTemplate;
  private readonly hooks: EnginePoolHooks;
  private generations: Generation[] = [];
  private inFlight: Promise<RolloverOutcome> | null = null;
  private pendingRollover: {
    reason: RolloverReason;
    workspace: WorkspaceInfo;
    manual: boolean;
    awaitPostRefreshSync: boolean;
    forceStandby: boolean;
  } | null = null;
  private lastSpawnAt = 0;
  private consecutiveConnectionFailures = 0;
  private lastRecoveryAt = Number.NEGATIVE_INFINITY;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryWorkspace: WorkspaceInfo | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private recoveryOrphan: ManagedOpencodeServer | null = null;
  private disposed = false;
  private readonly sessionOwnership = new Map<string, string>();
  private readonly pinnedRequests = new Map<string, string>();
  private readonly activeSessionsByGeneration = new Map<string, Set<string>>();
  private readonly eventProxyControllers = new Set<AbortController>();
  private readonly drainWaiters = new Set<() => void>();

  constructor(input: { config: ServerConfig; template: EngineSpawnTemplate; hooks: EnginePoolHooks }) {
    this.config = input.config;
    this.template = input.template;
    this.hooks = input.hooks;
  }

  /**
   * Register the engine spawned during startup as the first generation, so a
   * later rollover knows what it is replacing.
   */
  adoptPrimary(input: {
    handle: ManagedOpencodeServer;
    fingerprint: string;
    registryId: string | null;
    trustedIdentity: string | null;
  }): void {
    this.generations.push({
      id: randomUUID(),
      handle: input.handle,
      status: "primary",
      spawnedAt: Date.now(),
      fingerprint: input.fingerprint,
      registryId: input.registryId,
      trustedIdentity: input.trustedIdentity,
      drainTimer: null,
      drainDeadline: null,
      drainActivityWatch: null,
    });
    this.lastSpawnAt = Date.now();
  }

  primaryUrl(): string | null {
    return this.generations.find((entry) => entry.status === "primary")?.handle.url ?? null;
  }

  primaryProcess(): EnginePoolProcess | null {
    const primary = this.generations.find((entry) => entry.status === "primary") ?? null;
    return primary ? { pid: primary.handle.pid ?? null, isAlive: primary.handle.isAlive } : null;
  }

  reportRequestSuccess(baseUrl: string): void {
    if (this.isPrimaryEndpoint(baseUrl)) this.consecutiveConnectionFailures = 0;
  }

  reportRequestFailure(baseUrl: string, error: unknown, workspace: WorkspaceInfo): void {
    if (!this.isPrimaryEndpoint(baseUrl) || !isEngineConnectionFailure(error)) return;
    this.consecutiveConnectionFailures += 1;
    if (this.consecutiveConnectionFailures < 3) return;
    const now = this.now();
    if (now - this.lastRecoveryAt < minSpawnIntervalMs()) return;
    this.consecutiveConnectionFailures = 0;
    this.lastRecoveryAt = now;
    this.recoveryWorkspace = workspace;
    void this.recoverDeadPrimary(workspace).catch(() => undefined);
  }

  connections(): EnginePoolConnection[] {
    return this.generations
      .filter(isRoutableGeneration)
      .sort((left, right) => left.status === right.status ? 0 : left.status === "primary" ? -1 : 1)
      .map((entry) => this.connectionFor(entry));
  }

  routeRequest(method: string, proxyPath: string): EnginePoolRoute | null {
    const primary = this.generations.find(
      (entry): entry is Generation & { status: "primary" } => entry.status === "primary",
    ) ?? null;
    if (!primary) return null;
    const primaryConnection = this.connectionFor(primary);
    const sessionId = sessionIdFromPath(proxyPath);
    if (sessionId) {
      const owner = this.generationForId(this.sessionOwnership.get(sessionId));
      if (owner) {
        const active = this.activeSessionsByGeneration.get(owner.id)?.has(sessionId) === true;
        if (isPromptishSessionRequest(method, proxyPath) && !active) {
          this.sessionOwnership.delete(sessionId);
        } else {
          return { target: this.connectionFor(owner), fallback: null };
        }
      }
    }

    const requestId = requestIdFromPath(proxyPath);
    if (requestId) {
      const owner = this.generationForId(this.pinnedRequests.get(requestId));
      if (owner) {
        const alternate = isLegacyPromptReply(proxyPath)
          ? this.generations.find((entry) => isRoutableGeneration(entry) && entry.id !== owner.id) ?? null
          : null;
        return {
          target: this.connectionFor(owner),
          fallback: alternate && isRoutableGeneration(alternate) ? this.connectionFor(alternate) : null,
        };
      }
    }

    const draining = this.generations.find(
      (entry): entry is Generation & { status: "draining" } => entry.status === "draining",
    ) ?? null;
    const fallback = draining && isLegacyPromptReply(proxyPath) ? this.connectionFor(draining) : null;
    return { target: primaryConnection, fallback };
  }

  openEventProxy(clientSignal?: AbortSignal): EngineEventProxyLease {
    const controller = new AbortController();
    this.eventProxyControllers.add(controller);
    const signal = clientSignal
      ? AbortSignal.any([clientSignal, controller.signal])
      : controller.signal;
    let released = false;
    return {
      signal,
      release: () => {
        if (released) return;
        released = true;
        this.eventProxyControllers.delete(controller);
      },
    };
  }

  shouldForwardEvent(generationId: string, payload: unknown): boolean {
    const generation = this.generationForId(generationId);
    if (!generation) return false;
    const identifiers = eventIdentifiers(payload);
    if (generation.status === "draining") {
      const ownedSession = [...identifiers.sessionIds].some((id) => this.sessionOwnership.get(id) === generation.id);
      if (ownedSession) {
        for (const requestId of identifiers.requestIds) this.pinnedRequests.set(requestId, generation.id);
      }
      return ownedSession || [...identifiers.requestIds].some((id) => this.pinnedRequests.get(id) === generation.id);
    }
    return ![...identifiers.sessionIds].some((id) => {
      const owner = this.sessionOwnership.get(id);
      return owner !== undefined && owner !== generation.id;
    }) && ![...identifiers.requestIds].some((id) => {
      const owner = this.pinnedRequests.get(id);
      return owner !== undefined && owner !== generation.id;
    });
  }

  observePendingRequests(generationId: string, payload: unknown): string[] {
    const generation = this.generationForId(generationId);
    if (!generation) return [];
    const requestIds: string[] = [];
    for (const record of requestRecords(payload)) {
      const sessionId = firstString(record, ["sessionID", "sessionId", "session_id"]);
      const owner = this.generationForId(sessionId ? this.sessionOwnership.get(sessionId) : undefined) ?? generation;
      const requestId = firstString(record, ["id", "requestID", "requestId", "permissionID", "questionID"]);
      if (requestId) {
        this.pinnedRequests.set(requestId, owner.id);
        requestIds.push(requestId);
      }
      if (sessionId && !this.sessionOwnership.has(sessionId)) this.sessionOwnership.set(sessionId, generation.id);
    }
    return requestIds;
  }

  snapshot(): EnginePoolSnapshot {
    const now = Date.now();
    return {
      generations: this.generations
        .filter((entry) => entry.status !== "dead")
        .map((entry) => ({
          role: entry.status,
          pid: entry.handle.pid ?? null,
          port: portOf(entry.handle.url) || null,
          spawnedAt: entry.spawnedAt,
          drainRemainingMs: entry.drainDeadline === null ? null : Math.max(0, entry.drainDeadline - now),
        })),
    };
  }

  /**
   * Bring the engine onto current config. Idle engines reload in place; busy
   * ones roll over to a standby. Serialized: concurrent requests collapse into
   * one pending rollover so a burst never stacks processes.
   */
  async requestRollover(input: {
    reason: RolloverReason;
    workspace: WorkspaceInfo;
    manual?: boolean;
    awaitPostRefreshSync?: boolean;
    /** Apply a config change through a healthy standby even when the primary is idle. */
    forceStandby?: boolean;
  }): Promise<RolloverOutcome> {
    if (this.disposed) return { action: "skipped", reason: "unchanged" };
    const request = {
      reason: input.reason,
      workspace: input.workspace,
      manual: input.manual === true,
      awaitPostRefreshSync: input.awaitPostRefreshSync !== false,
      forceStandby: input.forceStandby === true,
    };
    if (this.inFlight) {
      // Latest wins: a manual request keeps its manual flag so it still
      // bypasses the fingerprint guard when it runs.
      this.pendingRollover = {
        ...request,
        manual: request.manual || this.pendingRollover?.manual === true,
        awaitPostRefreshSync: request.awaitPostRefreshSync || this.pendingRollover?.awaitPostRefreshSync === true,
        forceStandby: request.forceStandby || this.pendingRollover?.forceStandby === true,
      };
      this.hooks.logger?.log("info", "Engine rollover coalesced into the in-flight request.", {
        "engine.rollover.reason": request.reason,
      });
      return { action: "coalesced" };
    }
    const run = this.runRollover(request);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
      const next = this.pendingRollover;
      this.pendingRollover = null;
      if (next && !this.disposed) {
        void this.requestRollover(next).catch(() => undefined);
      }
    }
  }

  private async runRollover(request: {
    reason: RolloverReason;
    workspace: WorkspaceInfo;
    manual: boolean;
    awaitPostRefreshSync: boolean;
    forceStandby: boolean;
  }): Promise<RolloverOutcome> {
    const { workspace, reason, manual, awaitPostRefreshSync, forceStandby } = request;
    // The standby reads config from disk at spawn, so make sure the file is
    // current before deciding anything.
    await this.hooks.writeRuntimeConfigFile(this.config).catch(() => undefined);
    const fingerprint = await this.currentFingerprint();
    const primary = this.generations.find((entry) => entry.status === "primary") ?? null;

    if (!manual && primary && primary.fingerprint === fingerprint) {
      // Nothing the engine reads at build time changed. Skipping here is what
      // keeps a repeating no-op sync from spawning an engine every pass.
      return { action: "skipped", reason: "unchanged" };
    }

    const busy = forceStandby
      ? true
      : await this.hooks.engineBusy(this.config, workspace).catch(() => false);
    if (!busy) {
      await this.hooks.reloadInPlace(this.config, workspace, { awaitPostRefreshSync });
      if (primary) primary.fingerprint = fingerprint;
      this.hooks.logger?.log("info", "Engine reloaded in place (idle).", {
        "engine.rollover.reason": reason,
      });
      return { action: "reloaded_in_place" };
    }

    const draining = this.generations.find((entry) => entry.status === "draining");
    if (draining) {
      if (forceStandby) {
        this.hooks.logger?.log("info", "Engine standby rollover waiting for the active drain.", {
          "engine.rollover.reason": reason,
        });
        await this.waitForDrain();
        if (this.disposed) return { action: "skipped", reason: "unchanged" };
        return this.runRollover(request);
      }
      // Cap: one primary plus one draining. Park this change; it lands when
      // the current drain finishes.
      this.pendingRollover = { reason, workspace, manual, awaitPostRefreshSync, forceStandby };
      this.hooks.logger?.log("info", "Engine rollover parked behind an active drain.", {
        "engine.rollover.reason": reason,
      });
      return { action: "coalesced" };
    }

    const sinceLastSpawn = Date.now() - this.lastSpawnAt;
    if (!manual && !forceStandby && sinceLastSpawn < minSpawnIntervalMs()) {
      this.pendingRollover = { reason, workspace, manual, awaitPostRefreshSync, forceStandby };
      this.hooks.logger?.log("info", "Engine rollover throttled by the minimum spawn interval.", {
        "engine.rollover.reason": reason,
        "engine.rollover.since_last_spawn_ms": sinceLastSpawn,
      });
      return { action: "coalesced" };
    }

    return await this.rollOver({ reason, workspace, fingerprint, primary });
  }

  private async rollOver(input: {
    reason: RolloverReason;
    workspace: WorkspaceInfo;
    fingerprint: string;
    primary: Generation | null;
  }): Promise<RolloverOutcome> {
    const { reason, workspace, fingerprint, primary } = input;
    this.hooks.logger?.log("info", "Engine rollover requested.", { "engine.rollover.reason": reason });

    let handle: ManagedOpencodeServer;
    this.lastSpawnAt = Date.now();
    try {
      handle = await this.spawn();
    } catch (error) {
      this.hooks.logger?.log("error", "Engine rollover standby failed to start; the live engine is untouched.", {
        "engine.rollover.reason": reason,
        "engine.rollover.failure": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const generation: Generation = {
      id: randomUUID(),
      handle,
      status: "starting",
      spawnedAt: Date.now(),
      fingerprint,
      registryId: null,
      trustedIdentity: null,
      drainTimer: null,
      drainDeadline: null,
      drainActivityWatch: null,
    };
    this.generations.push(generation);

    try {
      await this.waitForHealthy(handle);
    } catch (error) {
      // Never flip onto an engine that has not answered: close the partial
      // standby and leave the primary serving.
      this.generations = this.generations.filter((entry) => entry.id !== generation.id);
      await handle.close().catch(() => undefined);
      this.hooks.logger?.log("error", "Engine rollover standby never became healthy; the live engine is untouched.", {
        "engine.rollover.reason": reason,
        "engine.rollover.failure": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (handle.pid) {
      generation.registryId = randomUUID();
      await registerEngineInstance(this.config, {
        id: generation.registryId,
        pid: handle.pid,
        port: portOf(handle.url),
        url: handle.url,
        startedAt: generation.spawnedAt,
        role: "starting",
        serverRunId: generation.id,
        ownerPid: process.pid,
        authProbe: buildEngineAuthProbeHeader(handle.username, handle.password),
        bin: this.template.bin?.trim() || "opencode",
      }).catch(() => undefined);
    }

    const drainingSessions = await this.nonIdleSessionIds(primary);
    const pinnedRequestIds = await this.pendingRequestIds(primary);
    this.flip(generation, primary, drainingSessions, pinnedRequestIds);

    this.hooks.logger?.log("info", "Engine rollover flipped to the new generation.", {
      "engine.rollover.reason": reason,
      "engine.rollover.pid": handle.pid ?? null,
      "engine.rollover.draining_sessions": drainingSessions.length,
    });

    // Best-effort and off the critical path: the new engine already has disk
    // config; this pushes the runtime-DB MCPs a fresh instance cannot see.
    this.detachPostRefreshSync(workspace);

    if (primary) this.startDrainMonitor(primary, workspace);

    return { action: "rolled_over", generationId: generation.id, drainingSessions: drainingSessions.length };
  }

  /**
   * Point the server at the new generation. Synchronous on purpose: every
   * request resolves its engine from `config`, so there must be no await
   * between demoting the old engine and promoting the new one.
   */
  private flip(
    next: Generation,
    previous: Generation | null,
    drainingSessions: string[],
    pinnedRequestIds: string[],
  ): void {
    next.status = "primary";
    if (previous) previous.status = "draining";

    if (previous) {
      const active = new Set(drainingSessions);
      this.activeSessionsByGeneration.set(previous.id, active);
      for (const sessionId of active) this.sessionOwnership.set(sessionId, previous.id);
      for (const requestId of pinnedRequestIds) this.pinnedRequests.set(requestId, previous.id);
    }

    this.config.opencodeBaseUrl = next.handle.url;
    this.config.opencodeUsername = next.handle.username;
    this.config.opencodePassword = next.handle.password;
    for (const entry of this.config.workspaces) {
      if (entry.workspaceType === "remote") continue;
      entry.baseUrl = next.handle.url;
      entry.opencodeUsername = next.handle.username;
      entry.opencodePassword = next.handle.password;
      entry.directory = entry.path;
    }

    if (previous?.trustedIdentity) {
      try {
        this.hooks.clearTrusted(this.config, previous.trustedIdentity);
      } catch {
        // The registry is advisory; a stale entry must not block the flip.
      }
    }
    next.trustedIdentity = [next.handle.pid ?? "unknown", randomUUID()].join(":");
    try {
      this.hooks.registerTrusted(this.config, {
        baseUrl: next.handle.url,
        identity: next.trustedIdentity,
        isAlive: next.handle.isAlive,
      });
    } catch {
      // Same: diagnostics eligibility only.
    }

    if (next.registryId) void updateEngineInstanceRole(this.config, next.registryId, "primary").catch(() => undefined);
    if (previous?.registryId) {
      void updateEngineInstanceRole(this.config, previous.registryId, "draining").catch(() => undefined);
    }
    this.abortEventProxies();
  }

  /**
   * Watch a draining engine and close it once its runs finish. The grace
   * window bounds inactivity, not total drain time: engine events for an
   * owned session push the deadline out, so a run that is actively making
   * progress is never aborted mid-flight, while a non-idle session that stops
   * reporting anything for the whole window is aborted rather than kept alive
   * forever.
   */
  private startDrainMonitor(generation: Generation, workspace: WorkspaceInfo): void {
    generation.drainDeadline = Date.now() + drainTimeoutMs();
    this.watchDrainActivity(generation);
    const tick = async (): Promise<void> => {
      if (generation.status !== "draining") return;
      const remaining = await this.nonIdleSessionIds(generation);
      this.updateActiveSessions(generation, remaining);
      if (remaining.length === 0) {
        await this.retire(generation, "idle");
        return;
      }
      if (generation.drainDeadline !== null && Date.now() >= generation.drainDeadline) {
        this.hooks.logger?.log("warn", "Engine drain saw no session activity for the grace period; aborting the remaining sessions.", {
          "engine.drain.sessions": remaining.join(","),
          "engine.drain.session_count": remaining.length,
        });
        for (const sessionId of remaining) {
          await this.abortSession(generation, sessionId).catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, abortSettleMs()));
        await this.retire(generation, "forced");
      }
    };
    const timer = setInterval(() => void tick().catch(() => undefined), drainPollIntervalMs());
    timer.unref?.();
    generation.drainTimer = timer;
    // Sessions can finish between the flip and the first poll.
    void tick().catch(() => undefined);
  }

  /**
   * Hold one global event-stream subscription on the draining engine so
   * owned-session activity keeps extending the drain deadline. The client
   * event fan-in only exists while a client is attached; the pool owns this
   * watch so a background run with no observer still counts as active.
   */
  private watchDrainActivity(generation: Generation): void {
    const controller = new AbortController();
    generation.drainActivityWatch = controller;
    void this.runDrainActivityWatch(generation, controller.signal).catch(() => undefined);
  }

  private async runDrainActivityWatch(
    generation: Generation,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && generation.status === "draining") {
      try {
        const url = new URL("/global/event", generation.handle.url);
        const response = await loopbackFetch(url.toString(), {
          headers: { Authorization: buildEngineAuthProbeHeader(generation.handle.username, generation.handle.password) },
          signal,
        });
        if (response.ok && response.body) {
          await this.consumeDrainActivityEvents(generation, response.body, signal);
        }
      } catch {
        // Losing the stream only pauses activity credit. The poll loop still
        // owns the abort decision, and an unreachable engine reports no
        // sessions to drain in the first place.
      }
      if (signal.aborted || generation.status !== "draining") return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, drainActivityReconnectMs());
        timer.unref?.();
      });
    }
  }

  private async consumeDrainActivityEvents(
    generation: Generation,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const frameBuffer = new BoundedSseFrameBuffer();
    try {
      while (!signal.aborted && generation.status === "draining") {
        const chunk = await reader.read();
        if (chunk.done) return;
        const parsed = frameBuffer.push(chunk.value);
        for (const frame of parsed.frames) {
          this.noteDrainActivity(generation, sseFramePayload(frame));
        }
        // A frame that never terminates would buffer without bound; drop the
        // stream and let the watch loop reconnect.
        if (parsed.overflow) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /** An engine event naming an owned session is proof of progress: push the deadline out. */
  private noteDrainActivity(generation: Generation, payload: unknown): void {
    if (payload === null || generation.status !== "draining" || generation.drainDeadline === null) return;
    const owned = this.activeSessionsByGeneration.get(generation.id);
    if (!owned || owned.size === 0) return;
    const { sessionIds } = eventIdentifiers(payload);
    let hasOwnedSession = false;
    for (const sessionId of sessionIds) {
      if (owned.has(sessionId)) {
        hasOwnedSession = true;
        break;
      }
    }
    if (!hasOwnedSession) return;
    const extended = Date.now() + drainTimeoutMs();
    if (extended > generation.drainDeadline) generation.drainDeadline = extended;
  }

  private async retire(generation: Generation, cause: "idle" | "forced" | "shutdown"): Promise<void> {
    if (generation.status === "dead") return;
    generation.status = "dead";
    if (generation.drainTimer) {
      clearInterval(generation.drainTimer);
      generation.drainTimer = null;
    }
    generation.drainActivityWatch?.abort();
    generation.drainActivityWatch = null;
    generation.drainDeadline = null;
    this.activeSessionsByGeneration.delete(generation.id);
    for (const [sessionId, generationId] of this.sessionOwnership) {
      if (generationId === generation.id) this.sessionOwnership.delete(sessionId);
    }
    for (const [requestId, generationId] of this.pinnedRequests) {
      if (generationId === generation.id) this.pinnedRequests.delete(requestId);
    }
    if (generation.trustedIdentity) {
      try {
        this.hooks.clearTrusted(this.config, generation.trustedIdentity);
      } catch {
        // Advisory only.
      }
      generation.trustedIdentity = null;
    }
    let closeError: unknown;
    try {
      await generation.handle.close();
    } catch (error) {
      closeError = error;
    }
    if (generation.registryId) {
      await removeEngineInstance(this.config, generation.registryId).catch(() => undefined);
      generation.registryId = null;
    }
    this.generations = this.generations.filter((entry) => entry.id !== generation.id);
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
    this.hooks.logger?.log("info", "Drained engine closed.", { "engine.drain.cause": cause });

    const next = this.pendingRollover;
    if (cause !== "shutdown" && next && !this.inFlight && !this.disposed) {
      this.pendingRollover = null;
      void this.requestRollover(next).catch(() => undefined);
    }
    if (closeError !== undefined && cause === "shutdown") throw closeError;
  }

  /** Close every engine this pool owns. Draining generations go first. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.pendingRollover = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.abortEventProxies();
    const errors: unknown[] = [];
    const recoveryOrphan = this.recoveryOrphan;
    this.recoveryOrphan = null;
    if (recoveryOrphan) {
      try {
        await recoveryOrphan.close();
      } catch (error) {
        errors.push(error);
      }
    }
    const ordered = [...this.generations].sort((left, right) => {
      if (left.status === right.status) return 0;
      return left.status === "draining" ? -1 : 1;
    });
    for (const generation of ordered) {
      try {
        await this.retire(generation, "shutdown");
      } catch (error) {
        errors.push(error);
      }
    }
    this.generations = [];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to close managed engines");
  }

  private async currentFingerprint(): Promise<string> {
    return computeEngineConfigFingerprint(this.template);
  }

  private waitForDrain(): Promise<void> {
    if (!this.generations.some((entry) => entry.status === "draining")) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  private async recoverDeadPrimary(workspace: WorkspaceInfo): Promise<void> {
    if (this.disposed) return;
    if (this.recoveryInFlight) return this.recoveryInFlight;
    const recovery = this.runDeadPrimaryRecovery(workspace);
    this.recoveryInFlight = recovery;
    try {
      await recovery;
    } finally {
      this.recoveryInFlight = null;
    }
  }

  private async runDeadPrimaryRecovery(workspace: WorkspaceInfo): Promise<void> {
    const previous = this.generations.find((entry) => entry.status === "primary") ?? null;
    let replacement: ManagedOpencodeServer | null = null;
    try {
      if (this.recoveryOrphan) {
        await this.recoveryOrphan.close();
        if (this.recoveryOrphan.isAlive()) throw new Error("Failed replacement remained alive after close");
        this.recoveryOrphan = null;
      }
      if (previous) {
        if (previous.trustedIdentity) {
          try {
            this.hooks.clearTrusted(this.config, previous.trustedIdentity);
          } catch {
            // Advisory only; process teardown must still happen.
          }
        }
        await previous.handle.close();
        if (previous.handle.isAlive()) throw new Error("Managed OpenCode process remained alive after close");
        previous.status = "dead";
        if (previous.registryId) await removeEngineInstance(this.config, previous.registryId).catch(() => undefined);
        this.generations = this.generations.filter((entry) => entry.id !== previous.id);
      }

      const handle = await this.spawn();
      replacement = handle;
      await this.waitForHealthy(handle);
      const generation: Generation = {
        id: randomUUID(),
        handle,
        status: "starting",
        spawnedAt: this.now(),
        fingerprint: await this.currentFingerprint(),
        registryId: null,
        trustedIdentity: null,
        drainTimer: null,
        drainDeadline: null,
        drainActivityWatch: null,
      };
      this.generations.push(generation);
      if (handle.pid) {
        generation.registryId = randomUUID();
        await registerEngineInstance(this.config, {
          id: generation.registryId,
          pid: handle.pid,
          port: portOf(handle.url),
          url: handle.url,
          startedAt: generation.spawnedAt,
          role: "starting",
          serverRunId: generation.id,
          ownerPid: process.pid,
          authProbe: buildEngineAuthProbeHeader(handle.username, handle.password),
          bin: this.template.bin?.trim() || "opencode",
        }).catch(() => undefined);
      }
      this.flip(generation, null, [], []);
      replacement = null;
      this.consecutiveConnectionFailures = 0;
      this.recoveryWorkspace = null;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.detachPostRefreshSync(workspace);
    } catch (error) {
      if (replacement) {
        try {
          await replacement.close();
          if (replacement.isAlive()) this.recoveryOrphan = replacement;
        } catch {
          this.recoveryOrphan = replacement;
        }
      }
      this.hooks.logger?.log("error", "Managed engine recovery failed; retry scheduled.", {
        "engine.recovery.failure": error instanceof Error ? error.message : String(error),
      });
      this.scheduleRecovery(workspace);
      throw error;
    }
  }

  private scheduleRecovery(workspace: WorkspaceInfo): void {
    if (this.disposed || this.recoveryTimer) return;
    this.recoveryWorkspace = workspace;
    const delayMs = Math.max(1, minSpawnIntervalMs() - (this.now() - this.lastRecoveryAt));
    const schedule = this.hooks.schedule ?? ((operation: () => void, delay: number) => setTimeout(operation, delay));
    this.recoveryTimer = schedule(() => {
      this.recoveryTimer = null;
      const pendingWorkspace = this.recoveryWorkspace;
      if (!pendingWorkspace || this.disposed) return;
      this.lastRecoveryAt = this.now();
      void this.recoverDeadPrimary(pendingWorkspace).catch(() => undefined);
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  private spawn(): Promise<ManagedOpencodeServer> {
    if (this.hooks.spawn) return this.hooks.spawn(this.template);
    return createManagedOpencodeServer({
      bin: this.template.bin,
      cwd: this.template.cwd,
      excludedPorts: this.template.reservedPorts(),
      ...(this.template.spawnTimeoutMs ? { timeoutMs: this.template.spawnTimeoutMs } : {}),
      env: {
        ...this.template.env,
        OPENCODE_CONFIG: this.template.runtimeConfigPath,
      },
    });
  }

  private detachPostRefreshSync(workspace: WorkspaceInfo): void {
    void this.hooks.postRefreshSync(this.config, workspace).catch((error) => {
      this.hooks.logger?.log("error", "Engine post-refresh MCP sync failed.", {
        "workspace.id": workspace.id,
        "engine.post_refresh.failure": error instanceof Error ? error.message : String(error),
      });
    });
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  private isPrimaryEndpoint(baseUrl: string): boolean {
    try {
      const primary = this.primaryUrl();
      return primary !== null && new URL(primary).origin === new URL(baseUrl).origin;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(handle: ManagedOpencodeServer, attempts = 10): Promise<void> {
    if (this.hooks.waitForHealthy) return this.hooks.waitForHealthy(handle);
    const authorization = buildEngineAuthProbeHeader(handle.username, handle.password);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await loopbackFetch(new URL("/global/health", handle.url).toString(), {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Standby OpenCode engine did not report healthy");
  }

  private async nonIdleSessionIds(generation: Generation | null): Promise<string[]> {
    if (!generation || generation.status === "dead" || !generation.handle.isAlive()) return [];
    const sessionIds = new Set<string>();
    await Promise.all(this.engineProbeDirectories().map(async (directory) => {
      try {
        const url = new URL("/session/status", generation.handle.url);
        if (directory !== null) url.searchParams.set("directory", directory);
        const response = await loopbackFetch(url.toString(), {
          headers: { Authorization: buildEngineAuthProbeHeader(generation.handle.username, generation.handle.password) },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        if (!isRecord(payload)) return;
        for (const [sessionId, status] of Object.entries(payload)) {
          if (isRecord(status) && status.type !== "idle") sessionIds.add(sessionId);
        }
      } catch {
        // Unknown activity never keeps a drain open forever; the grace timeout
        // still bounds it, and an unreachable engine has nothing left to drain.
      }
    }));
    return [...sessionIds];
  }

  private engineProbeDirectories(): Array<string | null> {
    const directories = new Set(
      this.config.workspaces
        .filter((workspace) => workspace.workspaceType !== "remote")
        .map((workspace) => workspace.path),
    );
    return directories.size > 0 ? [...directories] : [null];
  }

  private async pendingRequestIds(generation: Generation | null): Promise<string[]> {
    if (!generation || generation.status === "dead" || !generation.handle.isAlive()) return [];
    const requestIds = new Set<string>();
    await Promise.all(this.engineProbeDirectories().flatMap((directory) =>
      ["/permission", "/question", "/api/permission/request", "/api/question/request"].map(async (path) => {
        try {
          const url = new URL(path, generation.handle.url);
          if (directory !== null) url.searchParams.set("directory", directory);
          const response = await loopbackFetch(url.toString(), {
            headers: { Authorization: buildEngineAuthProbeHeader(generation.handle.username, generation.handle.password) },
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) return;
          const payload: unknown = await response.json();
          for (const requestId of this.observePendingRequests(generation.id, payload)) {
            requestIds.add(requestId);
          }
        } catch {
          // The legacy and v2 surfaces vary by bundled engine version. A missing
          // list never blocks the rollover; path routing still handles scoped ids.
        }
      }),
    ));
    return [...requestIds];
  }

  private updateActiveSessions(generation: Generation, sessionIds: string[]): void {
    const next = new Set(sessionIds);
    this.activeSessionsByGeneration.set(generation.id, next);
    for (const [sessionId, generationId] of this.sessionOwnership) {
      if (generationId === generation.id && !next.has(sessionId)) this.sessionOwnership.delete(sessionId);
    }
    for (const sessionId of next) this.sessionOwnership.set(sessionId, generation.id);
  }

  private connectionFor(generation: Generation & { status: "primary" | "draining" }): EnginePoolConnection {
    return {
      generationId: generation.id,
      role: generation.status,
      baseUrl: generation.handle.url,
      username: generation.handle.username,
      password: generation.handle.password,
    };
  }

  private generationForId(generationId: string | undefined): (Generation & { status: "primary" | "draining" }) | null {
    if (!generationId) return null;
    const generation = this.generations.find((entry) => entry.id === generationId) ?? null;
    return generation && isRoutableGeneration(generation) ? generation : null;
  }

  private abortEventProxies(): void {
    const controllers = [...this.eventProxyControllers];
    this.eventProxyControllers.clear();
    for (const controller of controllers) controller.abort(new Error("OpenCode engine generation changed"));
  }

  private async abortSession(generation: Generation, sessionId: string): Promise<void> {
    this.hooks.logger?.log("info", "Aborting OpenCode session from engine pool.", {
      "abort.source": "engine_pool.drain_timeout",
      "abort.initiator": "system",
      "abort.reason": "draining engine saw no session activity for the grace period",
      "session.id": sessionId,
      "engine.generation_id": generation.id,
    });
    try {
      await loopbackFetch(new URL(`/session/${encodeURIComponent(sessionId)}/abort`, generation.handle.url).toString(), {
        method: "POST",
        headers: { Authorization: buildEngineAuthProbeHeader(generation.handle.username, generation.handle.password) },
        signal: AbortSignal.timeout(5_000),
      });
      this.hooks.logger?.log("info", "OpenCode session abort from engine pool completed.", {
        "abort.source": "engine_pool.drain_timeout",
        "abort.initiator": "system",
        "session.id": sessionId,
        "engine.generation_id": generation.id,
      });
    } catch (error) {
      this.hooks.logger?.log("error", "OpenCode session abort from engine pool failed.", {
        "abort.source": "engine_pool.drain_timeout",
        "abort.initiator": "system",
        "session.id": sessionId,
        "engine.generation_id": generation.id,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

const poolByConfig = new WeakMap<ServerConfig, EnginePool>();

export function setEnginePoolForConfig(config: ServerConfig, pool: EnginePool): void {
  poolByConfig.set(config, pool);
}

export function enginePoolForConfig(config: ServerConfig): EnginePool | null {
  return poolByConfig.get(config) ?? null;
}

export function clearEnginePoolForConfig(config: ServerConfig): void {
  poolByConfig.delete(config);
}
