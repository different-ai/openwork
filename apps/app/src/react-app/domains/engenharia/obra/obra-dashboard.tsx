/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Dashboard de widgets da Obra (FASE 22).
 *
 * Compõe widgets (KPIs + cards de contexto) numa grade. Cada widget pode ser
 * EXPANDIDO para tela cheia (overlay) e possui estrutura preparada para
 * filtros/período/atualização (via `actions` e `onRefresh`).
 *
 * NÃO implementa drag-and-drop (fase posterior). Os dados dos widgets são
 * sempre fornecidos pelo chamador (derivados de dados reais).
 */
export type DashboardWidget = {
  id: string;
  title: string;
  description?: string;
  content: ReactNode;
  /** Ações opcionais do widget (ex.: filtro, período). */
  actions?: ReactNode;
  /** Callback de atualização (recalcular). Quando ausente, não mostra o botão. */
  onRefresh?: () => void;
};

export function ObraDashboard({ widgets }: { widgets: DashboardWidget[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = widgets.find((w) => w.id === expandedId) ?? null;

  return (
    <div className="flex w-full flex-col gap-4" data-obra-dashboard>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {widgets.map((widget) => (
          <DashboardWidgetCard
            key={widget.id}
            widget={widget}
            onExpand={() => setExpandedId(widget.id)}
          />
        ))}
      </div>

      {expanded ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background"
          data-obra-dashboard-expanded
          data-widget={expanded.id}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold">{expanded.title}</h3>
              {expanded.description ? (
                <p className="text-xs text-muted-foreground">{expanded.description}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {expanded.onRefresh ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={expanded.onRefresh}
                  aria-label="Atualizar"
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setExpandedId(null)}
                aria-label="Fechar visualização ampliada"
              >
                <Minimize2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">{expanded.content}</div>
        </div>
      ) : null}
    </div>
  );
}

function DashboardWidgetCard({
  widget,
  onExpand,
}: {
  widget: DashboardWidget;
  onExpand: () => void;
}) {
  return (
    <Card className="min-w-0" data-widget={widget.id}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{widget.title}</CardTitle>
          {widget.description ? (
            <CardDescription>{widget.description}</CardDescription>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {widget.actions}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onExpand}
            aria-label={`Expandir ${widget.title}`}
            data-widget-expand={widget.id}
          >
            <Maximize2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>{widget.content}</CardContent>
    </Card>
  );
}
