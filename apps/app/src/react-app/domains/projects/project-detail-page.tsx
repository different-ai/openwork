/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  CalendarClock,
  FileText,
  Folder,
  MemoryStick,
  Paperclip,
  ScrollText,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "@/app/lib/model-behavior";
import type { ModelRef } from "@/app/types";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { RouteSession, RouteWorkspace } from "@/react-app/shell/route-workspaces";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";
import { sentenceTime } from "@/react-app/lib/relative-time";
import { cn } from "@/lib/utils";

type RailSection = "instructions" | "context" | "memory";

const RAIL_SECTIONS: Array<{ id: RailSection; label: string; icon: typeof ScrollText; description: string }> = [
  { id: "instructions", label: "Instrucciones", icon: ScrollText, description: "AGENTS.md — instrucciones del agente para este proyecto" },
  { id: "context", label: "Contexto", icon: Folder, description: "Ficheros que el agente lee al arrancar (carpeta context/)" },
  { id: "memory", label: "Memoria", icon: MemoryStick, description: "MEMORY.md — notas persistentes del agente" },
];

const SECTION_FILE: Record<RailSection, string | null> = {
  instructions: "AGENTS.md",
  context: null,
  memory: "MEMORY.md",
};

export type ProjectTaskSelection = {
  model: ModelRef | null;
  variant: string | null;
  agent: string | null;
};

type ProjectDetailPageProps = {
  workspace: RouteWorkspace;
  openworkServerClient: OpenworkServerClient | null;
  sessions: RouteSession[];
  /** Agent names from the engine's app.agents(), like the main composer offers. */
  agents: string[];
  /** The route's provider catalog (provider → model metadata), for the model
   * picker and each model's thinking/effort options. */
  providerCatalog: ProviderCatalog;
  /** Provider ids the user can actually use, like the main model picker. */
  connectedProviderIds: string[];
  onSend: (prompt: string, selection: ProjectTaskSelection) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenScheduled: () => void;
};

