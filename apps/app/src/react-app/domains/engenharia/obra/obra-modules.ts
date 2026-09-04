// Catálogo declarativo de módulos da Obra (FASE 22).
//
// Este arquivo representa APENAS a DECLARAÇÃO/CAPACIDADE de cada módulo:
// id, label, fase, ordem, opcionalidade e descrição. NÃO contém componentes
// React, roteamento, estado, regras de negócio nem dados — a resolução da
// tela/renderização fica na camada apropriada (obra-shell-route.tsx).
//
// Objetivo (decisão FASE 22): adicionar um módulo novo = adicionar uma entrada
// aqui + o render no shell. Sem alterar 3+ arquivos estruturais e sem criar um
// "plugin system" complexo.
import type { ObraFase, ObraModule } from "./obra-types";

export type ObraModuleDef = {
  /** Identificador estável do módulo (mesmo valor do tipo ObraModule). */
  id: ObraModule;
  /** Rótulo exibido na navegação. */
  label: string;
  /** Fase do ciclo de vida à qual o módulo pertence. */
  fase: ObraFase;
  /** Ordem de exibição dentro da fase (ordem = fluxo real). */
  ordem: number;
  /** Módulo opcional (não padrão). Quando ausente, é módulo padrão. */
  opcional?: boolean;
  /** Descrição curta (metadado para catálogo/help). */
  descricao?: string;
};

/**
 * Catálogo declarativo dos módulos da Obra — FONTE ÚNICA de metadados.
 * A ordem de exibição é derivada de (fase, ordem).
 */
export const OBRA_MODULES: ObraModuleDef[] = [
  // ---- Preparação ----
  { id: "visao-geral", label: "Visão Geral", fase: "preparacao", ordem: 1, descricao: "Dashboard executiva da obra." },
  { id: "caracterizacao", label: "Caracterização", fase: "preparacao", ordem: 2, descricao: "Informações estruturais da obra." },
  { id: "eap", label: "EAP", fase: "preparacao", ordem: 3, descricao: "Estrutura Analítica do Projeto (81 nós)." },
  { id: "disciplinas", label: "Disciplinas", fase: "preparacao", ordem: 4, descricao: "Disciplinas (nível 1) da EAP." },
  { id: "servicos", label: "Serviços", fase: "preparacao", ordem: 5, descricao: "Serviços derivados da EAP." },
  { id: "planejamento", label: "Planejamento", fase: "preparacao", ordem: 6, descricao: "Cronograma derivado da EAP." },
  { id: "linha-de-balanco", label: "Linha de Balanço", fase: "preparacao", ordem: 7, descricao: "Grade LOB derivada do planejamento." },
  // ---- Execução ----
  { id: "frentes", label: "Frentes de Serviço", fase: "execucao", ordem: 1, descricao: "Frentes derivadas das disciplinas raiz." },
  { id: "producao", label: "Produção", fase: "execucao", ordem: 2, descricao: "Acompanhamento planejado × realizado." },
  { id: "rdo", label: "RDO", fase: "execucao", ordem: 3, descricao: "Registro Diário de Obra (fase futura)." },
  // ---- Suporte ----
  { id: "ia", label: "IA", fase: "suporte", ordem: 1, descricao: "Assistência de IA da obra (fase futura)." },
];

/** Módulos ordenados por (fase, ordem) — ordem de exibição nas abas. */
export function listModulesByFase(fase: ObraFase): ObraModuleDef[] {
  return OBRA_MODULES.filter((m) => m.fase === fase).sort((a, b) => a.ordem - b.ordem);
}

/** Todas as fases na ordem canônica (Preparação, Execução, Suporte). */
export const OBRA_FASES_ORDER: ObraFase[] = ["preparacao", "execucao", "suporte"];

/** Rótulo de um módulo a partir do catálogo (fallback para o id). */
export function moduleLabel(id: ObraModule): string {
  return OBRA_MODULES.find((m) => m.id === id)?.label ?? id;
}

/** Fase de um módulo a partir do catálogo (fallback: preparação). */
export function moduleFase(id: ObraModule): ObraFase {
  return OBRA_MODULES.find((m) => m.id === id)?.fase ?? "preparacao";
}
