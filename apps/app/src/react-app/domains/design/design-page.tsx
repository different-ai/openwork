/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { Brush, FileCode2, Sparkles } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";

const DESIGN_TEMPLATES = [
  { title: "Logo e identidad", description: "Marca, paleta y tipografía a partir de una descripción del producto." },
  { title: "Landing de producto", description: "Estructura, copy y jerarquía visual de una página de aterrizaje." },
  { title: "Rediseño de pantalla", description: "Toma una pantalla existente y propone variantes con rationale." },
  { title: "Sistema de componentes", description: "Tokens, componentes base y reglas de uso en un documento." },
];

type DesignPageProps = {
  openworkServerClient: OpenworkServerClient | null;
  projectPath: string;
};

export function DesignPage({ openworkServerClient: client, projectPath }: DesignPageProps) {
  const catalogQuery = useQuery({
    queryKey: ["design-agent-catalog", projectPath],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.getCodeSessionCatalog("claude-code", projectPath);
    },
    enabled: Boolean(client && projectPath),
    staleTime: 60_000,
  });

  const agents = catalogQuery.data?.agents ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Design</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Modalidades de agente (AGENTS/*.md) y plantillas para trabajo de diseño.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Modalidad</p>
        {catalogQuery.isPending ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : catalogQuery.isError || agents.length === 0 ? (
          <Empty variant="ghost">
            <EmptyHeader>
              <EmptyMedia>
                <FileCode2 className="size-6 text-muted-foreground" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Sin agentes definidos</EmptyTitle>
              <EmptyDescription>
                Añade ficheros .md en la carpeta AGENTS del proyecto (o en ~/.config/opencode/AGENTS)
                para definir modalidades como Musashi o un agente de diseño.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {agents.map((agent) => (
              <div key={agent} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">{agent}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Modo de trabajo definido en su fichero AGENTS/{agent}.md
                </p>
              </div>
            ))}
          </div>
        )}

        <p className="mt-6 mb-2 text-xs font-medium text-muted-foreground">Plantillas</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {DESIGN_TEMPLATES.map((template) => (
            <div key={template.title} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                {template.title === "Logo e identidad" ? (
                  <Sparkles className="size-4 shrink-0 text-amber-11" aria-hidden />
                ) : (
                  <Brush className="size-4 shrink-0 text-amber-11" aria-hidden />
                )}
                <p className="text-sm font-medium text-foreground">{template.title}</p>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