export function ProjectDetailPage({
  workspace,
  openworkServerClient: client,
  sessions,
  agents,
  providerCatalog,
  connectedProviderIds,
  onSend,
  onOpenSession,
  onOpenScheduled,
}: ProjectDetailPageProps) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<RailSection | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const modelGroups = useMemo(() => connectedProviderIds
    .map((providerId) => ({ providerId, models: Object.keys(providerCatalog[providerId] ?? {}) }))
    .filter((group) => group.models.length > 0), [connectedProviderIds, providerCatalog]);

  // Thinking/reasoning options for the selected model, straight from the
  // model's behavior metadata — the same source the main composer's pill uses.
  const variantOptions = useMemo(() => {
    if (!selectedModel) return [] as Array<{ value: string; label: string }>;
    const model = providerCatalog[selectedModel.providerID]?.[selectedModel.modelID];
    const summary = getModelBehaviorSummary(
      selectedModel.providerID,
      model,
      sanitizeModelBehaviorValue(selectedModel.providerID, model, variant),
    );
    const options: Array<{ value: string; label: string }> = [];
    for (const option of summary.options ?? []) {
      if (typeof option.value === "string") options.push({ value: option.value, label: option.label });
    }
    return options;
  }, [providerCatalog, selectedModel, variant]);

  const workspaceId = workspace.id;
  const sectionFile = openSection ? SECTION_FILE[openSection] : null;

  const fileQuery = useQuery({
    queryKey: ["project-file", workspaceId, sectionFile],
    queryFn: async () => {
      if (!client || !sectionFile || !workspaceId) return "";
      try {
        const result = await client.readWorkspaceFile(workspaceId, sectionFile);
        return typeof result.content === "string" ? result.content : "";
      } catch {
        // A missing file is the same as an empty one for editing purposes.
        return "";
      }
    },
    enabled: Boolean(client && sectionFile && workspaceId && openSection !== null),
  });

  const contextQuery = useQuery({
    queryKey: ["project-context", workspaceId],
    queryFn: async () => {
      if (!client || !workspaceId) return [];
      const result = await client.listWorkspaceFiles(workspaceId);
      return (result.items ?? []).filter((file) => file.path.startsWith("context/"));
    },
    enabled: Boolean(client && workspaceId && openSection === "context"),
  });

  const save = useCallback(async (path: string, content: string) => {
    if (!client || !workspaceId) return;
    setSaving(true);
    try {
      await client.writeWorkspaceFile(workspaceId, { path, content });
      toast.success(`${path} guardado`);
      await queryClient.invalidateQueries({ queryKey: ["project-file", workspaceId, path] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }, [client, workspaceId, queryClient]);

  const recentSessions = useMemo(
    () => [...sessions]
      .filter((session) => !session.time?.archived)
      .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
      .slice(0, 12),
    [sessions],
  );

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSend(trimmed, {
      model: selectedModel,
      variant: selectedModel ? variant : null,
      agent,
    });
    setPrompt("");
  };

  const content = fileQuery.data ?? "";
  const isDirty = draft !== null && draft !== content;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-10 pt-8">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {workspace.displayNameResolved || "Proyecto"}
        </h1>
      </div>

      <div className="flex flex-1 gap-10 px-10 pt-6 pb-10">
        {/* Main column: composer + recents */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="rounded-2xl border border-border bg-muted/40 p-4 shadow-sm">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={`Nueva sesión en ${workspace.displayNameResolved || "este proyecto"}`}
              aria-label={`Nueva sesión en ${workspace.displayNameResolved || "este proyecto"}`}
              className="min-h-20 resize-none border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled title="Adjuntar carpetas (próximamente)">
                <Paperclip className="size-4" aria-hidden />
                Agregar carpeta
              </Button>
              <div className="flex items-center gap-2">
                <select
                  value={selectedModel ? `${selectedModel.providerID}|${selectedModel.modelID}` : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      setSelectedModel(null);
                      setVariant(null);
                      return;
                    }
                    const separator = value.indexOf("|");
                    setSelectedModel({ providerID: value.slice(0, separator), modelID: value.slice(separator + 1) });
                    setVariant(null);
                  }}
                  aria-label="Modelo"
                  className="h-7 max-w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  <option value="">Modelo predeterminado</option>
                  {modelGroups.map((group) => (
                    <optgroup key={group.providerId} label={group.providerId}>
                      {group.models.map((modelId) => (
                        <option key={modelId} value={`${group.providerId}|${modelId}`}>{modelId}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <select
                  value={variant ?? ""}
                  onChange={(event) => setVariant(event.target.value || null)}
                  disabled={!selectedModel || variantOptions.length === 0}
                  aria-label="Pensamiento"
                  title={!selectedModel ? "Elige un modelo para ajustar el pensamiento" : "Nivel de pensamiento"}
                  className="h-7 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
                >
                  <option value="">{selectedModel ? "Predeterminado" : "Pensamiento"}</option>
                  {variantOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <select
                  value={agent ?? ""}
                  onChange={(event) => setAgent(event.target.value || null)}
                  aria-label="Agente"
                  className="h-7 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  <option value="">Agente predeterminado</option>
                  {agents.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <Button
                  size="icon"
                  className="size-8 rounded-full"
                  disabled={!prompt.trim()}
                  onClick={submit}
                  aria-label="Enviar tarea"
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          </div>

          <p className="mt-8 mb-1 text-sm font-medium text-muted-foreground">Recientes</p>
          {recentSessions.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              Sin sesiones todavía. Escribe arriba para empezar una.
            </p>
          ) : (
            <ul className="flex flex-col">
              {recentSessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSession(session.id)}
                    className="flex w-full items-center justify-between gap-4 border-b border-border/60 py-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {session.title?.trim() || "Nueva sesión"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {sentenceTime(session.time?.updated ?? session.time?.created, Date.now())}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right rail */}
        <div className="w-72 shrink-0 pt-2">
          <ul className="flex flex-col">
            {RAIL_SECTIONS.map((section) => {
              const open = openSection === section.id;
              return (
                <li key={section.id} className="border-b border-border/60">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSection(open ? null : section.id);
                      setDraft(null);
                    }}
                    className="flex w-full items-center justify-between gap-3 py-3.5 text-left"
                    aria-expanded={open}
                  >
                    <span className="flex items-center gap-3 text-sm text-foreground">
                      <section.icon className="size-4 text-muted-foreground" aria-hidden />
                      {section.label}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {section.id === "memory" ? "Ver" : open ? "Cerrar" : "Agregar"}
                    </span>
                  </button>
                  {open ? (
                    <div className="pb-4">
                      {section.id === "context" ? (
                        <ContextSection query={contextQuery} />
                      ) : (
                        <RailFileEditor
                          description={section.description}
                          content={content}
                          draft={draft}
                          onDraftChange={setDraft}
                          isPending={fileQuery.isPending}
                          isDirty={isDirty}
                          isSaving={saving}
                          filePath={sectionFile ?? ""}
                          onSave={() => sectionFile && void save(sectionFile, draft ?? content)}
                        />
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
            <li className="border-b border-border/60">
              <button
                type="button"
                onClick={onOpenScheduled}
                className="flex w-full items-center justify-between gap-3 py-3.5 text-left"
              >
                <span className="flex items-center gap-3 text-sm text-foreground">
                  <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                  Programado
                </span>
                <span className="text-sm text-muted-foreground">Agregar</span>
              </button>
            </li>
          </ul>
          <p className="pt-3 text-xs text-muted-foreground">Privado</p>
        </div>
      </div>
    </div>
  );
}

function RailFileEditor({
  description, content, draft, onDraftChange, isPending, isDirty, isSaving, filePath, onSave,
}: {
  description: string;
  content: string;
  draft: string | null;
  onDraftChange: (value: string) => void;
  isPending: boolean;
  isDirty: boolean;
  isSaving: boolean;
  filePath: string;
  onSave: () => void;
}) {
  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{description}</p>
      <Textarea
        value={draft ?? content}
        onChange={(event) => onDraftChange(event.target.value)}
        className="min-h-40 resize-y bg-background font-mono text-xs"
        aria-label={filePath}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{filePath}</span>
        <Button size="sm" disabled={!isDirty || isSaving} onClick={onSave}>
          {isSaving ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}

function ContextSection({ query }: {
  query: { data?: Array<{ path: string }>; isPending: boolean };
}) {
  if (query.isPending) {
    return <Skeleton className="h-20 w-full" />;
  }
  const files = query.data ?? [];
  if (files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No hay ficheros de contexto. Añade ficheros a la carpeta{" "}
        <code className="rounded bg-muted px-1">context/</code> del proyecto y el agente los leerá al arrancar.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.path} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs text-foreground">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{file.path}</span>
        </li>
      ))}
    </ul>
  );
}
