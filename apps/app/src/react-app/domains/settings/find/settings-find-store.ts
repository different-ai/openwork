import { create } from "zustand";

import { markFeatureUsed } from "@/app/lib/den";

type SettingsFindStore = {
  open: boolean;
  /** Changes each time find is asked for, to put the cursor back in the field. */
  focusNonce: number;
  openFind: () => void;
  closeFind: () => void;
};

/**
 * Whether find is showing on the open settings page. One store so the
 * shortcut, the header button and the command palette open the same thing.
 */
export const useSettingsFindStore = create<SettingsFindStore>((set) => ({
  open: false,
  focusNonce: 0,
  openFind: () => {
    markFeatureUsed("settingsFind");
    set((state) => ({ open: true, focusNonce: state.focusNonce + 1 }));
  },
  closeFind: () => set((state) => (state.open ? { open: false } : state)),
}));
