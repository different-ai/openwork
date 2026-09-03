// Domínio Engenharia — repositório da EAP (FASE 06.2-B).
// Arquitetura: UI → repository → storage. A UI nunca toca em localStorage.
// A EAP pertence à Obra e é persistida por obraId (identidade obraId + wbs).
//
// Fonte única: os nós reais da Obra Modelo EAP vivem aqui (obra-eap-data.ts),
// hidratados no store. O resumo (ObraEapSummary) é SEMPRE derivado dos nós via
// deriveEapSummary — nunca uma fonte independente de números.
import { create } from "zustand";

import { OBRA_MODELO_EAP, OBRA_MODELO_EAP_ID } from "./obra-eap-data";
import type { ObraEap, ObraEapNode, ObraEapSummary } from "./obra-eap-types";
import type { EapRow } from "./obra-eap-tree";
import {
  clearEapStorage,
  loadEapFromStorage,
  saveEapToStorage,
} from "./obra-eap-storage";

// ------------------------------------------------------------------ //
// Helpers puros (derivação e validação) — testáveis sem DOM
// ------------------------------------------------------------------ //

/** Deriva o resumo estrutural a partir dos nós reais. */
export function deriveEapSummary(nodes: readonly ObraEapNode[]): ObraEapSummary {
  let raizes = 0;
  let pacotes = 0;
  let trabalhos = 0;
  for (const node of nodes) {
    if (node.nivel === 1) raizes += 1;
    else if (node.nivel === 2) pacotes += 1;
    else if (node.nivel === 3) trabalhos += 1;
  }
  return {
    status: "PROPOSTA",
    total: nodes.length,
    raizes,
    pacotes,
    trabalhos,
  };
}

/** Conta as folhas (nós sem filhos) da EAP. */
export function countEapLeaves(nodes: readonly ObraEapNode[]): number {
  const hasChildren = new Set<string>();
  for (const node of nodes) {
    if (node.pai) hasChildren.add(node.pai);
  }
  return nodes.filter((node) => !hasChildren.has(node.wbs)).length;
}

