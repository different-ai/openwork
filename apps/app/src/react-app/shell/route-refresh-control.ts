import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "./route-workspaces";

export type RouteRefreshAttempt = {
  readonly generation: number;
  isCurrent(): boolean;
  finish(): boolean;
};

export type RouteRefreshLifecycle = {
  begin(options?: { supersede?: boolean }): RouteRefreshAttempt | null;
  isInFlight(): boolean;
};

export type RouteWorkspaceLoadCoalescer = {
  run(workspaceId: string, scope: string, load: (isCurrent: () => boolean) => Promise<void>): Promise<void>;
  isInFlight(workspaceId: string): boolean;
  invalidate(workspaceId: string): void;
};

export type LatestWorkspaceCommitter = {
  request(workspaceId: string): void;
  settled(): Promise<void>;
};

export type RouteWorkspaceSelectionCommit = (workspaceId: string) => Promise<void>;

export type RouteWorkspaceSelectionCommitter = {
  request(workspaceId: string, commit: RouteWorkspaceSelectionCommit): void;
  settled(): Promise<void>;
};

export function createLatestWorkspaceCommitter(
  commit: (workspaceId: string) => Promise<void>,
): LatestWorkspaceCommitter {
  const committer = createRouteWorkspaceSelectionCommitter();

  return {
    request(workspaceId) {
      committer.request(workspaceId, commit);
    },
    settled: () => committer.settled(),
  };
}

export function createRouteWorkspaceSelectionCommitter(): RouteWorkspaceSelectionCommitter {
  let pending: { workspaceId: string; commit: RouteWorkspaceSelectionCommit } | null = null;
  let running: Promise<void> | null = null;

  const drain = async () => {
    while (pending !== null) {
      const request = pending;
      pending = null;
      let succeeded = true;
      try {
        await request.commit(request.workspaceId);
      } catch {
        succeeded = false;
      }
      const newerRequest = pending as { workspaceId: string; commit: RouteWorkspaceSelectionCommit } | null;
      if (succeeded && newerRequest?.workspaceId === request.workspaceId) pending = null;
    }
  };

  const start = () => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (pending !== null) start();
    });
  };

  return {
    request(workspaceId, commit) {
      const id = workspaceId.trim();
      if (!id) return;
      pending = { workspaceId: id, commit };
      start();
    },
    async settled() {
      while (running) await running;
    },
  };
}

export const routeWorkspaceSelectionCommitter = createRouteWorkspaceSelectionCommitter();

export async function commitRouteWorkspaceSelection(input: {
  workspaceId: string;
  desktopRuntime: boolean;
  setDesktopSelected: (workspaceId: string) => Promise<unknown>;
  setDesktopRuntimeActive: (workspaceId: string) => Promise<unknown>;
  activateWorkspace: (workspaceId: string) => Promise<unknown>;
}): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return;
  if (input.desktopRuntime) {
    await input.setDesktopSelected(workspaceId).catch(() => undefined);
    await input.setDesktopRuntimeActive(workspaceId).catch(() => undefined);
  }
  await input.activateWorkspace(workspaceId);
}

export async function mapRouteWorkspaceLoads<T, R>(
  workspaces: readonly T[],
  load: (workspace: T) => Promise<R>,
): Promise<R[]> {
  const batchSize = 4;
  const results: R[] = [];
  for (let offset = 0; offset < workspaces.length; offset += batchSize) {
    results.push(...await Promise.all(workspaces.slice(offset, offset + batchSize).map(load)));
  }
  return results;
}

export function createRouteWorkspaceLoadCoalescer(): RouteWorkspaceLoadCoalescer {
  const current = new Map<string, { scope: string; promise: Promise<void> | null }>();

  return {
    run(workspaceId, scope, load) {
      const existing = current.get(workspaceId);
      if (existing?.scope === scope && existing.promise) return existing.promise;

      const entry: { scope: string; promise: Promise<void> | null } = { scope, promise: null };
      const isCurrent = () => current.get(workspaceId) === entry;
      const request = Promise.resolve().then(() => {
        if (isCurrent()) return load(isCurrent);
      });
      const tracked = request.finally(() => {
        entry.promise = null;
      });
      entry.promise = tracked;
      current.set(workspaceId, entry);
      return tracked;
    },
    isInFlight: (workspaceId) => Boolean(current.get(workspaceId)?.promise),
    invalidate: (workspaceId) => { current.delete(workspaceId); },
  };
}

export function routeWorkspaceSessionLoadScope(
  workspace: RouteWorkspace,
  endpoint: ResolvedWorkspaceEndpoint | null,
  engineV2ChatRouting: boolean | undefined,
): string | null {
  if (!endpoint || engineV2ChatRouting === undefined) return null;
  return JSON.stringify([
    workspace.workspaceType,
    workspace.path,
    endpoint.baseUrl,
    endpoint.workspaceId,
    endpoint.mountedBaseUrl,
    endpoint.opencodeBaseUrl,
    endpoint.token,
    engineV2ChatRouting,
  ]);
}

export function planRouteWorkspaceLoads(
  workspaceIds: string[],
  selectedWorkspaceId: string,
  loadedWorkspaceIds: ReadonlySet<string>,
): string[] {
  const selectedId = selectedWorkspaceId.trim();
  const selectedFirst = selectedId && !loadedWorkspaceIds.has(selectedId) && workspaceIds.includes(selectedId)
    ? [selectedId]
    : [];
  const remaining = workspaceIds.filter((id) => id !== selectedId && !loadedWorkspaceIds.has(id));
  return [...selectedFirst, ...remaining];
}

export function createRouteRefreshLifecycle(): RouteRefreshLifecycle {
  let latestGeneration = 0;
  let inFlightGeneration = 0;

  return {
    begin(options) {
      if (inFlightGeneration !== 0 && !options?.supersede) return null;
      const generation = ++latestGeneration;
      inFlightGeneration = generation;
      return {
        generation,
        isCurrent: () => latestGeneration === generation,
        finish: () => {
          if (inFlightGeneration !== generation) return false;
          inFlightGeneration = 0;
          return true;
        },
      };
    },
    isInFlight: () => inFlightGeneration !== 0,
  };
}

export type RouteConnectionGapPlan = {
  retainExistingState: boolean;
  markRouteReady: boolean;
};

export function planRouteConnectionGap(input: { desktopRuntime: boolean }): RouteConnectionGapPlan {
  if (input.desktopRuntime) {
    return { retainExistingState: true, markRouteReady: false };
  }
  return { retainExistingState: false, markRouteReady: true };
}

export async function publishSettingsShellAndLoadHistory<T>({ isCurrent, publishShell, loadHistory, publishHistory }: {
  isCurrent: () => boolean;
  publishShell: () => void;
  loadHistory: () => Promise<T>;
  publishHistory: (history: T) => void;
}) {
  if (!isCurrent()) return;
  publishShell();
  const history = await loadHistory();
  if (isCurrent()) publishHistory(history);
}
