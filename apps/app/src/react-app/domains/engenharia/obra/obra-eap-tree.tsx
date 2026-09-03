// Domínio Engenharia — árvore navegável da EAP (FASE 06.2-B).
// Componente presentacional: recebe linhas prontas (deriveEapRows) e eventos.
// Nenhuma hierarquia é derivada aqui; nenhum domínio externo é conhecido.
/** @jsxImportSource react */
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ObraEapNode, ObraEapTipo } from "./obra-eap-types";

export type EapRow = {
  node: ObraEapNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
};

const TIPO_LABEL: Record<ObraEapTipo, string> = {
  DISCIPLINA: "Disciplina",
  PACOTE: "Pacote",
  TRABALHO: "Trabalho",
};

const TIPO_TONE: Record<ObraEapTipo, string> = {
  DISCIPLINA: "border-sky-500/40 bg-sky-500/10 text-sky-700",
  PACOTE: "border-violet-500/40 bg-violet-500/10 text-violet-700",
  TRABALHO: "border-slate-400/40 bg-slate-400/10 text-slate-600",
};

export function EapTree({
  rows,
  selectedWbs,
  onSelect,
  onToggle,
}: {
  rows: EapRow[];
  selectedWbs?: string | null;
  onSelect: (wbs: string) => void;
  onToggle: (wbs: string) => void;
}) {
  return (
    <div role="tree" aria-label="Estrutura Analítica do Projeto" data-eap-tree className="min-w-full">
      {rows.map((row) => {
        const { node } = row;
        const active = selectedWbs === node.wbs;
        return (
          <div
            key={node.wbs}
            role="treeitem"
            aria-level={node.nivel}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={active}
            data-eap-row
            data-eap-wbs={node.wbs}
            className={cn(
              "group/row flex cursor-pointer items-center gap-2 border-b border-border/40 py-1.5 pr-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
            )}
            onClick={() => onSelect(node.wbs)}
          >
            <span
              aria-hidden="true"
              className="shrink-0"
              style={{ width: (node.nivel - 1) * 16 + 4 }}
            />
            {row.hasChildren ? (
              <button
                type="button"
                aria-label={row.expanded ? "Recolher" : "Expandir"}
                data-eap-toggle={node.wbs}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(node.wbs);
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
            <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {node.wbs}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{node.nome}</span>
            <Badge
              variant="outline"
              className={cn("shrink-0 text-[10px] font-medium", TIPO_TONE[node.tipo])}
            >
              {TIPO_LABEL[node.tipo]}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}
