// Concurrency and degraded-state policy for the session route's
// refreshRouteState. Extracted as pure helpers so the desktop restart
// recovery contract is unit-testable without rendering the route.

export type RouteRefreshAttempt = {
  readonly generation: number;
  /**
   * False once a newer refresh began. Stale attempts must stop writing
   * route state: their remaining awaits resolve against a connection that
   * newer attempts already replaced.
   */
  isCurrent(): boolean;
  /**
   * Release the in-flight slot if this attempt still owns it. A superseded
   * attempt no longer owns the slot, so its completion cannot re-open the
   * route for a duplicate refresh while the newer attempt is still running.
   */
  finish(): boolean;
};

export type RouteRefreshLifecycle = {
  /**
   * Start a refresh attempt. Returns null while another attempt is in
   * flight unless `supersede` is set, which cancels the in-flight attempt
   * (its `isCurrent()` turns false) instead of forcibly resetting a shared
   * latch and letting two writers race.
   */
  begin(options?: { supersede?: boolean }): RouteRefreshAttempt | null;
  isInFlight(): boolean;
};

export type RouteWorkspaceLoadCoalescer = {
  /**
   * Run at most one session-list request chain per workspace. Concurrent
   * callers share the active chain until it settles, including its backoff
   * waits and retries.
   */
  run(workspaceId: string, load: () => Promise<void>): Promise<void>;
  isInFlight(workspaceId: string): boolean;
};

export type LatestWorkspaceCommitter = {
  /** Queue the route's newest workspace. Intermediate requests are discarded. */
  request(workspaceId: string): void;
  /** Resolve after the current commit and any newer queued commit finish. */
  settled(): Promise<void>;
};

export type RouteWorkspaceSelectionCommit = (workspaceId: string) => Promise<void>;

export type RouteWorkspaceSelectionCommitter = {
  /** Queue the newest route selection, including the route's live commit implementation. */
  request(workspaceId: string, commit: RouteWorkspaceSelectionCommit): void;
  /** Resolve after the current commit and any newer queued route selection finish. */
  settled(): Promise<void>;
};

/**
 * Serialize workspace-selection side effects while retaining only the newest
 * request. Desktop persistence and server activation cannot safely race: an
 * older, slower request must finish before the final route is committed.
 */
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

/**
 * Serialize workspace selection across route lifetimes. A component-local
 * queue disappears when navigation unmounts the session route, which lets a
 * pending session selection race the Settings route's first runtime reads.
 * Each request carries its route's live commit callback so the shared queue
 * can outlive either component while retaining only the newest destination.
 */
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
      // A newer request for the same workspace is satisfied only when this
      // commit succeeded. After a failure, retain the newer route's callback
      // because it may hold a freshly resolved connection.
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

/** One last-selection-wins queue shared by session, Settings, and extensions routes. */
export const routeWorkspaceSelectionCommitter = createRouteWorkspaceSelectionCommitter();

/**
 * Apply the three workspace-selection side effects in a stable order. The
 * desktop store implements selected and runtime-active as separate read/write
 * mutations, so issuing them concurrently can make the last writer restore
 * stale fields from its earlier read.
 */
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

/**
 * Coalesce the complete session-list load chain for each workspace.
 *
 * Cold OpenCode reads can legitimately outlive a fixed staleness threshold.
 * Keeping ownership until the promise settles prevents route, settings, and
 * visibility refreshes from starting overlapping retries for the same
 * workspace while still allowing different workspaces to load concurrently.
 */
export function createRouteWorkspaceLoadCoalescer(): RouteWorkspaceLoadCoalescer {
  const inFlight = new Map<string, Promise<void>>();

  return {
    run(workspaceId, load) {
      const existing = inFlight.get(workspaceId);
      if (existing) return existing;

      const request = Promise.resolve().then(load);
      const tracked = request.finally(() => {
        if (inFlight.get(workspaceId) === tracked) inFlight.delete(workspaceId);
      });
      inFlight.set(workspaceId, tracked);
      return tracked;
    },
    isInFlight: (workspaceId) => inFlight.has(workspaceId),
  };
}

/**
 * Every workspace with an unloaded session index gets a background load, with
 * the routed workspace first so the visible pane fills fastest. Loading only
 * the routed workspace left every other workspace's sidebar showing the
 * "No tasks yet." empty state on launch even when it had sessions, because
 * nothing else ever fetched their session lists. Session-list loads are
 * read-only native `session.list` calls, so this does not interact with the
 * workspace-activation serialization from the switching-coherence fix.
 */
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
  /**
   * Keep the workspaces, session lists, selection, and host info as display
   * state instead of clearing them. The live client and endpoint resolver
   * are quarantined either way: during a gap the previous loopback port is
   * no longer owned by our server, so no request may carry the previous
   * bearer token there.
   */
  retainExistingState: boolean;
  /**
   * Whether this refresh may report route readiness to the boot overlay.
   * A transient desktop gap must not: the overlay stays up until a refresh
   * that actually established a connection (or recovery definitively fails).
   */
  markRouteReady: boolean;
};

/**
 * Decide what a refresh does when it resolves no usable OpenWork server
 * URL/token.
 *
 * On desktop the local server owns that URL and mints fresh tokens on every
 * (re)start, so an empty resolution during boot, an app update, or a server
 * restart is a transient gap: boot or the local reconnect path will publish
 * new connection info and trigger another refresh. Clearing the *display*
 * state here is what used to drop the active session list and flash
 * disconnected UI mid-restart; the *connection* is still torn down for the
 * duration of the gap.
 *
 * On web there is no local process to wait for — an empty resolution is a
 * real disconnected state and the route should reflect it immediately.
 */
export function planRouteConnectionGap(input: { desktopRuntime: boolean }): RouteConnectionGapPlan {
  if (input.desktopRuntime) {
    return { retainExistingState: true, markRouteReady: false };
  }
  return { retainExistingState: false, markRouteReady: true };
}
