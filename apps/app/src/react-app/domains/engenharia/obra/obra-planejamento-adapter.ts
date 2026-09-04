// Domínio Engenharia — adapter do Planejamento (FASE 20.x).
//
// Traduz os 81 nós reais da EAP + as datas derivadas de planejamento para o
// contrato genérico `PlanningDashboardData` do domínio `planejamento/`.
// Substitui o dataset demonstrativo (PLANNING_DEMO_DATA) no módulo Planejamento
// da Obra, sem tocar na Dashboard (que permanece neutra / anti-hardcode).
import type { PlanningDashboardData, PlanningItem } from "../../planejamento/planning-types";
import type { ObraEapNode } from "./obra-eap-types";
import type { ObraEapScopeRef } from "./obra-planejamento-data";
import {
  DATA_INICIO_DEFAULT,
  derivarPlanejamentoCompleto,
  diaParaDataIso,
  duracaoTotalDasLinhas,
} from "./obra-planejamento-data";

/** Constrói um PlanningItem a partir de um nó da EAP (datas opcionais). */
export function eapNodeParaPlanningItem(
  node: ObraEapNode,
  inicioIso: string | null,
  fimIso: string | null,
): PlanningItem {
  return {
    id: node.wbs,
    parentId: node.pai,
    name: node.nome,
    // Planning usa 0 = raiz; EAP usa nivel 1 = raiz.
    level: node.nivel - 1,
    status: "planejado",
    progress: 0,
    start: inicioIso,
    end: fimIso,
  };
}

/**
 * Produz o PlanningDashboardData da Obra a partir dos nós reais da EAP.
 * Datas são derivadas deterministicamente (mesma lógica da planilha nativa),
 * a partir do escopo da obra (`escopo`) e da data de início (`startDate`;
 * fallback 05/01/2026).
 */
export function obraEapParaPlanningDashboard(
  nodes: readonly ObraEapNode[],
  obraNome: string,
  escopo: Record<string, ObraEapScopeRef>,
  startDate: Date = DATA_INICIO_DEFAULT,
): PlanningDashboardData {
  const linhas = derivarPlanejamentoCompleto(nodes, escopo, startDate);
  const duracaoTotal = duracaoTotalDasLinhas(linhas);
  const fimObraIso = diaParaDataIso(duracaoTotal, startDate);

  const items: PlanningItem[] = linhas.map((linha) => {
    const { node, duracao } = linha;
    const temData = node.tipo === "TRABALHO" && duracao > 0;
    return eapNodeParaPlanningItem(
      node,
      temData ? diaParaDataIso(linha.inicio, startDate) : null,
      temData ? diaParaDataIso(linha.fim, startDate) : null,
    );
  });

  return {
    context: {
      title: "Planejamento",
      subtitle: `${obraNome} · Cronograma derivado da EAP (${nodes.length} nós)`,
      referenceDate: diaParaDataIso(0, startDate),
    },
    items,
  };
}
