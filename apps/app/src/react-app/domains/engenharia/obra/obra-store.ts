// Domínio Engenharia — estado de UI da Obra (Zustand, persist localStorage).
// FASE 04.2-B: o módulo selecionado passa a ser ESCOPO POR OBRA (obraId) para
// evitar vazamento de estado entre obras. A obra aberta continua vinda da URL
// (obraId), nunca deste store.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ObraModule } from "./obra-types";

type ObraStoreState = {
  /** Módulo selecionado por obraId (lembrança de UI; não decide a rota). */
  selectedModules: Record<string, ObraModule | null>;
  selectModule: (obraId: string, module: ObraModule | null) => void;
  /** Obra atualmente aberta (contexto da obra ativa; não decide a rota). */
  activeObraId: string | null;
  setActiveObra: (obraId: string | null) => void;
};

export const useObraStore = create<ObraStoreState>()(
  persist(
    (set) => ({
      selectedModules: {},
      selectModule: (obraId, module) =>
        set((state) => ({
          selectedModules: {
            ...state.selectedModules,
            [obraId]: module,
          },
        })),
      activeObraId: null,
      setActiveObra: (obraId) => set({ activeObraId: obraId }),
    }),
    {
      name: "openwork-obra-store",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

