// Helpers puros da capacidade de Planejamento (V1) — sem DOM, testáveis.
// Tudo aqui é DERIVADO dos dados; nada é inventado pelo componente.
import type {
  PlanningAlert,
  PlanningDashboardData,
  PlanningItem,
  PlanningPeriod,
  PlanningRow,
  PlanningSummary,
} from "./planning-types";

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

const DAY_MS = 86_400_000;

/** Data de referência para alertas (contexto → hoje). */
export function planningReferenceDate(data: PlanningDashboardData): Date {
  return parseIsoDate(data.context.referenceDate) ?? new Date();
}

// ------------------------------------------------------------------ //
// Hierarquia / linhas visíveis
// ------------------------------------------------------------------ //

/** Mapa parentId -> filhos na ordem declarada. */
export function buildPlanningChildrenIndex(
  items: PlanningItem[],
): Map<string, PlanningItem[]> {
  const byParent = new Map<string, PlanningItem[]>();
  for (const item of items) {
    const key = item.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }
  return byParent;
}

/** Ids dos nós raiz (parentId ausente ou sem nó correspondente). */
export function planningRootIds(
  items: PlanningItem[],
  byParent?: Map<string, PlanningItem[]>,
): string[] {
  const children = byParent ?? buildPlanningChildrenIndex(items);
  const ids = new Set(items.map((item) => item.id));
  const roots: string[] = [];
  for (const item of items) {
    const parentMissing =
      !item.parentId || !ids.has(item.parentId) || !children.has(item.parentId);
    if (parentMissing) roots.push(item.id);
  }
  return roots;
}

/**
 * Linhas visíveis em ordem de árvore (DFS, pré-order) respeitando o conjunto de
 * nós recolhidos. Árvore e timeline consomem a MESMA lista (alinhamento 1:1).
 */
export function derivePlanningRows(
  items: PlanningItem[],
  collapsedIds: ReadonlySet<string>,
): PlanningRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = buildPlanningChildrenIndex(items);
  const rows: PlanningRow[] = [];

  const visit = (id: string) => {
    const item = byId.get(id);
    if (!item) return;
    const kids = children.get(id) ?? [];
    const expanded = !collapsedIds.has(id);
    rows.push({
      item,
      depth: item.level,
      hasChildren: kids.length > 0,
      expanded,
    });
    if (kids.length > 0 && expanded) {
      for (const kid of kids) visit(kid.id);
    }
  };

  for (const rootId of planningRootIds(items, children)) visit(rootId);
  return rows;
}

/**
 * Filtro de busca por nome mantendo a hierarquia: um nó só aparece se ele
 * (ou algum descendente) casa com o texto; ancestrais de nós casados também
 * são mantidos. Durante a busca a estrutura é revelada (colapso ignorado).
 */
export function planningRowsForQuery(
  items: PlanningItem[],
  query: string,
): PlanningRow[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return derivePlanningRows(items, new Set());
  const children = buildPlanningChildrenIndex(items);
  const byId = new Map(items.map((item) => [item.id, item]));

  const matches: Record<string, boolean> = {};
  for (const item of items) {
    matches[item.id] = item.name.toLocaleLowerCase().includes(q);
  }

  const hasMatchBelow = (id: string): boolean => {
    if (matches[id]) return true;
    const kids = children.get(id) ?? [];
    return kids.some((kid) => hasMatchBelow(kid.id));
  };

  const visibleIds = new Set<string>();
  const propagateUp = (id: string) => {
    if (visibleIds.has(id)) return;
    visibleIds.add(id);
    const item = byId.get(id);
    if (item?.parentId) propagateUp(item.parentId);
  };
  for (const item of items) {
    if (matches[item.id]) propagateUp(item.id);
  }

  const rows: PlanningRow[] = [];
  const visit = (id: string) => {
    const item = byId.get(id);
    if (!item) return;
    const kids = (children.get(id) ?? []).filter((kid) => visibleIds.has(kid.id));
    rows.push({
      item,
      depth: item.level,
      hasChildren: kids.length > 0,
      expanded: true,
    });
    for (const kid of kids) visit(kid.id);
  };
  for (const rootId of planningRootIds(items, children)) {
    if (visibleIds.has(rootId) || hasMatchBelow(rootId)) visit(rootId);
  }
  return rows;
}

// ------------------------------------------------------------------ //
// Resumo (KPIs derivados)
// ------------------------------------------------------------------ //

