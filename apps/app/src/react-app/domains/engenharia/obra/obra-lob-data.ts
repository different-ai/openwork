// Domínio Engenharia — dados da grade Linha de Balanço (FASE 20.x).
//
// Deriva a grade tempo × serviço (como a aba LINHA DE BALANÇO (GRADE) da
// planilha nativa) a partir das linhas de planejamento. Tudo é DERIVADO dos
// nós reais + datas — nunca uma fonte independente.
import type { ObraEapNode } from "./obra-eap-types";
import {
  DATA_INICIO_OBRA,
  derivarPlanejamentoCompleto,
  diaParaDataIso,
  duracaoTotalDasLinhas,
} from "./obra-planejamento-data";
import type { ObraPlanejamentoLinha } from "./obra-planejamento-data";

/** Uma semana do eixo temporal (segunda a domingo). */
export type LobSemana = {
  /** Índice 0-based da semana. */
  index: number;
  /** Data ISO do início (segunda). */
  inicio: string;
  /** Data ISO do fim (domingo). */
  fim: string;
  /** Rótulo curto (ex.: "SEM 1"). */
  label: string;
};

/** Linha da grade LOB: serviço + semanas ativas. */
export type LobLinha = {
  node: ObraEapNode;
  duracao: number;
  critico: "CRÍTICO" | "Sequencial" | "—";
  /** Índices das semanas em que o serviço está ativo. */
  semanasAtivas: number[];
};

/** Gera as semanas (segunda a domingo) cobrindo a duração total da obra. */
export function gerarSemanas(duracaoTotal: number): LobSemana[] {
  const semanas: LobSemana[] = [];
  const cursor = new Date(DATA_INICIO_OBRA);
  let index = 0;
  while (index * 7 <= duracaoTotal) {
    const inicio = new Date(cursor);
    const fim = new Date(cursor);
    fim.setDate(fim.getDate() + 6);
    semanas.push({
      index,
      inicio: diaParaDataIso(index * 7),
      fim: diaParaDataIso(index * 7 + 6),
      label: `SEM ${index + 1}`,
    });
    cursor.setDate(cursor.getDate() + 7);
    index += 1;
  }
  return semanas;
}

/** Converte uma linha de planejamento em linha da grade (semanas ativas). */
export function linhaParaLobLinha(linha: ObraPlanejamentoLinha): LobLinha {
  const semanasAtivas: number[] = [];
  if (linha.duracao > 0) {
    const semanaInicio = Math.floor(linha.inicio / 7);
    const semanaFim = Math.floor((linha.fim - 1) / 7);
    for (let s = semanaInicio; s <= semanaFim; s += 1) semanasAtivas.push(s);
  }
  return {
    node: linha.node,
    duracao: linha.duracao,
    critico: linha.critico,
    semanasAtivas,
  };
}

/** Grade LOB completa: semanas + linhas (serviços com duração). */
export function derivarGradeLob(
  nodes: readonly ObraEapNode[],
): { semanas: LobSemana[]; linhas: LobLinha[] } {
  const linhas = derivarPlanejamentoCompleto(nodes);
  const duracaoTotal = duracaoTotalDasLinhas(linhas);
  const semanas = gerarSemanas(duracaoTotal);
  const linhasGrade = linhas
    .filter((l) => l.duracao > 0)
    .map(linhaParaLobLinha);
  return { semanas, linhas: linhasGrade };
}
