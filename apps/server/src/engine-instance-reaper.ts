/**
 * Idle eviction for per-directory OpenCode engine instances.
 *
 * The managed engine is one long-lived process that boots a per-directory
 * instance on demand and never retires one on its own. Since the continuous
 * engine keeps that process alive across workspace switches, every workspace
 * ever visited retains a live instance — config, plugins, watchers, session
 * caches — for the lifetime of the app. This reaper reclaims those instances.
 *
 * Policy: an instance is evicted only when every hold is absent —
 * - it is not the active workspace's instance,
 * - no engine event stream from that workspace is open (no visible UI),
 * - it reports no non-idle session (a live background run always stays), and
 * - it has seen no traffic for the idle TTL.
 *
 * Sessions live in the engine's shared SQLite, so an evicted instance loses
 * only process state. The next request re-materializes it from disk config;
 * the server owns pushing back the runtime-DB MCPs a fresh instance cannot
 * read from disk, which is why eviction marks the workspace and `noteUsed`
 * reports that mark exactly once to whoever sends the next traffic.
 *
 * Only managed engines are swept: an attached engine may serve other clients,
 * so its instances are not ours to trim. The hooks own every side effect; this
 * module holds the policy and its bookkeeping.
 */
import type { ServerConfig } from "./types.js";

