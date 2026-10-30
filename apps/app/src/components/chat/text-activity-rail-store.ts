import { create } from "zustand"

/**
 * Whether the chat's activity rail renders text-first (flag
 * `textActivityRail`). Set once from the organization's features by
 * `useTextActivityRailFeature`; every rail row reads it, so turning the
 * feature off returns the previous rail without a reload.
 */
type TextActivityRailState = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useTextActivityRailStore = create<TextActivityRailState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set((state) => state.enabled === enabled ? state : { enabled }),
}))

export function useTextActivityRail(): boolean {
  return useTextActivityRailStore((state) => state.enabled)
}
