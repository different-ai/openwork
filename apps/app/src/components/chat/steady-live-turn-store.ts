import { create } from "zustand"

/**
 * `steadyLiveTurn` (feature registry): a running reply keeps its parts in the
 * order they arrive and the chat reserves room at its end instead of holding
 * the steps area open. The session page mirrors the flag here so the chat
 * components read it without fetching features themselves.
 */
export const useSteadyLiveTurnStore = create<{
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}>((set) => ({
  enabled: false,
  setEnabled: enabled => set(state => state.enabled === enabled ? state : { enabled }),
}))