/** Mapa pai -> filhos na ordem declarada (ordem entre irmãos preservada). */
export function buildEapChildrenIndex(
  nodes: readonly ObraEapNode[],
): Map<string, ObraEapNode[]> {
  const byParent = new Map<string, ObraEapNode[]>();
  for (const node of nodes) {
    const key = node.pai ?? "";
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  return byParent;
}

/** WBS dos nós raiz (sem pai). */
export function eapRootWbs(nodes: readonly ObraEapNode[]): string[] {
  return nodes.filter((node) => !node.pai).map((node) => node.wbs);
}

/**
 * Linhas visíveis em ordem de árvore (DFS, pré-order) respeitando o conjunto de
 * nós recolhidos. A ordem entre irmãos é a ordem declarada (ordem da fonte).
 */
export function deriveEapRows(
  nodes: readonly ObraEapNode[],
  collapsedWbs: ReadonlySet<string>,
): EapRow[] {
  const byWbs = new Map(nodes.map((node) => [node.wbs, node]));
  const children = buildEapChildrenIndex(nodes);
  const rows: EapRow[] = [];

  const visit = (wbs: string) => {
    const node = byWbs.get(wbs);
    if (!node) return;
    const kids = children.get(wbs) ?? [];
    const expanded = !collapsedWbs.has(wbs);
    rows.push({
      node,
      depth: node.nivel - 1,
      hasChildren: kids.length > 0,
      expanded,
    });
    if (kids.length > 0 && expanded) {
      for (const kid of kids) visit(kid.wbs);
    }
  };

  for (const rootWbs of eapRootWbs(nodes)) visit(rootWbs);
  return rows;
}

export type EapValidation = {
  ok: boolean;
  total: number;
  wbsDuplicados: string[];
  paisInexistentes: string[];
  raizesComPai: string[];
  ciclos: string[];
  foraDaObra: string[];
};

/** Valida a integridade estrutural da EAP (espelha o verificador oficial). */
export function validateEap(nodes: readonly ObraEapNode[]): EapValidation {
  const byWbs = new Map<string, ObraEapNode>();
  const wbsDuplicados: string[] = [];
  for (const node of nodes) {
    if (byWbs.has(node.wbs)) wbsDuplicados.push(node.wbs);
    else byWbs.set(node.wbs, node);
  }

  const paisInexistentes: string[] = [];
  const raizesComPai: string[] = [];
  for (const node of nodes) {
    if (node.pai) {
      if (!byWbs.has(node.pai)) paisInexistentes.push(node.wbs);
    } else if (node.nivel !== 1) {
      raizesComPai.push(node.wbs);
    }
  }

  // Detecção de ciclo: percorre a cadeia de pais com limite de profundidade.
  const ciclos: string[] = [];
  for (const node of nodes) {
    const visitados = new Set<string>();
    let atual: ObraEapNode | undefined = node;
    while (atual && atual.pai) {
      if (visitados.has(atual.wbs)) {
        ciclos.push(node.wbs);
        break;
      }
      visitados.add(atual.wbs);
      atual = byWbs.get(atual.pai);
    }
  }

  const foraDaObra = nodes
    .filter((node) => node.obraId !== OBRA_MODELO_EAP_ID)
    .map((node) => node.wbs);

  return {
    ok:
      wbsDuplicados.length === 0 &&
      paisInexistentes.length === 0 &&
      raizesComPai.length === 0 &&
      ciclos.length === 0 &&
      foraDaObra.length === 0,
    total: nodes.length,
    wbsDuplicados,
    paisInexistentes,
    raizesComPai,
    ciclos,
    foraDaObra,
  };
}

// ------------------------------------------------------------------ //
// Store (Zustand) — EAP por obraId
// ------------------------------------------------------------------ //

type ObraEapRepositoryState = {
  /** EAPs por obraId (fonte única operacional). */
  eaps: Record<string, ObraEap>;
  /** Registra/substitui a EAP de uma obra (idempotente por obraId). */
  setEap: (eap: ObraEap) => void;
  /** Reset explícito (testes). */
  resetEaps: (eaps: Record<string, ObraEap>) => void;
};

const SEED_EAPS: Record<string, ObraEap> = {
  [OBRA_MODELO_EAP_ID]: OBRA_MODELO_EAP,
};

export const useObraEapRepository = create<ObraEapRepositoryState>((set, get) => ({
  eaps: SEED_EAPS,
  setEap: (eap) => {
    set((state) => ({ eaps: { ...state.eaps, [eap.obraId]: eap } }));
    saveEapToStorage(get().eaps);
  },
  resetEaps: (eaps) => {
    set({ eaps });
    saveEapToStorage(eaps);
  },
}));

// ------------------------------------------------------------------ //
// Helpers não-reativos
// ------------------------------------------------------------------ //

/** Retorna a EAP completa de uma obra (ou undefined se não existir). */
export function getEapForObra(obraId: string): ObraEap | undefined {
  return useObraEapRepository.getState().eaps[obraId];
}

/** Retorna os nós da EAP de uma obra (ou [] se não existir). */
export function getEapNodesForObra(obraId: string): ObraEapNode[] {
  return getEapForObra(obraId)?.nodes ?? [];
}

/** Resumo derivado dos nós reais da obra. */
export function getEapSummaryForObra(obraId: string): ObraEapSummary | null {
  const nodes = getEapNodesForObra(obraId);
  return nodes.length > 0 ? deriveEapSummary(nodes) : null;
}

/** Hidrata o repositório a partir do armazenamento local (inicialização). */
export function initializeObraEapRepository(): void {
  const stored = loadEapFromStorage();
  if (stored) useObraEapRepository.setState({ eaps: stored });
}

/** Remove a persistência e restaura os seeds (testes). */
export function resetObraEapRepository(): void {
  clearEapStorage();
  useObraEapRepository.setState({ eaps: SEED_EAPS });
}
