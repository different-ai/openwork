// Contrato da capacidade de Planejamento (V1) — genérico e reutilizável.
// Este módulo NÃO conhece nenhum domínio consumidor nem entidade específica.
// A Dashboard renderiza QUALQUER PlanningDashboardData fornecido por um adapter.

export type PlanningItemStatus =
  | "planejado"
  | "em_andamento"
  | "atrasado"
  | "concluido";

/** Item mínimo exibido na superfície V1. Datas opcionais: ausência vira alerta. */
export type PlanningItem = {
  id: string;
  /** Pai na hierarquia (null/undefined = raiz). */
  parentId?: string | null;
  name: string;
  /** Profundidade declarada (0 = raiz). Mantida do contrato para casos onde
   *  o nível não pode ser derivado apenas de parentId. */
  level: number;
  status: PlanningItemStatus;
  /** Progresso 0..100 (número já fornecido pelo adapter; nunca calculado aqui). */
  progress: number;
  /** ISO yyyy-mm-dd (inclusive). */
  start?: string | null;
  /** ISO yyyy-mm-dd (inclusive). */
  end?: string | null;
};

/** Período do eixo temporal (ex.: um mês). */
export type PlanningPeriod = {
  id: string;
  label: string;
  start: string;
  end: string;
};

export type PlanningContext = {
  /** Título principal (ex.: "Planejamento"). */
  title: string;
  /** Detalhe do contexto fornecido pelo adapter do domínio. */
  subtitle?: string;
  /** Data de referência ISO para derivar alertas (default: hoje). */
  referenceDate?: string;
};

/** Contrato V1 consumido pela Dashboard (ver docs da FASE 04.1). */
export type PlanningDashboardData = {
  context: PlanningContext;
  items: PlanningItem[];
  /** Eixo temporal opcional; quando ausente é derivado dos itens. */
  periods?: PlanningPeriod[];
};

// ------------------------------------------------------------------ //
// Estruturas DERIVADAS (produzidas por helpers puros, nunca no contrato)
// ------------------------------------------------------------------ //

export type PlanningSummary = {
  total: number;
  emAndamento: number;
  atencao: number;
  concluidos: number;
};

export type PlanningAlertSeverity = "info" | "warning" | "success";

export type PlanningAlert = {
  id: string;
  severity: PlanningAlertSeverity;
  title: string;
  detail: string;
  itemId?: string;
};

/** Linha pronta para renderização (árvore/timeline compartilham a mesma ordem). */
export type PlanningRow = {
  item: PlanningItem;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
};
