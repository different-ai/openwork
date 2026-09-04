// Repositório de Obras do domínio Engenharia (FASE 04.2-B) — FONTE ÚNICA.
// Arquitetura: UI → repository → storage. A UI nunca toca em localStorage.
// A navegação (obra-navigation) e as páginas consomem esta mesma fonte.
import { create } from "zustand";

import type { CreateObraInput, Obra, ObraStatus } from "./obra-types";
import {
  clearObrasStorage,
  loadObrasFromStorage,
  saveObrasToStorage,
} from "./obra-storage";

/**
 * Status efetivo de uma obra (FASE 22).
 * `ARQUIVADA` é DERIVADO de `Obra.arquivada` (soft-delete) — nunca persistido
 * separadamente, evitando segunda fonte de verdade.
 */
export function statusEfetivo(obra: Pick<Obra, "status" | "arquivada">): ObraStatus {
  return obra.arquivada ? "ARQUIVADA" : obra.status;
}

// ------------------------------------------------------------------ //
// Seeds (FASE 04.2-B): a obra demonstrativa é PRESERVADA para não quebrar
// módulos/rotas existentes; duas obras neutras adicionais ilustram a lista.
// ------------------------------------------------------------------ //

/** ID da obra demonstrativa original (compatibilidade com rotas/módulos/EAP). */
export const OBRA_MODELO_ID = "OBRA-MODELO-EAP-001";

export const OBRA_MODELO: Obra = {
  id: OBRA_MODELO_ID,
  nome: OBRA_MODELO_ID,
  status: "PROPOSTA",
  caracterizacao: {
    torres: 1,
    lajes: 14,
    apartamentosPorPavimento: 1,
    subsolos: 0,
    sistemaConstrutivo: "concreto armado",
  },
  eap: {
    status: "PROPOSTA",
    total: 81,
    raizes: 10,
    pacotes: 24,
    trabalhos: 47,
  },
};

const OBRA_DEMO_01: Obra = {
  id: "OBRA-DEMO-001",
  nome: "Obra Demonstrativa 01",
  status: "PROPOSTA",
};

const OBRA_DEMO_02: Obra = {
  id: "OBRA-DEMO-002",
  nome: "Obra Demonstrativa 02",
  status: "PROPOSTA",
};

export const SEED_OBRAS: Obra[] = [OBRA_MODELO, OBRA_DEMO_01, OBRA_DEMO_02];

// ------------------------------------------------------------------ //
// Geração de ID estável
// ------------------------------------------------------------------ //

const OBRA_ID_PREFIX = "OBRA-";

/** Gera um ID estável e único (não depende do nome nem de índice do array). */
export function createObraId(existing: ReadonlySet<string> = new Set()): string {
  let id = "";
  do {
    const time = Date.now().toString(36);
    const random =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 6)
        : Math.random().toString(36).slice(2, 8);
    id = `${OBRA_ID_PREFIX}${(time + random).toUpperCase()}`;
  } while (existing.has(id));
  return id;
}

// ------------------------------------------------------------------ //
// Store (Zustand) — estado + ações; persistência encapsulada no repository
// ------------------------------------------------------------------ //

type ObraRepositoryState = {
  obras: Obra[];
  createObra: (input: CreateObraInput) => Obra;
  /** Atualiza campos de identificação/status/datas/localização/responsável. */
  updateObra: (id: string, patch: Partial<Obra>) => void;
  /** Soft-delete: marca a obra como arquivada (não aparece na lista ativa). */
  archiveObra: (id: string) => void;
  /** Restaura uma obra arquivada. */
  unarchiveObra: (id: string) => void;
  /** Exclusão definitiva (sempre precedida de confirmação em duas etapas na UI). */
  deleteObra: (id: string) => void;
  /** Reset explícito (testes). */
  resetObras: (obras: Obra[]) => void;
};

export const useObraRepository = create<ObraRepositoryState>((set, get) => ({
  obras: SEED_OBRAS,
  createObra: (input) => {
    const nome = (input.nome ?? "").trim();
    const existingIds = new Set(get().obras.map((obra) => obra.id));
    const obra: Obra = {
      id: createObraId(existingIds),
      nome,
      status: input.status ?? "PROPOSTA",
      dataInicio: input.dataInicio ?? null,
      dataFim: input.dataFim ?? null,
      localizacao: input.localizacao ?? null,
      responsavel: input.responsavel ?? null,
    };
    set((state) => ({ obras: [obra, ...state.obras] }));
    saveObrasToStorage(get().obras);
    return obra;
  },
  updateObra: (id, patch) => {
    set((state) => ({
      obras: state.obras.map((obra) =>
        obra.id === id ? { ...obra, ...patch, id: obra.id } : obra,
      ),
    }));
    saveObrasToStorage(get().obras);
  },
  archiveObra: (id) => {
    set((state) => ({
      obras: state.obras.map((obra) =>
        obra.id === id ? { ...obra, arquivada: true } : obra,
      ),
    }));
    saveObrasToStorage(get().obras);
  },
  unarchiveObra: (id) => {
    set((state) => ({
      obras: state.obras.map((obra) =>
        obra.id === id ? { ...obra, arquivada: false } : obra,
      ),
    }));
    saveObrasToStorage(get().obras);
  },
  deleteObra: (id) => {
    set((state) => ({ obras: state.obras.filter((obra) => obra.id !== id) }));
    saveObrasToStorage(get().obras);
  },
  resetObras: (obras) => {
    set({ obras });
    saveObrasToStorage(obras);
  },
}));

// ------------------------------------------------------------------ //
// Helpers não-reativos (para módulos que leem uma vez: domain/navigation)
// ------------------------------------------------------------------ //

export function listObras(): Obra[] {
  return useObraRepository.getState().obras;
}

export function findObraById(id: string): Obra | undefined {
  return listObras().find((obra) => obra.id === id);
}

/** Obras ativas (não arquivadas) — usadas na lista padrão da Central de Obras. */
export function listObrasAtivas(): Obra[] {
  return listObras().filter((obra) => !obra.arquivada);
}

/** Obras arquivadas (soft-delete) — visíveis apenas na visão "arquivadas". */
export function listObrasArquivadas(): Obra[] {
  return listObras().filter((obra) => obra.arquivada);
}

/** Alias de compatibilidade mantido para consumidores existentes. */
export function findObraModelo(id: string): Obra | undefined {
  return findObraById(id);
}

/** Hidrata o repositório a partir do armazenamento local (inicialização). */
export function initializeObraRepository(): void {
  const stored = loadObrasFromStorage();
  if (stored) useObraRepository.setState({ obras: stored });
}

/** Remove a persistência e restaura os seeds (testes). */
export function resetObraRepository(): void {
  clearObrasStorage();
  useObraRepository.setState({ obras: SEED_OBRAS });
}
