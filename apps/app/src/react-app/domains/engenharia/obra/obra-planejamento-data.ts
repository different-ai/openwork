// Domínio Engenharia — dados de planejamento da Obra (FASE 20.x).
//
// FONTE ÚNICA de datas/durações do cronograma da Obra Modelo EAP. Deriva o
// planejamento a partir dos 81 nós reais da EAP (obra-eap-data.ts) + as
// quantidades/produtividades de escopo (SCOPE_REF), espelhando a lógica usada
// na geração da planilha nativa (aba PLANEJAMENTO / LINHA DE BALANÇO).
//
// Princípio: NADA é inventado aqui. As datas são derivadas deterministicamente
// dos nós + escopo. O resumo (duração total, críticos) é sempre derivado.
import type { ObraEapNode } from "./obra-eap-types";

/** Data de início padrão da obra (05/01/2026) — fallback do cronograma. */
export const DATA_INICIO_DEFAULT = new Date(2026, 0, 5);

/**
 * Data de início da obra (05/01/2026) — base do cronograma.
 * Mantida como alias de `DATA_INICIO_DEFAULT` para compatibilidade; o
 * cronograma agora deriva a data de início da obra via `dataInicioEfetiva`.
 */
export const DATA_INICIO_OBRA = DATA_INICIO_DEFAULT;

/**
 * Resolve a data de início efetiva do cronograma a partir do cadastro da obra
 * (`obra.dataInicio`, string ISO "yyyy-mm-dd" | null | undefined).
 * Se ausente/vazia/inválida, usa o fallback `DATA_INICIO_DEFAULT` (05/01/2026),
 * preservando as seeds da Obra Modelo (que não definem `dataInicio`).
 * Parse local (não UTC) para manter consistência com `diaParaDataIso`.
 */
export function dataInicioEfetiva(obraDataInicio?: string | null): Date {
  if (obraDataInicio) {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(obraDataInicio.trim());
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(year, month - 1, day);
      }
    }
  }
  return new Date(DATA_INICIO_DEFAULT);
}

/** Quantidade e produtividade por WBS (escopo de referência da Obra Modelo). */
export type ObraEapScopeRef = {
  unidade: string;
  quantidade: number;
  produtividade: string;
};

