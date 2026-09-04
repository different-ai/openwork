// Helpers puros da capacidade de Linha de Balanço (LOB) — sem DOM, testáveis.
// Tudo aqui é DERIVADO dos dados fornecidos pelo adapter; nada é inventado.
// FASE 21: capacidade genérica extraída para um domínio reutilizável.
import type { LobAtividade, LobGradeData, LobLinha, LobSemana } from "./lob-types";

const DAY_MS = 86_400_000;

/** Converte "yyyy-mm-dd" em Date (timezone local). Retorna null se inválido. */
export function parseIsoDate(value?: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Gera as semanas (segunda a domingo) cobrindo a duração total, a partir de uma
 * data de início ISO. A primeira semana começa na data de início.
 */
export function gerarSemanas(inicioIso: string, duracaoTotal: number): LobSemana[] {
  const inicio = parseIsoDate(inicioIso);
  if (!inicio || duracaoTotal < 0) return [];
  const semanas: LobSemana[] = [];
  let index = 0;
  while (index * 7 <= duracaoTotal) {
    const cursor = new Date(inicio);
    cursor.setDate(cursor.getDate() + index * 7);
    const fim = new Date(cursor);
    fim.setDate(fim.getDate() + 6);
    semanas.push({
      index,
      inicio: toIso(cursor),
      fim: toIso(fim),
      label: `SEM ${index + 1}`,
    });
    index += 1;
  }
  return semanas;
}

/** Converte uma atividade genérica em linha da grade (semanas ativas). */
export function atividadeParaLobLinha(atividade: LobAtividade): LobLinha {
  const semanasAtivas: number[] = [];
  if (atividade.duracao > 0) {
    const semanaInicio = Math.floor(atividade.inicio / 7);
    const semanaFim = Math.floor((atividade.fim - 1) / 7);
    for (let s = semanaInicio; s <= semanaFim; s += 1) semanasAtivas.push(s);
  }
  return {
    id: atividade.id,
    nome: atividade.nome,
    codigo: atividade.codigo,
    duracao: atividade.duracao,
    critico: atividade.critico,
    semanasAtivas,
  };
}

/** Duração total (dias) a partir das atividades (fim da última). */
export function duracaoTotalDasAtividades(
  atividades: readonly LobAtividade[],
): number {
  return atividades.length > 0 ? atividades[atividades.length - 1].fim : 0;
}

/** Grade LOB completa: semanas + linhas (atividades com duração). */
export function derivarGradeLob(
  atividades: readonly LobAtividade[],
  inicioIso: string,
): LobGradeData {
  const duracaoTotal = duracaoTotalDasAtividades(atividades);
  const semanas = gerarSemanas(inicioIso, duracaoTotal);
  const linhas = atividades
    .filter((a) => a.duracao > 0)
    .map(atividadeParaLobLinha);
  return { semanas, linhas };
}

/** Dias corridos entre duas datas ISO (inclusive início). Negativo se fora de ordem. */
export function diasEntre(startIso: string, endIso: string): number {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}
