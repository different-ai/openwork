/**
 * Zustand store for session management primitives (pin, manual order, custom
 * group mirror + expanded state). Persisted to localStorage via
 * zustand/middleware/persist.
 *
 * Archive is server-side (OpenCode session.time.archived). Session groups are
 * synced server-side; this store keeps a local optimistic mirror plus UI-only
 * collapsed state. Components import it directly with selectors, avoiding
 * context/prop drilling.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SessionGroupDefinition = {
  id: string;
  label: string;
};

export type WorkspaceGroupState = {
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  collapsedGroupIds?: string[];
};

export type SessionGroupServerState = {
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
};

type SessionGroupSyncHandler = {
  createGroup: (workspaceId: string, group: SessionGroupDefinition) => Promise<SessionGroupServerState | null>;
  assignGroup: (workspaceId: string, sessionId: string, groupId: string | null) => Promise<SessionGroupServerState | null>;
  reorderGroups: (workspaceId: string, groupIds: string[]) => Promise<SessionGroupServerState | null>;
  removeGroup: (workspaceId: string, groupId: string) => Promise<SessionGroupServerState | null>;
};

type SessionGroupMutationSuccess = {
  version: number;
  state: SessionGroupServerState;
};

type SessionGroupDeferredServerSync = {
  version: number;
  state: SessionGroupServerState;
};

type SessionGroupSyncStatus = {
  nextMutationVersion: number;
  nextServerSyncVersion: number;
  pendingMutations: number;
  lastAppliedMutationVersion: number;
  latestMutationSuccess?: SessionGroupMutationSuccess;
  deferredServerSync?: SessionGroupDeferredServerSync;
};

type SessionManagementState = {
  pinnedIds: string[];
  orderByWorkspace: Record<string, string[]>;
  groupsByWorkspace: Record<string, WorkspaceGroupState>;
};

type SessionManagementActions = {
  togglePin: (sessionId: string) => void;
  reorderSessions: (workspaceId: string, sessionIds: string[]) => void;
  assignGroup: (workspaceId: string, sessionId: string, groupId: string | null) => void;
  createGroup: (workspaceId: string, label: string) => void;
  reorderGroups: (workspaceId: string, groupIds: string[]) => void;
  toggleGroupExpanded: (workspaceId: string, groupId: string) => void;
  replaceWorkspaceGroups: (workspaceId: string, state: SessionGroupServerState) => void;
  /** Remove a group definition. Sessions assigned to it become ungrouped. */
  removeGroup: (workspaceId: string, groupId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
};

type SessionManagementStore = SessionManagementState & SessionManagementActions;

const EMPTY_GROUP_STATE: WorkspaceGroupState = { groups: [], assignments: {} };

let sessionGroupSyncHandler: SessionGroupSyncHandler | null = null;
const sessionGroupSyncStatusByWorkspace: Record<string, SessionGroupSyncStatus> = {};

export function setSessionGroupSyncHandler(handler: SessionGroupSyncHandler | null): void {
  sessionGroupSyncHandler = handler;
}

function syncStatus(workspaceId: string): SessionGroupSyncStatus {
  sessionGroupSyncStatusByWorkspace[workspaceId] ??= {
    nextMutationVersion: 0,
    nextServerSyncVersion: 0,
    pendingMutations: 0,
    lastAppliedMutationVersion: 0,
  };
  return sessionGroupSyncStatusByWorkspace[workspaceId];
}

function beginSessionGroupMutation(workspaceId: string): number {
  const status = syncStatus(workspaceId);
  status.nextMutationVersion += 1;
  status.pendingMutations += 1;
  return status.nextMutationVersion;
}

export function beginSessionGroupServerSync(workspaceId: string): number {
  const status = syncStatus(workspaceId);
  status.nextServerSyncVersion += 1;
  return status.nextServerSyncVersion;
}

export function applySessionGroupServerState(
  workspaceId: string,
  state: SessionGroupServerState | null,
  version: number,
): void {
  if (!state) return;
  const status = syncStatus(workspaceId);
  if (version !== status.nextServerSyncVersion) return;
  if (status.pendingMutations > 0) {
    status.deferredServerSync = { version, state };
    return;
  }
  useSessionManagementStore.getState().replaceWorkspaceGroups(workspaceId, state);
}

function completeSessionGroupMutation(
  workspaceId: string,
  version: number,
  state: SessionGroupServerState | null,
): void {
  const status = syncStatus(workspaceId);
  status.pendingMutations = Math.max(0, status.pendingMutations - 1);
  if (state && version > (status.latestMutationSuccess?.version ?? 0)) {
    status.latestMutationSuccess = { version, state };
  }
  if (status.pendingMutations > 0) return;

  const success = status.latestMutationSuccess;
  if (success && success.version > status.lastAppliedMutationVersion) {
    status.lastAppliedMutationVersion = success.version;
    status.deferredServerSync = undefined;
    useSessionManagementStore.getState().replaceWorkspaceGroups(workspaceId, success.state);
    return;
  }

  const deferred = status.deferredServerSync;
  if (!deferred) return;
  status.deferredServerSync = undefined;
  useSessionManagementStore.getState().replaceWorkspaceGroups(workspaceId, deferred.state);
}

