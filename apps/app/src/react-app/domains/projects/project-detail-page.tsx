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
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { RouteSession, RouteWorkspace } from "@/react-app/shell/route-workspaces";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";
import { sentenceTime } from "@/react-app/lib/relative-time";
import { useAutomationListQuery, useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import { useTaskSelection, TaskSelectionSelects, type TaskSelection } from "@/react-app/domains/projects/task-selection";
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

export type ProjectTaskSelection = TaskSelection;

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
  const selection = useTaskSelection(providerCatalog, connectedProviderIds);
  const [openSection, setOpenSection] = useState<RailSection | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [attachedFolders, setAttachedFolders] = useState<string[]>([]);
  const [scheduledOpen, setScheduledOpen] = useState(false);

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

  // Candidate folders for the composer's folder attach: workspace directories,
  // excluding the noise. Attachment annotates the first prompt with explicit
  // context paths the agent should explore.
  const foldersQuery = useQuery({
    queryKey: ["project-folders", workspaceId],
    queryFn: async () => {
      if (!client || !workspaceId) return [];
      const result = await client.listWorkspaceFiles(workspaceId);
      const excluded = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".turbo", ".opencode", ".claude", "tmp"]);
      return (result.items ?? [])
        .filter((file) => {
          if (file.kind !== "dir") return false;
          const segment = file.path.slice(file.path.lastIndexOf("/") + 1);
          return !excluded.has(segment);
        })
        .map((file) => file.path)
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
        .slice(0, 60);
    },
    enabled: Boolean(client && workspaceId && folderPickerOpen),
    staleTime: 60_000,
  });

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const contextNote = attachedFolders.length > 0
      ? `\n\nContexto adicional: explora también estas carpetas del proyecto antes de responder: ${attachedFolders.join(", ")}.`
      : "";
    onSend(trimmed + contextNote, {
      model: selection.selectedModel,
      variant: selection.selectedModel ? selection.variant : null,
      agent: selection.agent,
    });
    setPrompt("");
    setAttachedFolders([]);
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
            {attachedFolders.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {attachedFolders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    onClick={() => setAttachedFolders((current) => current.filter((item) => item !== folder))}
                    className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/60"
                    title={`Quitar ${folder}`}
                  >
                    <Folder className="size-3 text-muted-foreground" aria-hidden />
                    <span className="max-w-48 truncate">{folder}</span>
                    <X className="size-3 text-muted-foreground" aria-hidden />
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setFolderPickerOpen((value) => !value)}
                  aria-expanded={folderPickerOpen}
                >
                  <Paperclip className="size-4" aria-hidden />
                  Agregar carpeta
                </Button>
                {folderPickerOpen ? (
                  <div className="absolute bottom-9 left-0 z-20 max-h-56 w-72 overflow-y-auto rounded-lg border border-border bg-background p-2 shadow-lg">
                    {foldersQuery.isPending ? (
                      <Skeleton className="h-16 w-full" />
                    ) : (foldersQuery.data ?? []).length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">Sin carpetas en el proyecto.</p>
                    ) : (
                      <ul>
                        {(foldersQuery.data ?? []).map((folder) => (
                          <li key={folder}>
                            <button
                              type="button"
                              disabled={attachedFolders.includes(folder)}
                              onClick={() => {
                                setAttachedFolders((current) => [...current, folder]);
                                setFolderPickerOpen(false);
                              }}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/60 disabled:opacity-40"
                            >
                              <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="truncate">{folder}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
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
                onClick={() => setScheduledOpen((value) => !value)}
                className="flex w-full items-center justify-between gap-3 py-3.5 text-left"
                aria-expanded={scheduledOpen}
              >
                <span className="flex items-center gap-3 text-sm text-foreground">
                  <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                  Programado
                </span>
                <span className="text-sm text-muted-foreground">
                  {scheduledOpen ? "Cerrar" : "Agregar"}
                </span>
              </button>
              {scheduledOpen ? (
                <WorkspaceScheduled workspaceId={workspace.id} onOpenScheduled={onOpenScheduled} />
              ) : null}
            </li>
          </ul>
          <p className="pt-3 text-xs text-muted-foreground">Privado</p>
        </div>
      </div>
    </div>
  );
}

/** Automations pinned to this workspace (Den), listed inside the project's
 * scheduled rail row. "Agregar" sends the user to the global Programadas
 * section, where automation creation lives. */
function WorkspaceScheduled({ workspaceId, onOpenScheduled }: {
  workspaceId: string;
  onOpenScheduled: () => void;
}) {
  const denContext = useAutomationsDenContext();
  const listQuery = useAutomationListQuery(denContext);

  if (!denContext.ready) {
    return (
      <div className="pb-4">
        <p className="text-xs text-muted-foreground">
          Las tareas programadas requieren sesión en Den.{" "}
          <button type="button" className="underline" onClick={onOpenScheduled}>Abrir Programadas</button>
        </p>
      </div>
    );
  }
  if (listQuery.isPending) {
    return <div className="pb-4"><Skeleton className="h-12 w-full" /></div>;
  }
  if (listQuery.isError) {
    return <p className="pb-4 text-xs text-muted-foreground">Las tareas no se pudieron leer.</p>;
  }
  const pinned = (listQuery.data?.items ?? [])
    .filter((item) => item.revision.workspaceId === workspaceId && item.automation.state !== "archived");
  if (pinned.length === 0) {
    return (
      <div className="pb-4">
        <p className="text-xs text-muted-foreground">
          Sin tareas fijadas a este proyecto.{" "}
          <button type="button" className="underline" onClick={onOpenScheduled}>Crear una</button>
        </p>
      </div>
    );
  }
  return (
    <ul className="pb-4 flex flex-col gap-1">
      {pinned.map((item) => (
        <li key={item.automation.id} className="text-xs">
          <p className="truncate text-foreground">{item.automation.name}</p>
          <p className="text-muted-foreground">
            {item.automation.nextDueAt
              ? `Próxima: ${new Date(item.automation.nextDueAt).toLocaleString()}`
              : "Sin próxima ejecución"}
          </p>
        </li>
      ))}
    </ul>
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