export function derivePlanningSummary(
  data: PlanningDashboardData,
  referenceDate?: Date,
): PlanningSummary {
  const ref = referenceDate ?? planningReferenceDate(data);
  const items = data.items;
  const emAndamento = items.filter((item) => item.status === "em_andamento").length;
  const concluidos = items.filter((item) => item.status === "concluido").length;
  const atencao = items.filter((item) => {
    if (item.status === "atrasado") return true;
    if (item.status !== "em_andamento") return false;
    const end = parseIsoDate(item.end);
    return end !== null && ref !== null && end.getTime() < ref.getTime();
  }).length;
  return {
    total: items.length,
    emAndamento,
    atencao,
    concluidos,
  };
}

// ------------------------------------------------------------------ //
// Alertas (derivados dos dados)
// ------------------------------------------------------------------ //

export function derivePlanningAlerts(
  data: PlanningDashboardData,
  referenceDate?: Date,
): PlanningAlert[] {
  const ref = referenceDate ?? planningReferenceDate(data);
  const children = buildPlanningChildrenIndex(data.items);
  const alerts: PlanningAlert[] = [];

  for (const item of data.items) {
    const hasChildren = (children.get(item.id) ?? []).length > 0;
    const start = parseIsoDate(item.start);
    const end = parseIsoDate(item.end);

    if (!hasChildren && !start && !end) {
      alerts.push({
        id: `sem-periodo:${item.id}`,
        severity: "warning",
        title: "Sem período",
        detail: `"${item.name}" não possui início e fim definidos.`,
        itemId: item.id,
      });
      continue;
    }
    if (item.status === "atrasado") {
      alerts.push({
        id: `atrasado:${item.id}`,
        severity: "warning",
        title: "Atrasado",
        detail: `"${item.name}" está marcado como atrasado.`,
        itemId: item.id,
      });
    } else if (
      item.status === "em_andamento" &&
      end !== null &&
      ref !== null &&
      end.getTime() < ref.getTime()
    ) {
      alerts.push({
        id: `atencao:${item.id}`,
        severity: "warning",
        title: "Em atenção",
        detail: `"${item.name}" tem fim previsto em ${item.end} e ainda não foi concluído.`,
        itemId: item.id,
      });
    }
    if (item.status === "concluido") {
      alerts.push({
        id: `concluido:${item.id}`,
        severity: "success",
        title: "Concluído",
        detail: `"${item.name}" foi concluído.`,
        itemId: item.id,
      });
    } else if (item.progress >= 100) {
      alerts.push({
        id: `progresso-sem-conclusao:${item.id}`,
        severity: "info",
        title: "Progresso sem conclusão",
        detail: `"${item.name}" está com progresso 100% mas não marcado como concluído.`,
        itemId: item.id,
      });
    }
  }

  const order: Record<PlanningAlert["severity"], number> = {
    warning: 0,
    info: 1,
    success: 2,
  };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ------------------------------------------------------------------ //
// Períodos / eixo temporal
// ------------------------------------------------------------------ //

/**
 * Deriva o eixo mensal que cobre o intervalo [menor início, maior fim] dos
 * itens com datas. Quando não há datas, retorna []. Rótulo = mês curto.
 */
export function derivePlanningPeriods(items: PlanningItem[]): PlanningPeriod[] {
  const starts: Date[] = [];
  const ends: Date[] = [];
  for (const item of items) {
    const start = parseIsoDate(item.start);
    const end = parseIsoDate(item.end);
    if (start) starts.push(start);
    if (end) ends.push(end);
  }
  if (starts.length === 0 || ends.length === 0) return [];

  const min = new Date(Math.min(...starts.map((d) => d.getTime())));
  const max = new Date(Math.max(...ends.map((d) => d.getTime())));
  const first = new Date(min.getFullYear(), min.getMonth(), 1);
  const last = new Date(max.getFullYear(), max.getMonth() + 1, 0);

  const months: PlanningPeriod[] = [];
  const cursor = new Date(first);
  const MONTH_LABELS = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
    "Jul", "Ago", "Set", "Out", "Nov", "Dez",
  ];
  while (cursor.getTime() <= last.getTime()) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    months.push({
      id: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`,
      label: MONTH_LABELS[cursor.getMonth()],
      start: toIso(cursor),
      end: toIso(monthEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

/** Normaliza o eixo: usa os períodos do contrato ou deriva dos itens. */
export function resolvePlanningPeriods(
  data: PlanningDashboardData,
): PlanningPeriod[] {
  return data.periods && data.periods.length > 0
    ? data.periods
    : derivePlanningPeriods(data.items);
}

/** Dias corridos entre duas datas ISO (inclusive início). Negativo se fora de ordem. */
export function daysBetween(startIso: string, endIso: string): number {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}
