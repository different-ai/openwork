/**
 * Zustand store for session management primitives (pin, manual order, custom
 * groups). Persisted to localStorage via zustand/middleware/persist.
 *
 * Archive is server-side (OpenCode session.time.archived); this store is
 * purely client-side view state. Components import it directly with selectors,
 * avoiding context/prop drilling.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SessionGroupDefinition = {
  id: string;
  label: string;
};

type WorkspaceGroupState = {
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  collapsedGroupIds?: string[];
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
  /** Remove a group definition. Sessions assigned to it become ungrouped. */
  removeGroup: (workspaceId: string, groupId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
};

type SessionManagementStore = SessionManagementState & SessionManagementActions;

const EMPTY_GROUP_STATE: WorkspaceGroupState = { groups: [], assignments: {} };

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

      assignGroup: (workspaceId, sessionId, groupId) =>
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
        }),

      createGroup: (workspaceId, label) =>
        set((state) => {
          const ws = state.groupsByWorkspace[workspaceId] ?? EMPTY_GROUP_STATE;
          const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          return {
            groupsByWorkspace: {
              ...state.groupsByWorkspace,
              [workspaceId]: { ...ws, groups: [...ws.groups, { id, label }] },
            },
          };
        }),

      reorderGroups: (workspaceId, groupIds) =>
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
        }),

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

      removeGroup: (workspaceId, groupId) =>
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
        }),

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
