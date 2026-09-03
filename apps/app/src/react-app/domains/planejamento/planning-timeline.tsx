/** @jsxImportSource react */
import { cn } from "@/lib/utils";
import {
  daysBetween,
  parseIsoDate,
} from "./planning-data";
import type { PlanningPeriod, PlanningRow } from "./planning-types";

/**
 * Timeline simples da capacidade de Planejamento (V1).
 * Visualização temporal derivada de start/end/periods — NÃO é um Gantt e não
 * contém dependências, arraste ou agendamento. O conteúdo possui largura
 * proporcional aos dias; o scroll é controlado pelo contêiner da Dashboard.
 */

const BAR_CLASSES: Record<PlanningRow["item"]["status"], string> = {
  planejado: "bg-slate-400/80",
  em_andamento: "bg-primary",
  atrasado: "bg-destructive",
  concluido: "bg-emerald-500",
};

function barClass(status: PlanningRow["item"]["status"]): string {
  return BAR_CLASSES[status];
}

export function PlanningTimeline({
  rows,
  periods,
  selectedId,
  onSelect,
  rowHeight,
  axisHeight,
  dayWidth = 3,
}: {
  rows: PlanningRow[];
  periods: PlanningPeriod[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  rowHeight: number;
  axisHeight: number;
  dayWidth?: number;
}) {
  const axisStart = periods.length > 0 ? parseIsoDate(periods[0].start) : null;
  const axisEnd = periods.length > 0 ? parseIsoDate(periods[periods.length - 1].end) : null;
  if (!axisStart || !axisEnd) {
    return (
      <div
        data-planning-timeline
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ height: 120 }}
      >
        Nenhum período com data para exibir.
      </div>
    );
  }

  const axisDays = daysBetween(
    periods[0].start,
    periods[periods.length - 1].end,
  );
  const contentWidth = Math.max(1, (axisDays + 1) * dayWidth + 12);

  const xOf = (iso: string): number => daysBetween(periods[0].start, iso) * dayWidth;

  return (
    <div
      data-planning-timeline
      className="relative"
      style={{ width: contentWidth }}
    >
      {/* Eixo temporal (meses) */}
      <div
        aria-hidden="true"
        className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur"
        style={{ height: axisHeight }}
      >
        {periods.map((period) => {
          const width = (daysBetween(period.start, period.end) + 1) * dayWidth;
          return (
            <div
              key={period.id}
              className="absolute top-0 flex h-full items-center justify-center overflow-hidden border-r border-border/60 px-1 text-[11px] font-medium text-muted-foreground"
              style={{ left: xOf(period.start), width }}
            >
              {period.label}
            </div>
          );
        })}
      </div>

      {/* Linhas com barras por item (mesma ordem das linhas da árvore) */}
      {rows.map((row, index) => {
        const { item } = row;
        const start = parseIsoDate(item.start);
        const end = parseIsoDate(item.end);
        const hasPeriod = start !== null && end !== null;
        const active = selectedId === item.id;
        return (
          <div
            key={item.id}
            data-planning-period-row={item.id}
            className="relative border-b border-border/30"
            style={{ height: rowHeight }}
          >
            {hasPeriod ? (
              <button
                type="button"
                data-planning-bar={item.id}
                aria-label={`${item.name}: ${item.start ?? ""} até ${item.end ?? ""}`}
                className={cn(
                  "absolute top-1/2 z-[1] -translate-y-1/2 cursor-pointer rounded-sm",
                  barClass(item.status),
                  active && "z-[2] ring-2 ring-ring ring-offset-1",
                )}
                style={{
                  left: xOf(item.start ?? ""),
                  width: Math.max(
                    dayWidth,
                    (daysBetween(item.start ?? "", item.end ?? "") + 1) * dayWidth,
                  ),
                  height: Math.max(10, rowHeight - 10),
                }}
                onClick={() => onSelect(item.id)}
                title={`${item.name} · ${item.start} → ${item.end}`}
              />
            ) : null}
            {index % 2 === 1 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-full bg-muted/20"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
