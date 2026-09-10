import { create } from "zustand";
import { MAX_SESSIONS_PREVIEW } from "./utils";

const MAX_PREVIEW_ENTRIES = 256;
const EMPTY_COUNTS: Record<string, number> = {};

// App-session only: no titles, transcript data, or persistent storage. Changing
// the verified account/organization scope discards the previous owner's depth.
export const useSidebarPreviewStore = create<{
  scope: string | null;
  counts: Record<string, number>;
  showMore: (scope: string | null, workspaceId: string, total: number, groupId?: string) => void;
}>((set) => ({
  scope: null,
  counts: {},
  showMore: (scope, workspaceId, total, groupId) => set((state) => {
    const key = JSON.stringify([workspaceId, groupId ?? null]);
    const counts = { ...(state.scope === scope ? state.counts : EMPTY_COUNTS) };
    const count = counts[key] ?? MAX_SESSIONS_PREVIEW;
    delete counts[key];
    counts[key] = Math.min(count + MAX_SESSIONS_PREVIEW, total);
    const keys = Object.keys(counts);
    for (const expired of keys.slice(0, Math.max(0, keys.length - MAX_PREVIEW_ENTRIES))) delete counts[expired];
    return { scope, counts };
  }),
}));

export function useSidebarPreviewCounts(scope: string | null) {
  return useSidebarPreviewStore((state) => state.scope === scope ? state.counts : EMPTY_COUNTS);
}

export function sidebarPreviewCount(counts: Record<string, number>, workspaceId: string, groupId?: string) {
  return counts[JSON.stringify([workspaceId, groupId ?? null])] ?? MAX_SESSIONS_PREVIEW;
}
