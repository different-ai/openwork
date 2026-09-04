/** @jsxImportSource react */
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Barra de KPIs reutilizável (FASE 21 / FASE 22).
 *
 * Renderiza uma grade de cartões de indicador. Os VALORES são sempre fornecidos
 * pelo chamador (derivados de dados reais do domínio) — este componente é um
 * primitivo de UI neutro, sem regras de negócio.
 *
 * FASE 22: cada KPI pode ter um `target` (rota do módulo de origem). Quando
 * presente E `onNavigate` é fornecido, o card torna-se clicável e navega para
 * o módulo (drill-down). A navegação é injetada pelo chamador (evita dependência
 * de Router neste primitivo, mantendo-o SSR-testável).
 */
export type KpiItem = {
  id: string;
  label: string;
  value: number | string;
  /** Classe de cor opcional para o valor (ex.: "text-emerald-600"). */
  tone?: string;
  /** Detalhe opcional exibido abaixo do valor. */
  hint?: string;
  /** Rota do módulo de origem (drill-down). Quando presente, o card é clicável. */
  target?: string;
};

export function KpiBar({
  items,
  onNavigate,
}: {
  items: KpiItem[];
  onNavigate?: (target: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      data-kpi-bar
      className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-5"
      aria-label="Indicadores"
    >
      {items.map((kpi) => {
        const clickable = Boolean(kpi.target) && Boolean(onNavigate);
        const inner = (
          <>
            <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {kpi.label}
            </span>
            <span
              className={cn("text-2xl font-bold tabular-nums", kpi.tone)}
              data-kpi={kpi.id}
            >
              {kpi.value}
            </span>
            {kpi.hint ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {kpi.hint}
              </span>
            ) : null}
          </>
        );
        return (
          <Card
            key={kpi.id}
            className={cn("min-w-0", clickable && "cursor-pointer transition-colors hover:bg-sidebar-accent/40")}
            data-kpi-target={kpi.target}
          >
            <CardContent
              className={cn("flex flex-col gap-0.5 py-3", clickable && "h-full")}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => onNavigate?.(kpi.target!),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNavigate?.(kpi.target!);
                      }
                    },
                    "aria-label": `Ver detalhes de ${kpi.label}`,
                  }
                : {})}
            >
              {inner}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
