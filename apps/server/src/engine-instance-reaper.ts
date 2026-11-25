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
  engineBaseUrl: () => string | null;
  activeDirectory: () => string | null;
  directoryBusy: (instance: TrackedEngineInstance) => Promise<boolean>;
  dispose: (instance: TrackedEngineInstance) => Promise<void>;
  now?: () => number;
  logger?: EngineInstanceReaperLogger;
};

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

  noteUsed(use: EngineInstanceUse): boolean {
    if (this.closed) return false;
    const existing = this.instances.get(use.directory);
    if (existing && existing.engineBaseUrl === use.engineBaseUrl) {
      existing.workspaceId = use.workspaceId;
      existing.lastUsedAt = this.now();
    } else {
      this.instances.set(use.directory, { ...use, lastUsedAt: this.now(), streamHolds: 0 });
    }
    return this.evictedWorkspaceIds.delete(use.workspaceId);
  }

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