/** Escopo de referência por WBS (espelha a fonte da planilha). */
export const OBRA_SCOPE_REF: Record<string, ObraEapScopeRef> = {
  // Disciplina 1 — Preparação, Projetos e Canteiro
  "1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.1.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.1.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.2.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.2.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "1.2.3": { unidade: "vb", quantidade: 1, produtividade: "—" },
  // Disciplina 2 — Infraestrutura e Fundações
  "2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "2.1": { unidade: "m³", quantidade: 120, produtividade: "8 m³/dia" },
  "2.1.1": { unidade: "m³", quantidade: 120, produtividade: "8 m³/dia" },
  "2.1.2": { unidade: "m²", quantidade: 80, produtividade: "6 m²/dia" },
  "2.2": { unidade: "m³", quantidade: 90, produtividade: "6 m³/dia" },
  "2.2.1": { unidade: "m³", quantidade: 70, produtividade: "6 m³/dia" },
  "2.2.2": { unidade: "m³", quantidade: 20, produtividade: "5 m³/dia" },
  // Disciplina 3 — Superestrutura
  "3": { unidade: "m³", quantidade: 420, produtividade: "—" },
  "3.1": { unidade: "m³", quantidade: 40, produtividade: "6 m³/dia" },
  "3.1.1": { unidade: "m³", quantidade: 40, produtividade: "6 m³/dia" },
  "3.2": { unidade: "m³", quantidade: 35, produtividade: "6 m³/dia" },
  "3.2.1": { unidade: "m³", quantidade: 35, produtividade: "6 m³/dia" },
  "3.3": { unidade: "m³", quantidade: 280, produtividade: "6 m³/dia" },
  "3.3.1": { unidade: "m³", quantidade: 280, produtividade: "6 m³/dia" },
  "3.4": { unidade: "m³", quantidade: 40, produtividade: "5 m³/dia" },
  "3.4.1": { unidade: "m³", quantidade: 40, produtividade: "5 m³/dia" },
  "3.5": { unidade: "m³", quantidade: 25, produtividade: "5 m³/dia" },
  "3.5.1": { unidade: "m³", quantidade: 25, produtividade: "5 m³/dia" },
  // Disciplina 4 — Vedações e Esquadrias
  "4": { unidade: "m²", quantidade: 1800, produtividade: "—" },
  "4.1": { unidade: "m²", quantidade: 1500, produtividade: "12 m²/dia" },
  "4.1.1": { unidade: "m²", quantidade: 900, produtividade: "12 m²/dia" },
  "4.1.2": { unidade: "m²", quantidade: 600, produtividade: "10 m²/dia" },
  "4.2": { unidade: "un", quantidade: 60, produtividade: "—" },
  "4.2.1": { unidade: "un", quantidade: 30, produtividade: "2 un/dia" },
  "4.2.2": { unidade: "un", quantidade: 30, produtividade: "3 un/dia" },
  // Disciplina 5 — Cobertura e Impermeabilização
  "5": { unidade: "m²", quantidade: 400, produtividade: "—" },
  "5.1": { unidade: "m²", quantidade: 250, produtividade: "—" },
  "5.1.1": { unidade: "m²", quantidade: 150, produtividade: "6 m²/dia" },
  "5.1.2": { unidade: "m²", quantidade: 100, produtividade: "8 m²/dia" },
  "5.2": { unidade: "m²", quantidade: 150, produtividade: "—" },
  "5.2.1": { unidade: "m²", quantidade: 50, produtividade: "10 m²/dia" },
  "5.2.2": { unidade: "m²", quantidade: 60, produtividade: "10 m²/dia" },
  "5.2.3": { unidade: "m²", quantidade: 40, produtividade: "8 m²/dia" },
  // Disciplina 6 — Instalações Prediais
  "6": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "6.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "6.1.1": { unidade: "pt", quantidade: 30, produtividade: "2 pt/dia" },
  "6.1.2": { unidade: "pt", quantidade: 30, produtividade: "2 pt/dia" },
  "6.1.3": { unidade: "pt", quantidade: 15, produtividade: "2 pt/dia" },
  "6.1.4": { unidade: "un", quantidade: 2, produtividade: "1 un/dia" },
  "6.1.5": { unidade: "pt", quantidade: 15, produtividade: "2 pt/dia" },
  "6.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "6.2.1": { unidade: "un", quantidade: 15, produtividade: "1 un/dia" },
  "6.2.2": { unidade: "pt", quantidade: 60, produtividade: "3 pt/dia" },
  "6.3": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "6.3.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "6.3.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  // Disciplina 7 — Elevadores
  "7": { unidade: "un", quantidade: 1, produtividade: "—" },
  "7.1": { unidade: "un", quantidade: 1, produtividade: "—" },
  "7.1.1": { unidade: "un", quantidade: 1, produtividade: "—" },
  "7.1.2": { unidade: "un", quantidade: 1, produtividade: "—" },
  // Disciplina 8 — Acabamentos
  "8": { unidade: "m²", quantidade: 2500, produtividade: "—" },
  "8.1": { unidade: "m²", quantidade: 1800, produtividade: "—" },
  "8.1.1": { unidade: "m²", quantidade: 900, produtividade: "15 m²/dia" },
  "8.1.2": { unidade: "m²", quantidade: 900, produtividade: "12 m²/dia" },
  "8.2": { unidade: "m²", quantidade: 2200, produtividade: "—" },
  "8.2.1": { unidade: "m²", quantidade: 1500, produtividade: "25 m²/dia" },
  "8.2.2": { unidade: "m²", quantidade: 700, produtividade: "20 m²/dia" },
  "8.3": { unidade: "m²", quantidade: 400, produtividade: "—" },
  "8.3.1": { unidade: "m²", quantidade: 250, produtividade: "15 m²/dia" },
  "8.3.2": { unidade: "m", quantidade: 300, produtividade: "20 m/dia" },
  // Disciplina 9 — Sistemas de Proteção e Segurança
  "9": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "9.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "9.1.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "9.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "9.2.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "9.2.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  // Disciplina 10 — Áreas Externas
  "10": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "10.1": { unidade: "m²", quantidade: 200, produtividade: "—" },
  "10.1.1": { unidade: "m²", quantidade: 150, produtividade: "15 m²/dia" },
  "10.1.2": { unidade: "m²", quantidade: 50, produtividade: "10 m²/dia" },
  "10.2": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "10.2.1": { unidade: "vb", quantidade: 1, produtividade: "—" },
  "10.2.2": { unidade: "m", quantidade: 60, produtividade: "10 m/dia" },
};

/** Resolve a disciplina raiz de um nó (nome da DISCIPLINA nível 1). */
export function resolveDisciplina(
  node: ObraEapNode,
  nodes: readonly ObraEapNode[],
): string {
  if (node.nivel === 1) return node.nome;
  const pai = nodes.find((n) => n.wbs === node.pai);
  if (!pai) return "";
  if (pai.nivel === 1) return pai.nome;
  const avo = nodes.find((n) => n.wbs === pai.pai);
  return avo ? avo.nome : "";
}

/** Extrai a taxa diária de uma produtividade "N un/dia" (ou null). */
function taxaDiaria(produtividade: string): number | null {
  const match = /([\d.]+)\s*([^\s]+)\/dia/.exec(produtividade);
  if (!match) return null;
  const rate = Number(match[1]);
  return rate && rate > 0 ? rate : null;
}

/**
 * Duração estimada (dias) de um nó TRABALHO com produtividade; senão 0.
 * Recebe o escopo da obra (wbs → ref); sem escopo resolve a "sem escopo" (0).
 */
