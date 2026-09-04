// Domínio Engenharia — adapter da grade Linha de Balanço (FASE 20.x / FASE 21).
//
// FASE 21: a capacidade genérica de LOB foi extraída para domains/linha-de-balanco.
// Este arquivo agora é um ADAPTER que traduz os nós reais da EAP + o planejamento
// derivado para o contrato genérico `LobGradeData`, delegando a derivação à
// capacidade reutilizável. Nenhuma fonte de verdade é criada aqui.
import type { LobAtividade, LobGradeData, LobSemana } from "../../linha-de-balanco/lob-types";
import {
  atividadeParaLobLinha as lobAtividadeParaLobLinha,
  derivarGradeLob as lobDerivarGradeLob,
  gerarSemanas as lobGerarSemanas,
} from "../../linha-de-balanco/lob-data";
import type { ObraEapNode } from "./obra-eap-types";
import type { ObraEapScopeRef } from "./obra-planejamento-data";
import {
  DATA_INICIO_DEFAULT,
  derivarPlanejamentoCompleto,
  duracaoTotalDasLinhas,
} from "./obra-planejamento-data";
import type { ObraPlanejamentoLinha } from "./obra-planejamento-data";

/** Data de início da obra em ISO (base do eixo temporal da LOB). */
export const DATA_INICIO_OBRA_ISO = DATA_INICIO_DEFAULT.toISOString().slice(0, 10);

/** Linha da grade LOB (re-export do contrato genérico). */
export type LobLinha = import("../../linha-de-balanco/lob-types").LobLinha;

/** Formata uma Date como ISO local (yyyy-mm-dd), consistente com diaParaDataIso. */
function dataParaIsoLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Gera as semanas (segunda a domingo) cobrindo a duração total da obra. */
export function gerarSemanas(
  duracaoTotal: number,
  startDate: Date = DATA_INICIO_DEFAULT,
): LobSemana[] {
  return lobGerarSemanas(dataParaIsoLocal(startDate), duracaoTotal);
}

/** Converte uma linha de planejamento da obra em linha da grade LOB. */
export function linhaParaLobLinha(linha: ObraPlanejamentoLinha): LobLinha {
  return lobAtividadeParaLobLinha({
    id: linha.node.wbs,
    nome: linha.node.nome,
    codigo: linha.node.wbs,
    inicio: linha.inicio,
    fim: linha.fim,
    duracao: linha.duracao,
    critico: linha.critico,
  });
}

/** Converte as linhas de planejamento da obra em atividades genéricas de LOB. */
function linhasParaAtividades(
  linhas: readonly ObraPlanejamentoLinha[],
): LobAtividade[] {
  return linhas.map((linha) => ({
    id: linha.node.wbs,
    nome: linha.node.nome,
    codigo: linha.node.wbs,
    inicio: linha.inicio,
    fim: linha.fim,
    duracao: linha.duracao,
    critico: linha.critico,
  }));
}

/** Grade LOB completa da obra: semanas + linhas (serviços com duração). */
export function derivarGradeLob(
  nodes: readonly ObraEapNode[],
  escopo: Record<string, ObraEapScopeRef>,
  startDate: Date = DATA_INICIO_DEFAULT,
): LobGradeData {
  const linhas = derivarPlanejamentoCompleto(nodes, escopo, startDate);
  const duracaoTotal = duracaoTotalDasLinhas(linhas);
  const semanas = gerarSemanas(duracaoTotal, startDate);
  const atividades = linhasParaAtividades(linhas);
  const grade = lobDerivarGradeLob(atividades, dataParaIsoLocal(startDate));
  return { semanas, linhas: grade.linhas };
}
