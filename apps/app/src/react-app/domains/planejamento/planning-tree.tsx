/** @jsxImportSource react */
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PlanningRow } from "./planning-types";

/**
 * Árvore hierárquica da capacidade de Planejamento (V1).
 * Recebe APENAS linhas prontas (derivePlanningRows) e eventos — nenhuma
 * hierarquia é derivada aqui e nenhum domínio é conhecido.
 */

export function PlanningTree({
  rows,
  selectedId,
  onSelect,
  onToggle,
  rowHeight,
  axisHeight,
}: {
  rows: PlanningRow[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  rowHeight: number;
  /** Espaço reservado no topo para alinhar com o eixo da timeline. */
  axisHeight: number;
}) {
  return (
    <div
      role="tree"
      aria-label="Estrutura do planejamento"
      data-planning-tree
      className="min-w-full"
    >
      <div style={{ height: axisHeight }} aria-hidden="true" />
      {rows.map((row) => {
        const { item } = row;
        const active = selectedId === item.id;
        return (
          <div
            key={item.id}
            role="treeitem"
            aria-level={item.level + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={active}
            data-planning-row
            data-planning-id={item.id}
            style={{ height: rowHeight }}
            className={cn(
              "group/row flex cursor-pointer items-center gap-1 border-b border-border/40 pr-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
            )}
            onClick={() => onSelect(item.id)}
          >
            <span
              aria-hidden="true"
              className="shrink-0"
              style={{ width: item.level * 14 + 4 }}
            />
            {row.hasChildren ? (
              <button
                type="button"
                aria-label={row.expanded ? "Recolher" : "Expandir"}
                data-planning-toggle={item.id}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(item.id);
                }}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform duration-150",
                    row.expanded && "rotate-90",
                  )}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span aria-hidden="true" className="size-5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
            {item.progress > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {Math.round(item.progress)}%
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