export function calcDuracao(
  node: ObraEapNode,
  escopo: Record<string, ObraEapScopeRef>,
): number {
  if (node.tipo !== "TRABALHO") return 0;
  const ref = escopo[node.wbs];
  if (!ref || ref.produtividade === "—") return 0;
  const rate = taxaDiaria(ref.produtividade);
  if (rate === null) return 0;
  return Math.ceil(ref.quantidade / rate);
}

/** Número da disciplina raiz de um nó (para ordenação por disciplina). */
function disciplinaOrdem(node: ObraEapNode, nodes: readonly ObraEapNode[]): number {
  if (node.nivel === 1) return Number(node.wbs);
  const pai = nodes.find((n) => n.wbs === node.pai);
  if (pai && pai.nivel === 1) return Number(pai.wbs);
  const avo = nodes.find((n) => n.wbs === pai?.pai);
  return avo ? Number(avo.wbs) : 0;
}

/** Linha de planejamento derivada de um nó (datas em dias acumulados). */
export type ObraPlanejamentoLinha = {
  node: ObraEapNode;
  disciplina: string;
  duracao: number;
  inicio: number;
  fim: number;
  ritmo: number | "";
  critico: "CRÍTICO" | "Sequencial" | "—";
  predecessora: string;
};

/** Sequencia os nós por disciplina (depois pré-order) e calcula datas. */
export function derivarPlanejamento(
  nodes: readonly ObraEapNode[],
  escopo: Record<string, ObraEapScopeRef>,
  _startDate: Date = DATA_INICIO_DEFAULT,
): ObraPlanejamentoLinha[] {
  const indiceOriginal = new Map(nodes.map((n, i) => [n.wbs, i]));
  const sequenciados = [...nodes].sort((a, b) => {
    const da = disciplinaOrdem(a, nodes);
    const db = disciplinaOrdem(b, nodes);
    if (da !== db) return da - db;
    return (indiceOriginal.get(a.wbs) ?? 0) - (indiceOriginal.get(b.wbs) ?? 0);
  });

  let diaAtual = 0;
  const linhas: ObraPlanejamentoLinha[] = [];
  for (const node of sequenciados) {
    const ref = escopo[node.wbs];
    const duracao = calcDuracao(node, escopo);
    const inicio = diaAtual;
    const fim = inicio + duracao;
    diaAtual = fim;
    const ritmo =
      duracao > 0 && ref && ref.quantidade
        ? Math.round((ref.quantidade / duracao) * 100) / 100
        : "";
    linhas.push({
      node,
      disciplina: resolveDisciplina(node, nodes),
      duracao,
      inicio,
      fim,
      ritmo,
      critico: "—",
      predecessora: "",
    });
  }
  return linhas;
}

/** Duração total da obra (dias) a partir das linhas derivadas. */
export function duracaoTotalDasLinhas(linhas: readonly ObraPlanejamentoLinha[]): number {
  return linhas.length > 0 ? linhas[linhas.length - 1].fim : 0;
}

/** Limiar crítico: 60% da maior duração entre trabalhos com duração. */
export function limiarCriticoDasLinhas(
  linhas: readonly ObraPlanejamentoLinha[],
): number {
  const trabalhosComDuracao = linhas.filter((l) => l.duracao > 0);
  if (trabalhosComDuracao.length === 0) return 0;
  const maxDuracao = Math.max(...trabalhosComDuracao.map((l) => l.duracao));
  return maxDuracao * 0.6;
}

/** Preenche crítico e predecessora nas linhas (TRABALHO com duração). */
export function marcarCriticoEPredecessora(
  linhas: ObraPlanejamentoLinha[],
): ObraPlanejamentoLinha[] {
  const limiar = limiarCriticoDasLinhas(linhas);
  let ultimoTrabalho: string | null = null;
  return linhas.map((l) => {
    const node = l.node;
    const critico =
      node.tipo === "TRABALHO" && l.duracao > 0
        ? l.duracao >= limiar
          ? "CRÍTICO"
          : "Sequencial"
        : "—";
    const predecessora =
      node.tipo === "TRABALHO" && l.duracao > 0 && ultimoTrabalho
        ? ultimoTrabalho
        : "";
    if (node.tipo === "TRABALHO" && l.duracao > 0) ultimoTrabalho = node.wbs;
    return { ...l, critico, predecessora };
  });
}

/** Converte dia acumulado em data ISO (yyyy-mm-dd) a partir do início da obra. */
export function diaParaDataIso(dia: number, startDate: Date = DATA_INICIO_DEFAULT): string {
  const d = new Date(startDate);
  d.setDate(d.getDate() + dia);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Planejamento completo derivado dos nós reais da EAP. */
export function derivarPlanejamentoCompleto(
  nodes: readonly ObraEapNode[],
  escopo: Record<string, ObraEapScopeRef>,
  startDate: Date = DATA_INICIO_DEFAULT,
): ObraPlanejamentoLinha[] {
  return marcarCriticoEPredecessora(derivarPlanejamento(nodes, escopo, startDate));
}
