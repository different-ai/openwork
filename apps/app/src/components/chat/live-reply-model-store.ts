import { create } from "zustand"

/**
 * Whether a reply that is still streaming shows its model on hover (feature
 * `liveReplyModel`). Set once per session route by `useLiveReplyModelFeature`;
 * chat lists outside a signed-in session (read-only previews) leave it off.
 */
type LiveReplyModelState = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useLiveReplyModelStore = create<LiveReplyModelState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}))

export function useLiveReplyModel(): boolean {
  return useLiveReplyModelStore((state) => state.enabled)
}
