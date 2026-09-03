// Estado de navegação hierárquica (Core) — Zustand + persist localStorage.
// Guarda APENAS o estado de expansão/recolhimento por id de nó.
// A seleção e o contexto são derivados da rota (useLocation), não duplicados aqui.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type NavigationState = {
  expandedNodeIds: string[];
  toggleNode: (id: string) => void;
  expandNode: (id: string) => void;
  collapseNode: (id: string) => void;
};

export const useNavigationState = create<NavigationState>()(
  persist(
    (set) => ({
      expandedNodeIds: [],
      toggleNode: (id) =>
        set((state) => ({
          expandedNodeIds: state.expandedNodeIds.includes(id)
            ? state.expandedNodeIds.filter((n) => n !== id)
            : [...state.expandedNodeIds, id],
        })),
      expandNode: (id) =>
        set((state) =>
          state.expandedNodeIds.includes(id)
            ? state
            : { expandedNodeIds: [...state.expandedNodeIds, id] },
        ),
      collapseNode: (id) =>
        set((state) => ({
          expandedNodeIds: state.expandedNodeIds.filter((n) => n !== id),
        })),
    }),
    {
      name: "openwork-navigation-state",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** True se o nó está expandido. Nós ancestrais do caminho ativo abrem por padrão
 *  (expandidos se ainda não foram tocados — ver isNodeExpanded em sidebar-navigation). */
export function isNodeExpanded(state: NavigationState, id: string): boolean {
  return state.expandedNodeIds.includes(id);
}
