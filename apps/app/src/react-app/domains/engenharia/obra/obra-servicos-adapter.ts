// Domínio Engenharia — adapter de Serviços (FASE 21).
//
// Traduz os nós reais da EAP + o planejamento derivado para o contrato genérico
// `ServicosData` do domínio `servicos/`. Delega a renderização à capacidade
// reutilizável. Nenhuma fonte de verdade é criada aqui.
import type { ServicoItem, ServicosData } from "../../servicos/servicos-types";
import type { ObraEapNode } from "./obra-eap-types";
import type { ObraEapScopeRef } from "./obra-planejamento-data";
import {
  DATA_INICIO_DEFAULT,
  derivarPlanejamentoCompleto,
  diaParaDataIso,
} from "./obra-planejamento-data";

/** Constrói um ServicoItem a partir de uma linha de planejamento da obra. */
export function obraLinhaParaServicoItem(
  linha: ReturnType<typeof derivarPlanejamentoCompleto>[number],
  startDate: Date = DATA_INICIO_DEFAULT,
): ServicoItem {
  const temData = linha.duracao > 0;
  return {
    id: linha.node.wbs,
    codigo: linha.node.wbs,
    nome: linha.node.nome,
    duracao: linha.duracao,
    inicio: temData ? diaParaDataIso(linha.inicio, startDate) : null,
    fim: temData ? diaParaDataIso(linha.fim, startDate) : null,
    status: linha.critico,
  };
}

/** Produz o ServicosData da obra a partir dos nós reais da EAP. */
export function obraEapParaServicos(
  nodes: readonly ObraEapNode[],
  obraNome: string,
  escopo: Record<string, ObraEapScopeRef>,
  startDate: Date = DATA_INICIO_DEFAULT,
): ServicosData {
  const linhas = derivarPlanejamentoCompleto(nodes, escopo, startDate);
  const items = linhas
    .filter((l) => l.node.tipo === "TRABALHO")
    .map((l) => obraLinhaParaServicoItem(l, startDate));
  return {
    title: "Serviços",
    subtitle: `${obraNome} · ${items.length} trabalhos (nível 3) da EAP com duração, datas e caminho crítico derivados do planejamento.`,
    items,
  };
}
