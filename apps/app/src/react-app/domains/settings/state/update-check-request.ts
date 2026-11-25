import { create } from "zustand";

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
