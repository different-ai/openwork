import { create } from "zustand"

export const useComputerSessionHistoryStore = create<{
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}>((set) => ({
  enabled: false,
  setEnabled: enabled => set(state => state.enabled === enabled ? state : { enabled }),
}))
