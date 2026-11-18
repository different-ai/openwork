import { useEffect } from "react";

import { OpenworkServerError, type OpenworkServerClient, type WorkspaceDefaultModelRef } from "../../app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "../../app/lib/workspace-endpoint";
import type { ModelRef } from "../../app/types";

/**
 * Mirrors the model a new chat in a workspace would use onto that workspace's
 * OpenWork server, so background callers (automations, remote sessions, cloud
 * workers) start sessions on the same model instead of a stale engine default.
 * Best effort: failures are swallowed and never reach the UI.
 */

export type WorkspaceDefaultModelSyncTarget = {
  /** Identifies the OpenWork server; an older server without the route disables sync for all its workspaces. */
  serverKey: string;
  /** Identifies the workspace (and credentials) on that server for dedupe. */
  workspaceKey: string;
  put: (model: WorkspaceDefaultModelRef | null) => Promise<unknown>;
};

type CancelTimer = () => void;
type ScheduleTimer = (run: () => void, ms: number) => CancelTimer;

type PendingSync = { cancel: CancelTimer; serialized: string };

const DEFAULT_DEBOUNCE_MS = 750;

const defaultScheduleTimer: ScheduleTimer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/** A 404 that is not about the workspace means the server predates the route. */
function isMissingRoute(error: unknown): boolean {
  return error instanceof OpenworkServerError && error.status === 404 && error.code !== "workspace_not_found";
}

export function workspaceDefaultModelPayload(model: ModelRef | null, variant: string | null): WorkspaceDefaultModelRef | null {
  const providerID = model?.providerID.trim() ?? "";
  const modelID = model?.modelID.trim() ?? "";
  if (!providerID || !modelID) return null;
  const trimmedVariant = variant?.trim();
  return trimmedVariant ? { providerID, modelID, variant: trimmedVariant } : { providerID, modelID };
}

export class WorkspaceDefaultModelSync {
  private readonly debounceMs: number;
  private readonly scheduleTimer: ScheduleTimer;
  private readonly sent = new Map<string, string>();
  private readonly pending = new Map<string, PendingSync>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly disabledServers = new Set<string>();

  constructor(options: { debounceMs?: number; scheduleTimer?: ScheduleTimer } = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
  }

  private key(target: WorkspaceDefaultModelSyncTarget): string {
    return JSON.stringify([target.serverKey, target.workspaceKey]);
  }

  isDisabled(serverKey: string): boolean {
    return this.disabledServers.has(serverKey);
  }

  /** Queue a write of `model`; repeated or unchanged values within the debounce window collapse into one PUT. */
  schedule(target: WorkspaceDefaultModelSyncTarget, model: WorkspaceDefaultModelRef | null): void {
    if (this.disabledServers.has(target.serverKey)) return;
    const key = this.key(target);
    const serialized = JSON.stringify(model);
    const existing = this.pending.get(key);
    if (existing?.serialized === serialized) return;
    existing?.cancel();
    this.pending.delete(key);
    if (this.sent.get(key) === serialized) return;
    const cancel = this.scheduleTimer(() => {
      this.pending.delete(key);
      this.enqueue(key, target, model, serialized);
    }, this.debounceMs);
    this.pending.set(key, { cancel, serialized });
  }

  /** Forget what a workspace was sent (e.g. its server disconnected) so the next schedule writes again. */
  forget(target: Pick<WorkspaceDefaultModelSyncTarget, "serverKey" | "workspaceKey">): void {
    const key = JSON.stringify([target.serverKey, target.workspaceKey]);
    this.pending.get(key)?.cancel();
    this.pending.delete(key);
    this.sent.delete(key);
  }

  /** Resolves once every queued write has settled. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private enqueue(key: string, target: WorkspaceDefaultModelSyncTarget, model: WorkspaceDefaultModelRef | null, serialized: string): void {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.write(key, target, model, serialized));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async write(key: string, target: WorkspaceDefaultModelSyncTarget, model: WorkspaceDefaultModelRef | null, serialized: string): Promise<void> {
    if (this.disabledServers.has(target.serverKey) || this.sent.get(key) === serialized) return;
    this.sent.set(key, serialized);
    try {
      await target.put(model);
    } catch (error) {
      if (this.sent.get(key) === serialized) this.sent.delete(key);
      if (isMissingRoute(error)) {
        this.disabledServers.add(target.serverKey);
        return;
      }
      console.warn("[workspace-default-model] sync failed", error);
    }
  }
}

const sharedSync = new WorkspaceDefaultModelSync();

export type UseWorkspaceDefaultModelSyncInput = {
  endpoint: (Pick<ResolvedWorkspaceEndpoint, "baseUrl" | "token" | "workspaceId"> & {
    client: Pick<OpenworkServerClient, "setWorkspaceDefaultModel">;
  }) | null;
  /** False while the workspace's server is unreachable; a reconnect writes again. */
  connected: boolean;
  /** The model a new chat would actually use (after dropping unavailable Auto). */
  model: ModelRef | null;
  variant: string | null;
  /** True while entitlement is still being checked and the effective model is not known yet. */
  pending: boolean;
  sync?: WorkspaceDefaultModelSync;
};

export function useWorkspaceDefaultModelSync(input: UseWorkspaceDefaultModelSyncInput): void {
  const { endpoint, connected, pending, sync = sharedSync } = input;
  const client = endpoint?.client ?? null;
  const serverKey = endpoint?.baseUrl.trim() ?? "";
  const workspaceId = endpoint?.workspaceId.trim() ?? "";
  const workspaceKey = JSON.stringify([workspaceId, endpoint?.token ?? ""]);
  const providerID = input.model?.providerID ?? "";
  const modelID = input.model?.modelID ?? "";
  const variant = input.variant;

  useEffect(() => {
    if (!client || !serverKey || !workspaceId) return;
    if (!connected) {
      sync.forget({ serverKey, workspaceKey });
      return;
    }
    if (pending) return;
    // With no usable model right now (e.g. Auto is unavailable and nothing
    // else is set), keep the server's last default instead of clearing it.
    const payload = workspaceDefaultModelPayload({ providerID, modelID }, variant);
    if (!payload) return;
    sync.schedule({
      serverKey,
      workspaceKey,
      put: (next) => client.setWorkspaceDefaultModel(workspaceId, next),
    }, payload);
  }, [client, serverKey, workspaceId, workspaceKey, connected, pending, providerID, modelID, variant, sync]);
}