function reportSyncError(error: unknown): void {
  console.warn("[session-groups] server sync failed", error);
}

function syncServerState(request: Promise<SessionGroupServerState | null> | undefined, workspaceId: string): void {
  if (!request) return;
  const version = beginSessionGroupMutation(workspaceId);
  void request
    .then((state) => completeSessionGroupMutation(workspaceId, version, state))
    .catch((error) => {
      completeSessionGroupMutation(workspaceId, version, null);
      reportSyncError(error);
    });
}

export const useSessionManagementStore = create<SessionManagementStore>()(
  persist(
    (set) => ({
      pinnedIds: [],
      orderByWorkspace: {},
      groupsByWorkspace: {},

      togglePin: (sessionId) =>
        set((state) => {
          const idx = state.pinnedIds.indexOf(sessionId);
          return {
            pinnedIds:
              idx >= 0
                ? state.pinnedIds.filter((id) => id !== sessionId)
                : [...state.pinnedIds, sessionId],
          };
        }),

      reorderSessions: (workspaceId, sessionIds) =>
        set((state) => ({
          orderByWorkspace: { ...state.orderByWorkspace, [workspaceId]: sessionIds },
        })),

      assignGroup: (workspaceId, sessionId, groupId) => {
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const assignments = { ...ws.assignments };
          if (groupId && ws.groups.some((g) => g.id === groupId)) {
            assignments[sessionId] = groupId;
          } else {
            delete assignments[sessionId];
          }
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { ...ws, assignments },
            },
          };
        });
        syncServerState(
          sessionGroupSyncHandler?.assignGroup(workspaceId, sessionId, groupId),
          workspaceId,
        );
      },

      createGroup: (workspaceId, label) => {
        const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const group = { id, label };
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { ...ws, groups: [...ws.groups, group] },
            },
          };
        });
        syncServerState(sessionGroupSyncHandler?.createGroup(workspaceId, group), workspaceId);
      },

      reorderGroups: (workspaceId, groupIds) => {
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const byId = new Map(ws.groups.map((group) => [group.id, group]));
          const used = new Set<string>();
          const groups: SessionGroupDefinition[] = [];
          for (const id of groupIds) {
            const group = byId.get(id);
            if (!group || used.has(id)) continue;
            groups.push(group);
            used.add(id);
          }
          for (const group of ws.groups) {
            if (!used.has(group.id)) groups.push(group);
          }
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { ...ws, groups },
            },
          };
        });
        syncServerState(sessionGroupSyncHandler?.reorderGroups(workspaceId, groupIds), workspaceId);
      },

      toggleGroupExpanded: (workspaceId, groupId) =>
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const collapsed = new Set(ws.collapsedGroupIds ?? []);
          if (collapsed.has(groupId)) {
            collapsed.delete(groupId);
          } else {
            collapsed.add(groupId);
          }
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { ...ws, collapsedGroupIds: [...collapsed] },
            },
          };
        }),

      replaceWorkspaceGroups: (workspaceId, serverState) =>
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const knownGroupIds = new Set(serverState.groups.map((group) => group.id));
          const collapsedGroupIds = (ws.collapsedGroupIds ?? []).filter(
            (id) => id === "__openwork_ungrouped" || knownGroupIds.has(id),
          );
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: {
                groups: serverState.groups,
                assignments: serverState.assignments,
                collapsedGroupIds,
              },
            },
          };
        }),

      removeGroup: (workspaceId, groupId) => {
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const groups = ws.groups.filter((g) => g.id !== groupId);
          // Unassign sessions that belonged to the removed group.
          const assignments: Record<string, string> = {};
          for (const [sid, gid] of Object.entries(ws.assignments)) {
            if (gid !== groupId) assignments[sid] = gid;
          }
          const collapsedGroupIds = (ws.collapsedGroupIds ?? []).filter((id) => id !== groupId);
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { groups, assignments, collapsedGroupIds },
            },
          };
        });
        syncServerState(sessionGroupSyncHandler?.removeGroup(workspaceId, groupId), workspaceId);
      },

      forgetWorkspace: (workspaceId) =>
        set((state) => {
          const { [workspaceId]: _o, ...orderRest } = state.orderByWorkspace;
          const { [workspaceId]: _g, ...groupsRest } = state.groupsByWorkspace;
          return { orderByWorkspace: orderRest, groupsByWorkspace: groupsRest };
        }),
    }),
    {
      name: "openwork.react.sessionManagement",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// ---------------------------------------------------------------------------
// Selectors (keep render-stable references via shallow selectors)
// ---------------------------------------------------------------------------

const EMPTY_PINNED = new Set<string>();
const EMPTY_ORDER: string[] = [];

export function usePinnedSessionIds(): Set<string> {
  const ids = useSessionManagementStore((s) => s.pinnedIds);
  // Derive a Set; reference-stable when the array is the same object.
  // Consumers only need membership checks so Set is ideal.
  return ids.length ? new Set(ids) : EMPTY_PINNED;
}

export function useSessionOrder(workspaceId: string): string[] {
  return useSessionManagementStore((s) => s.orderByWorkspace[workspaceId] ?? EMPTY_ORDER);
}

export function useWorkspaceGroups(workspaceId: string): WorkspaceGroupState {
  return useSessionManagementStore((s) => s.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE);
}
