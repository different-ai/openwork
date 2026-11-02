/** @jsxImportSource react */
import { useState } from "react";
import { CircleAlert, Pause, Play, Timer } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { AutomationSchedule } from "@openwork/types/automations";
import {
  useAutomationListQuery,
  useAutomationsDenContext,
} from "@/react-app/domains/automations/use-automations";

const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

function timeLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function scheduleLabel(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case "once":
      return `Una vez · ${new Date(schedule.at).toLocaleString()}`;
    case "daily":
      return `Diario · ${timeLabel(schedule.hour, schedule.minute)}`;
    case "weekly": {
      const days = schedule.daysOfWeek.map((day) => DAY_NAMES[day] ?? String(day)).join(", ");
      return `Semanal · ${days} ${timeLabel(schedule.hour, schedule.minute)}`;
    }
    case "interval":
      return `Cada ${schedule.everyHours} h`;
    case "calendar":
      return "Alrededor de reuniones";
  }
}

const TEMPLATES = [
  { title: "Resumen diario", description: "Lo que necesita tu atención hoy en el calendario, el correo y los mensajes." },
  { title: "Preparación de reunión", description: "Un resumen antes de cada reunión con información sobre los asistentes y la agenda." },
  { title: "Clasificación de bandeja", description: "Categoriza tu bandeja de entrada y redacta respuestas a lo urgente." },
  { title: "Seguimiento de tema", description: "Monitorea noticias o menciones de un tema, competidor o área." },
];

type ProgramadasPageProps = {
  workspaceName: string;
};

export function ProgramadasPage({ workspaceName }: ProgramadasPageProps) {
  const denContext = useAutomationsDenContext();
  const listQuery = useAutomationListQuery(denContext);
  const [showTemplates, setShowTemplates] = useState(true);

  const items = listQuery.data?.items ?? [];
  const visible = items
    .filter((item) => item.automation.state !== "archived")
    .sort((a, b) => (a.automation.nextDueAt ?? Infinity) - (b.automation.nextDueAt ?? Infinity));
  const activeCount = visible.filter((item) => item.automation.state === "active").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Programadas</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {denContext.ready
              ? `${activeCount} activa${activeCount === 1 ? "" : "s"}${workspaceName ? ` en ${workspaceName}` : ""}`
              : "Inicia sesión en Den para ver y crear tareas programadas."}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!denContext.ready ? (
          <Empty variant="ghost">
            <EmptyHeader>
              <EmptyMedia>
                <Timer className="size-6 text-muted-foreground" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Tareas programadas</EmptyTitle>
              <EmptyDescription>
                Configura tareas que los agentes ejecutan periódicamente por ti. Requiere sesión en Den.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : listQuery.isPending ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : listQuery.isError ? (
          <p className="text-sm text-muted-foreground">Las tareas no se pudieron leer.</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col gap-6">
            <Empty variant="ghost">
              <EmptyHeader>
                <EmptyMedia>
                  <Timer className="size-6 text-muted-foreground" aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No hay tareas programadas</EmptyTitle>
                <EmptyDescription>
                  Crea una desde la página de Automations para que un agente trabaje por ti periódicamente.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
            {showTemplates ? (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Plantillas</p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {TEMPLATES.map((template) => (
                    <div key={template.title} className="rounded-lg border border-border p-3">
                      <p className="text-sm font-medium text-foreground">{template.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((item) => {
              const state = item.automation.state;
              return (
                <li key={item.automation.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    {state === "needs_attention" ? (
                      <CircleAlert className="size-4 shrink-0 text-amber-11" aria-hidden />
                    ) : state === "active" ? (
                      <Play className="size-4 shrink-0 text-green-11" aria-hidden />
                    ) : (
                      <Pause className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {item.automation.name}
                    </p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {scheduleLabel(item.revision.schedule)}
                    </span>
                  </div>
                  <p className="mt-1 pl-6 text-xs text-muted-foreground">
                    {item.automation.nextDueAt
                      ? `Próxima ejecución: ${new Date(item.automation.nextDueAt).toLocaleString()}`
                      : "Sin próxima ejecución programada"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
