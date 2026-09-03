// Domínio Engenharia — modelo de domínio da EAP (Estrutura Analítica do Projeto).
// A EAP é um conceito PRÓPRIO da Obra (não reutiliza PlanningItem).
// Identidade natural de um nó: obraId + wbs (o mesmo WBS em obras diferentes
// NÃO representa o mesmo nó operacional).
//
// FASE 06.2-B: modelo de domínio criado para receber o EAP real (81 nós) da
// Obra Modelo EAP, preservando integralmente os dados da fonte oficial.

export type ObraEapTipo = "DISCIPLINA" | "PACOTE" | "TRABALHO";

/** Nó da EAP — preserva todos os campos da fonte oficial. */
export type ObraEapNode = {
  /** Obra à qual o nó pertence (identidade composta obraId + wbs). */
  obraId: string;
  /** Identificador hierárquico oficial (ex.: "1", "1.1", "1.1.1"). */
  wbs: string;
  nome: string;
  /** Nível hierárquico (1 = DISCIPLINA, 2 = PACOTE, 3 = TRABALHO). */
  nivel: number;
  tipo: ObraEapTipo;
  /** WBS do nó pai; null/undefined para raízes (nível 1). */
  pai: string | null;
  /** Ordem entre irmãos (ordem de ocorrência na fonte, pré-order). */
  ordem: number;
  /** Fundamentação do nó (preservada da fonte oficial). */
  fundamentacao?: string | null;
  /** Condição/hipótese do nó (preservada da fonte oficial). */
  condicao?: string | null;
};

/** Metadados da EAP — preserva os metadados do documento oficial. */
export type ObraEapMetadata = {
  obraId: string;
  obraNome: string;
  status: string;
  versao: string;
  caracterizacaoRef?: string | null;
  regraAlocacaoEstruturaCobertura?: string | null;
  niveisTipos?: Record<string, string> | null;
  principios?: string[] | null;
  noTemplate?: string | null;
  caracterizacaoResumo?: Record<string, unknown> | null;
};

/** EAP completa de uma Obra: metadados + nós. */
export type ObraEap = {
  obraId: string;
  metadata: ObraEapMetadata;
  nodes: ObraEapNode[];
};

/** Resumo estrutural derivado dos nós (nunca fonte independente). */
export type ObraEapSummary = {
  status: string;
  total: number;
  raizes: number;
  pacotes: number;
  trabalhos: number;
};

// ------------------------------------------------------------------ //
// Referência reutilizável de EAP (EapReference)
// ------------------------------------------------------------------ //

/**
 * Referência reutilizável de EAP — estrutura que permite a futura Skill/Agent
 * selecionar, analisar e adaptar EAPs modelo para novas obras.
 *
 * A referência NÃO substitui a EAP operacional da Obra. Ela aponta para a
 * origem (obraId) e expõe os nós por identidade, evitando duplicação de dados.
 */
export type EapReference = {
  id: string;
  nome: string;
  descricao: string;
  origem: string;
  versaoOrigem: string;
  /** Obra cuja EAP operacional é a fonte desta referência (proveniência). */
  origemObraId: string;
  caracterizacao?: Record<string, unknown> | null;
  principios?: string[] | null;
  regrasObservadas?: string[] | null;
  metadados?: Record<string, unknown> | null;
};
