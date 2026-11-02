/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";
import {
  TaskSelectionSelects,
  useTaskSelection,
  type TaskSelection,
} from "@/react-app/domains/projects/task-selection";

const REFERENCES_DIR = "context/design/referencias/";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

function isImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

const DESIGN_TEMPLATES = [
  {
    title: "Logo e identidad",
    description: "Marca, paleta y tipografía a partir de una descripción del producto.",
    prompt: "Diseña la identidad visual del producto que te describa a continuación: logotipo, paleta de colores, tipografía y reglas de uso. Preséntalo como un documento de marca con ejemplos.",
  },
  {
    title: "Landing de producto",
    description: "Estructura, copy y jerarquía visual de una página de aterrizaje.",
    prompt: "Diseña una landing de producto completa: estructura, copy y jerarquía visual. Entrega el HTML/CSS de la página como artefacto y explica las decisiones de diseño.",
  },
  {
    title: "Rediseño de pantalla",
    description: "Toma una pantalla existente y propone variantes con rationale.",
    prompt: "Rediseña la pantalla que te indique a continuación: propón dos variantes con rationale de cada decisión (jerarquía, espaciado, color, tipografía) y entrégalas como artefactos comparables.",
  },
  {
    title: "Sistema de componentes",
    description: "Tokens, componentes base y reglas de uso en un documento.",
    prompt: "Define un sistema de componentes para este proyecto: tokens de color y tipografía, espaciado, radios, estados y los componentes base. Entrega un documento con las reglas de uso.",
  },
];

type DesignPageProps = {
  workspace: RouteWorkspace;
  openworkServerClient: OpenworkServerClient | null;
  agents: string[];
  providerCatalog: ProviderCatalog;
  connectedProviderIds: string[];
  onSend: (prompt: string, selection: TaskSelection) => void;
};

