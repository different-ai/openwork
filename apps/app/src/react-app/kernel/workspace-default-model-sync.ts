import { useEffect } from "react";

import { OpenworkServerError, type OpenworkServerClient, type WorkspaceDefaultModelRef } from "../../app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "../../app/lib/workspace-endpoint";
import type { ModelRef } from "../../app/types";

export type WorkspaceDefaultModelSyncTarget = {
  serverKey: string;
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

  forget(target: Pick<WorkspaceDefaultModelSyncTarget, "serverKey" | "workspaceKey">): void {
    const key = JSON.stringify([target.serverKey, target.workspaceKey]);
    this.pending.get(key)?.cancel();
    this.pending.delete(key);
    this.sent.delete(key);
  }

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
  connected: boolean;
  model: ModelRef | null;
  variant: string | null;
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
    const payload = workspaceDefaultModelPayload({ providerID, modelID }, variant);
    if (!payload) return;
    sync.schedule({
      serverKey,
      workspaceKey,
      put: (next) => client.setWorkspaceDefaultModel(workspaceId, next),
    }, payload);
  }, [client, serverKey, workspaceId, workspaceKey, connected, pending, providerID, modelID, variant, sync]);
}
