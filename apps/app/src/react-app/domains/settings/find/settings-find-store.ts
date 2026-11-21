import { create } from "zustand";

type SettingsFindStore = {
  open: boolean;
  focusNonce: number;
  openFind: () => void;
  closeFind: () => void;
};

export const useSettingsFindStore = create<SettingsFindStore>((set) => ({
  open: false,
  focusNonce: 0,
  openFind: () => {
    set((state) => ({ open: true, focusNonce: state.focusNonce + 1 }));
  },
  closeFind: () => set((state) => (state.open ? { open: false } : state)),
}));
