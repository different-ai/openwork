import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceAvatarPreference = {
  color?: string | null;
  imageUrl?: string | null;
};

type WorkspaceAvatarStore = {
  byWorkspaceId: Record<string, WorkspaceAvatarPreference>;
  setColor: (workspaceId: string, color: string | null) => void;
  setImageUrl: (workspaceId: string, imageUrl: string | null) => void;
  clear: (workspaceId: string) => void;
};

function upsert(
  state: WorkspaceAvatarStore,
  workspaceId: string,
  patch: WorkspaceAvatarPreference,
): Record<string, WorkspaceAvatarPreference> {
  const current = state.byWorkspaceId[workspaceId] ?? {};
  const next: WorkspaceAvatarPreference = { ...current, ...patch };
  if (!next.color && !next.imageUrl) {
    const { [workspaceId]: _removed, ...rest } = state.byWorkspaceId;
    return rest;
  }
  return { ...state.byWorkspaceId, [workspaceId]: next };
}

export const useWorkspaceAvatarStore = create<WorkspaceAvatarStore>()(
  persist(
    (set) => ({
      byWorkspaceId: {},
      setColor: (workspaceId, color) =>
        set((state) => ({
          byWorkspaceId: upsert(state, workspaceId, { color }),
        })),
      setImageUrl: (workspaceId, imageUrl) =>
        set((state) => ({
          byWorkspaceId: upsert(state, workspaceId, { imageUrl }),
        })),
      clear: (workspaceId) =>
        set((state) => {
          const { [workspaceId]: _removed, ...rest } = state.byWorkspaceId;
          return { byWorkspaceId: rest };
        }),
    }),
    {
      name: "openwork.workspaceAvatars.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function useWorkspaceAvatarPreference(workspaceId: string) {
  return useWorkspaceAvatarStore((state) => state.byWorkspaceId[workspaceId] ?? null);
}
