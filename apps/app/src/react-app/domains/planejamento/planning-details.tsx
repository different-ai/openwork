/** @jsxImportSource react */
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { PlanningItem, PlanningItemStatus } from "./planning-types";

/** Rótulos neutros de status (genéricos, sem domínio). */
export const PLANNING_STATUS_LABELS: Record<PlanningItemStatus, string> = {
  planejado: "Planejado",
  em_andamento: "Em andamento",
  atrasado: "Atrasado",
  concluido: "Concluído",
};

export function formatPlanningDate(iso?: string | null): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso);
  if (!match) return iso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Conteúdo do painel de detalhes de um item (V1, somente leitura).
 * Exportado separadamente para testes SSR independentes do Sheet.
 */
export function PlanningItemDetails({
  item,
  parentName,
}: {
  item: PlanningItem;
  parentName?: string | null;
}) {
  return (
    <div data-planning-details className="flex flex-col">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {parentName ? `Nível ${item.level + 1} · em ${parentName}` : `Nível ${item.level + 1}`}
        </span>
        <Badge variant="outline">{PLANNING_STATUS_LABELS[item.status]}</Badge>
      </div>

      <div className="py-2">
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Progresso</span>
          <span className="tabular-nums font-medium">{Math.round(item.progress)}%</span>
        </div>
        <Progress value={Math.round(item.progress)} className="w-full" />
      </div>

      <div className="flex flex-col">
        <DetailRow label="Nome" value={item.name} />
        <DetailRow label="Status" value={PLANNING_STATUS_LABELS[item.status]} />
        <DetailRow label="Progresso" value={`${Math.round(item.progress)}%`} />
        <DetailRow label="Início" value={formatPlanningDate(item.start)} />
        <DetailRow label="Fim" value={formatPlanningDate(item.end)} />
        <DetailRow label="Nível" value={String(item.level + 1)} />
        {parentName ? <DetailRow label="Pai" value={parentName} /> : null}
      </div>
    </div>
  );
}
