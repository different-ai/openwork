// Capacidade genérica de Linha de Balanço (LOB) — contrato reutilizável.
// Este módulo NÃO conhece nenhum domínio consumidor nem entidade específica.
// A grade renderiza QUALQUER LobGradeData fornecido por um adapter do domínio.
//
// FASE 21: extraída para uma capacidade reutilizável, seguindo o mesmo padrão
// da capacidade de Planejamento (domains/planejamento).
// Nenhuma fonte de verdade é criada aqui: os dados vêm do adapter do domínio.

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
  /** Identificador estável da linha (ex.: WBS). */
  id: string;
  /** Nome exibido do serviço. */
  nome: string;
  /** Código curto opcional (ex.: WBS). */
  codigo?: string;
  duracao: number;
  critico: "CRÍTICO" | "Sequencial" | "—";
  /** Índices das semanas em que o serviço está ativo. */
  semanasAtivas: number[];
};

/** Atividade genérica com duração — entrada para derivar a grade. */
export type LobAtividade = {
  id: string;
  nome: string;
  codigo?: string;
  /** Dia acumulado de início (0-based). */
  inicio: number;
  /** Dia acumulado de fim (exclusivo). */
  fim: number;
  duracao: number;
  critico: "CRÍTICO" | "Sequencial" | "—";
};

/** Contrato consumido pela grade LOB. */
export type LobGradeData = {
  semanas: LobSemana[];
  linhas: LobLinha[];
};
