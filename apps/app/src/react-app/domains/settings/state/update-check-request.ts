import { create } from "zustand";

/**
 * Bridges the native "Check for Updates..." menu item to the settings
 * updater state. The menu handler navigates to /settings/updates and
 * records a request here; `useElectronUpdaterState` consumes it once
 * mounted, so the check runs regardless of mount ordering.
 */
type UpdateCheckRequestStore = {
  requestedAt: number | null;
  requestUpdateCheck: () => void;
  clearUpdateCheckRequest: () => void;
};

export const useUpdateCheckRequestStore = create<UpdateCheckRequestStore>((set) => ({
  requestedAt: null,
  requestUpdateCheck: () => set({ requestedAt: Date.now() }),
  clearUpdateCheckRequest: () => set({ requestedAt: null }),
}));