export type EngineInstanceReaperLogger = {
  log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

export type EngineInstanceUse = {
  directory: string;
  workspaceId: string;
  engineBaseUrl: string;
};

export type TrackedEngineInstance = EngineInstanceUse & {
  lastUsedAt: number;
  streamHolds: number;
};

export type EngineInstanceReaperHooks = {
  /** Primary managed engine URL. Null means no managed engine: nothing is swept. */
  engineBaseUrl: () => string | null;
  /** Directory of the active local workspace. Its instance always stays warm. */
  activeDirectory: () => string | null;
  /** True when the instance still reports a non-idle session. A thrown error means unknown, which never evicts. */
  directoryBusy: (instance: TrackedEngineInstance) => Promise<boolean>;
  /** Dispose the instance and invalidate whatever per-workspace evidence a fresh instance cannot honor. */
  dispose: (instance: TrackedEngineInstance) => Promise<void>;
  now?: () => number;
  logger?: EngineInstanceReaperLogger;
};

/** How long an instance may sit unused before it is eligible for eviction. 0 disables eviction. */
export function engineInstanceIdleTtlMs(): number {
  const raw = process.env.OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS?.trim();
  if (!raw) return 15 * 60_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 15 * 60_000;
}

function sweepIntervalMs(): number {
  const value = Number(process.env.OPENWORK_ENGINE_INSTANCE_SWEEP_MS);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

export class EngineInstanceReaper {
  private readonly hooks: EngineInstanceReaperHooks;
  private readonly instances = new Map<string, TrackedEngineInstance>();
  private readonly evictedWorkspaceIds = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private closed = false;

  constructor(hooks: EngineInstanceReaperHooks) {
    this.hooks = hooks;
  }

  /**
   * Record traffic for a directory instance. Returns true exactly once after
   * that workspace's instance was evicted, so the caller can re-attach the
   * state a fresh instance cannot recover from disk.
   */
  noteUsed(use: EngineInstanceUse): boolean {
    if (this.closed) return false;
    const existing = this.instances.get(use.directory);
    if (existing && existing.engineBaseUrl === use.engineBaseUrl) {
      existing.workspaceId = use.workspaceId;
      existing.lastUsedAt = this.now();
    } else {
      // A different engine URL means a new engine process; streams held on the
      // previous generation were aborted with it.
      this.instances.set(use.directory, { ...use, lastUsedAt: this.now(), streamHolds: 0 });
    }
    return this.evictedWorkspaceIds.delete(use.workspaceId);
  }

  /**
   * Hold the instance while an engine event stream from its workspace stays
   * open, so a workspace that is visible anywhere in the UI is never evicted.
   * Unlike `noteUsed` this never consumes the one-shot post-eviction mark;
   * callers report that mark through their own `noteUsed` call.
   */
  holdStream(use: EngineInstanceUse): () => void {
    if (this.closed) return () => undefined;
    const existing = this.instances.get(use.directory);
    let entry: TrackedEngineInstance;
    if (existing && existing.engineBaseUrl === use.engineBaseUrl) {
      existing.workspaceId = use.workspaceId;
      existing.lastUsedAt = this.now();
      entry = existing;
    } else {
      entry = { ...use, lastUsedAt: this.now(), streamHolds: 0 };
      this.instances.set(use.directory, entry);
    }
    entry.streamHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.instances.get(use.directory);
      if (!current || current.engineBaseUrl !== use.engineBaseUrl) return;
      current.streamHolds = Math.max(0, current.streamHolds - 1);
      current.lastUsedAt = this.now();
    };
  }

  snapshot(): TrackedEngineInstance[] {
    return [...this.instances.values()].map((entry) => ({ ...entry }));
  }

  start(): void {
    if (this.closed || this.sweepTimer) return;
    const timer = setInterval(() => void this.sweep().catch(() => undefined), sweepIntervalMs());
    timer.unref?.();
    this.sweepTimer = timer;
  }

  close(): void {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.instances.clear();
    this.evictedWorkspaceIds.clear();
  }

  /** Run one eviction pass. Returns how many instances were evicted. */
  async sweep(): Promise<number> {
    if (this.closed || this.sweeping) return 0;
    const ttl = engineInstanceIdleTtlMs();
    if (ttl <= 0) return 0;
    const engineBaseUrl = this.hooks.engineBaseUrl();
    if (!engineBaseUrl) return 0;
    this.sweeping = true;
    try {
      const activeDirectory = this.hooks.activeDirectory();
      let evicted = 0;
      for (const entry of [...this.instances.values()]) {
        if (this.closed) break;
        if (entry.engineBaseUrl !== engineBaseUrl) {
          // The engine process this instance lived in is gone; there is
          // nothing left to dispose.
          this.instances.delete(entry.directory);
          continue;
        }
        if (entry.directory === activeDirectory) {
          entry.lastUsedAt = this.now();
          continue;
        }
        if (entry.streamHolds > 0) continue;
        if (this.now() - entry.lastUsedAt < ttl) continue;
        let busy: boolean;
        try {
          busy = await this.hooks.directoryBusy(entry);
        } catch (error) {
          this.hooks.logger?.log("warn", "Engine instance activity probe failed; the instance stays.", {
            "engine.instance.directory": entry.directory,
            "engine.instance.workspace_id": entry.workspaceId,
            "error.message": error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (busy) {
          entry.lastUsedAt = this.now();
          continue;
        }
        // Traffic may have landed while the probe ran; a fresh touch wins.
        if (this.now() - entry.lastUsedAt < ttl) continue;
        try {
          await this.hooks.dispose(entry);
        } catch (error) {
          this.hooks.logger?.log("warn", "Idle engine instance dispose failed; it will be retried.", {
            "engine.instance.directory": entry.directory,
            "engine.instance.workspace_id": entry.workspaceId,
            "error.message": error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        this.instances.delete(entry.directory);
        this.evictedWorkspaceIds.add(entry.workspaceId);
        evicted += 1;
        this.hooks.logger?.log("info", "Evicted an idle engine instance.", {
          "engine.instance.directory": entry.directory,
          "engine.instance.workspace_id": entry.workspaceId,
          "engine.instance.idle_ms": this.now() - entry.lastUsedAt,
        });
      }
      return evicted;
    } finally {
      this.sweeping = false;
    }
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }
}

const reaperByConfig = new WeakMap<ServerConfig, EngineInstanceReaper>();

export function setEngineInstanceReaperForConfig(config: ServerConfig, reaper: EngineInstanceReaper): void {
  reaperByConfig.set(config, reaper);
}

export function engineInstanceReaperForConfig(config: ServerConfig): EngineInstanceReaper | null {
  return reaperByConfig.get(config) ?? null;
}

export function clearEngineInstanceReaperForConfig(config: ServerConfig): void {
  reaperByConfig.delete(config);
}