export function DesignPage({
  workspace,
  openworkServerClient: client,
  agents,
  providerCatalog,
  connectedProviderIds,
  onSend,
}: DesignPageProps) {
  const queryClient = useQueryClient();
  const selection = useTaskSelection(providerCatalog, connectedProviderIds);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const workspaceId = workspace.id;

  const referencesQuery = useQuery({
    queryKey: ["design-references", workspaceId],
    queryFn: async () => {
      if (!client || !workspaceId) return [];
      const result = await client.listWorkspaceFiles(workspaceId);
      return (result.items ?? [])
        .filter((file) => file.kind === "file" && file.path.startsWith(REFERENCES_DIR) && isImage(file.path))
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 30_000,
  });

  const references = referencesQuery.data ?? [];

  const upload = async (files: FileList | null) => {
    if (!client || !workspaceId || !files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const dot = file.name.lastIndexOf(".");
        const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
        const safeStem = (dot >= 0 ? file.name.slice(0, dot) : file.name)
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, "-")
          .replace(/^-+|-+$/g, "") || "referencia";
        const path = `${REFERENCES_DIR}${Date.now()}-${safeStem}${extension || ".png"}`;
        await client.writeWorkspaceBinaryFile(workspaceId, {
          path,
          data: await file.arrayBuffer(),
        });
      }
      toast.success("Referencias añadidas al proyecto");
      await queryClient.invalidateQueries({ queryKey: ["design-references", workspaceId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudieron subir las referencias.");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (path: string) => {
    if (!client || !workspaceId) return;
    try {
      await client.deleteWorkspaceFiles(workspaceId, [{ path }]);
      await queryClient.invalidateQueries({ queryKey: ["design-references", workspaceId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo borrar la referencia.");
    }
  };

  const startDesignTask = (prompt: string) => {
    onSend(prompt, {
      model: selection.selectedModel,
      variant: selection.selectedModel ? selection.variant : null,
      agent: selection.agent,
    });
  };

  const clonePrompt = (path: string) =>
    `Clona el estilo visual de la referencia en ${path} de este proyecto: extrae su paleta, tipografía, radios, espaciado y patrones de componentes, y genera una página de ejemplo aplicándolos con fidelidad. Entrega el resultado como artefacto y resume el sistema de estilo extraído.`;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-4 px-10 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Design</h1>
        <div className="flex items-center gap-2">
          <TaskSelectionSelects
            modelGroups={selection.modelGroups}
            selectedModel={selection.selectedModel}
            selectModel={selection.selectModel}
            variant={selection.variant}
            setVariant={selection.setVariant}
            variantOptions={selection.variantOptions}
            agent={selection.agent}
            setAgent={selection.setAgent}
            agents={agents}
          />
        </div>
      </div>
      <p className="px-10 pt-1 text-xs text-muted-foreground">
        Captura referencias (Refero, Designeer o cualquier web), súbelas aquí y pide al agente que clonen su estilo.
      </p>

      <div className="px-10 pt-6 pb-10">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">
            Referencias {references.length > 0 ? `(${references.length})` : ""}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              void upload(event.target.files);
              event.target.value = "";
            }}
          />
          <Button size="sm" disabled={uploading || !client} onClick={() => fileInputRef.current?.click()}>
            <ImagePlus className="size-4" aria-hidden />
            {uploading ? "Subiendo…" : "Agregar referencia"}
          </Button>
        </div>

        {referencesQuery.isPending ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : references.length === 0 ? (
          <Empty variant="ghost" className="rounded-xl border border-dashed border-border">
            <EmptyHeader>
              <EmptyMedia>
                <Sparkles className="size-6 text-muted-foreground" aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Sin referencias todavía</EmptyTitle>
              <EmptyDescription>
                Guarda pantallazos de interfaces que te gusten (Refero, Designeer, productos reales) y súbelos.
                Cada referencia se guarda en el proyecto y el agente puede leerla para clonar su estilo.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {references.map((reference) => (
              <ReferenceCard
                key={reference.path}
                client={client}
                workspaceId={workspaceId}
                path={reference.path}
                onClone={() => startDesignTask(clonePrompt(reference.path))}
                onDelete={() => void remove(reference.path)}
              />
            ))}
          </div>
        )}

        <p className="mt-8 mb-2 text-sm font-medium text-muted-foreground">Plantillas</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {DESIGN_TEMPLATES.map((template) => (
            <button
              key={template.title}
              type="button"
              onClick={() => startDesignTask(template.prompt)}
              className="rounded-lg border border-border p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
            >
              <p className="text-sm font-medium text-foreground">{template.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReferenceCard({ client, workspaceId, path, onClone, onDelete }: {
  client: OpenworkServerClient | null;
  workspaceId: string;
  path: string;
  onClone: () => void;
  onDelete: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const previewQuery = useQuery({
    queryKey: ["design-reference-preview", workspaceId, path],
    queryFn: async () => {
      if (!client) return null;
      const result = await client.downloadWorkspaceFile(workspaceId, path);
      const dot = path.lastIndexOf(".");
      const mime = MIME_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? result.contentType ?? "application/octet-stream";
      return URL.createObjectURL(new Blob([result.data], { type: mime }));
    },
    enabled: Boolean(client && workspaceId),
    staleTime: Infinity,
  });

  useEffect(() => {
    const url = previewQuery.data;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [previewQuery.data]);

  return (
    <div className="group overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex h-32 items-center justify-center overflow-hidden bg-muted/40">
        {previewQuery.isPending ? (
          <Skeleton className="h-full w-full" />
        ) : previewQuery.data ? (
          <img src={previewQuery.data} alt={name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="text-xs text-muted-foreground">Sin vista previa</span>
        )}
      </div>
      <div className="flex items-center gap-1 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={path}>{name}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={onClone}
          disabled={!client}
        >
          Clonar
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-red-600"
          aria-label={`Borrar ${name}`}
          onClick={onDelete}
          disabled={!client}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
