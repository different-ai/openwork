/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  derivePlanningAlerts,
  derivePlanningRows,
  derivePlanningSummary,
  planningRowsForQuery,
  resolvePlanningPeriods,
} from "./planning-data";
import { PlanningItemDetails } from "./planning-details";
import { PlanningHelp } from "./planning-help";
import { PlanningTimeline } from "./planning-timeline";
import { PlanningTree } from "./planning-tree";
import type {
  PlanningAlert,
  PlanningDashboardData,
  PlanningSummary,
} from "./planning-types";

/** Alturas fixas compartilhadas (árvore/timeline alinhadas linha a linha). */
export const PLANNING_ROW_HEIGHT = 36;
export const PLANNING_AXIS_HEIGHT = 30;

function KpiCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex items-baseline justify-between gap-3 py-3">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className={cn("text-2xl font-bold tabular-nums", tone)}>{value}</span>
      </CardContent>
    </Card>
  );
}

function summaryToCards(summary: PlanningSummary) {
  return [
    { id: "kpi-total", label: "Total", value: summary.total, tone: undefined },
    { id: "kpi-em-andamento", label: "Em andamento", value: summary.emAndamento, tone: "text-sky-600" },
    { id: "kpi-atencao", label: "Atenção", value: summary.atencao, tone: "text-amber-600" },
    { id: "kpi-concluidos", label: "Concluídos", value: summary.concluidos, tone: "text-emerald-600" },
  ] as const;
}

const ALERT_TONE: Record<PlanningAlert["severity"], { label: string; className: string }> = {
  warning: { label: "Atenção", className: "border-amber-500/40 bg-amber-500/5" },
  info: { label: "Info", className: "border-sky-500/40 bg-sky-500/5" },
  success: { label: "OK", className: "border-emerald-500/40 bg-emerald-500/5" },
};

export function PlanningDashboard({
  data,
  className,
}: {
  data: PlanningDashboardData;
  className?: string;
}) {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);

  const items = data.items;
  const periods = useMemo(() => resolvePlanningPeriods(data), [data]);
  const collapsedRows = useMemo(
    () => derivePlanningRows(items, collapsedIds),
    [items, collapsedIds],
  );
  const rows = useMemo(() => {
    const q = query.trim();
    return q ? planningRowsForQuery(items, q) : collapsedRows;
  }, [items, query, collapsedRows]);
  const summary = useMemo(() => derivePlanningSummary(data), [data]);
  const alerts = useMemo(() => derivePlanningAlerts(data), [data]);
  const byId = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );

  const selectedItem = selectedId ? byId.get(selectedId) ?? null : null;
  const parentName = selectedItem?.parentId
    ? byId.get(selectedItem.parentId)?.name ?? null
    : null;

  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const syncScrollToTree = (scrollTop: number) => {
    if (treeScrollRef.current) treeScrollRef.current.scrollTop = scrollTop;
  };
  const syncScrollToTimeline = (scrollTop: number) => {
    if (timelineScrollRef.current) timelineScrollRef.current.scrollTop = scrollTop;
  };

  const kpiCards = summaryToCards(summary);
  const empty = items.length === 0;

  return (
    <div
      data-planning-dashboard
      className={cn("flex h-full w-full min-h-0 flex-col gap-3", className)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-tight">
            {data.context.title}
          </h2>
          {data.context.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {data.context.subtitle}
            </p>
          ) : null}
        </div>
        <PlanningHelp />
      </header>

      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Sem itens de planejamento</EmptyTitle>
          </EmptyHeader>
          <EmptyDescription>
            Este planejamento ainda não possui itens para exibir.
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          {/* Resumo (KPIs derivados) */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Resumo">
            {kpiCards.map((kpi) => (
              <div key={kpi.id} data-kpi={kpi.id}>
                <KpiCard label={kpi.label} value={kpi.value} tone={kpi.tone} />
              </div>
            ))}
          </div>

          {/* Busca por nome */}
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por nome…"
              aria-label="Buscar no planejamento"
              className="pl-8"
            />
          </div>
          {/* Árvore + Timeline (linhas sincronizadas) */}
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
            <div className="flex h-full min-h-0">
              <div
                ref={treeScrollRef}
                data-planning-tree-scroll
                className="w-[320px] min-w-[220px] max-w-[45%] shrink-0 overflow-y-auto border-r border-border/70"
                onScroll={(event) => syncScrollToTimeline(event.currentTarget.scrollTop)}
              >
                <PlanningTree
                  rows={rows}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggle={toggleCollapse}
                  rowHeight={PLANNING_ROW_HEIGHT}
                  axisHeight={PLANNING_AXIS_HEIGHT}
                />
              </div>
              <div
                ref={timelineScrollRef}
                data-planning-timeline-scroll
                className="min-w-0 flex-1 overflow-auto"
                onScroll={(event) => syncScrollToTree(event.currentTarget.scrollTop)}
              >
                <PlanningTimeline
                  rows={rows}
                  periods={periods}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  rowHeight={PLANNING_ROW_HEIGHT}
                  axisHeight={PLANNING_AXIS_HEIGHT}
                />
              </div>
            </div>
          </div>

          {/* Alertas derivados */}
          <section className="shrink-0" aria-label="Alertas do planejamento">
            <div className="mb-1 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Alertas
              </h3>
              {alerts.length > 0 ? <Badge variant="outline">{alerts.length}</Badge> : null}
            </div>
            {alerts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum alerta derivado dos dados.
              </p>
            ) : (
              <div className="flex max-h-28 flex-col gap-1 overflow-y-auto pr-1">
                {alerts.map((alert) => {
                  const tone = ALERT_TONE[alert.severity];
                  return (
                    <div
                      key={alert.id}
                      data-alert={alert.id}
                      className={cn(
                        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                        tone.className,
                      )}
                    >
                      <span className="mt-0.5 shrink-0 font-semibold uppercase tracking-wide">
                        {tone.label}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium">{alert.title}</span>
                        <span className="text-muted-foreground"> — {alert.detail}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          {/* Detalhes do item selecionado */}
          <Sheet
            open={selectedItem !== null}
            onOpenChange={(open) => {
              if (!open) setSelectedId(null);
            }}
          >
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
              {selectedItem ? (
                <>
                  <SheetHeader>
                    <SheetTitle>{selectedItem.name}</SheetTitle>
                    <SheetDescription>
                      Detalhes do item selecionado no planejamento.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="px-4 py-4">
                    <PlanningItemDetails item={selectedItem} parentName={parentName} />
                  </div>
                </>
              ) : null}
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
}
