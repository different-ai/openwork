/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Folder, MemoryStick, ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { cn } from "@/lib/utils";

type ProjectTab = "instructions" | "context" | "memory";

const TABS: Array<{ id: ProjectTab; label: string; icon: typeof ScrollText; description: string }> = [
  { id: "instructions", label: "Instrucciones", icon: ScrollText, description: "AGENTS.md — instrucciones del agente para este proyecto" },
  { id: "context", label: "Contexto", icon: Folder, description: "Ficheros de contexto que el agente lee al arrancar" },
  { id: "memory", label: "Memoria", icon: MemoryStick, description: "MEMORY.md — notas persistentes del agente" },
];

type ProjectsPageProps = {
  openworkServerClient: OpenworkServerClient | null;
  workspaceId: string;
  workspaceName: string;
};

export function ProjectsPage({ openworkServerClient: client, workspaceId, workspaceName }: ProjectsPageProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ProjectTab>("instructions");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filePath = tab === "instructions" ? "AGENTS.md" : tab === "memory" ? "MEMORY.md" : null;

  const fileQuery = useQuery({
    queryKey: ["project-file", workspaceId, filePath],
    queryFn: async () => {
      if (!client || !filePath || !workspaceId) return null;
      try {
        const result = await client.readWorkspaceFile(workspaceId, filePath);
        return typeof result.content === "string" ? result.content : "";
      } catch {
        // A missing file is the same as an empty one for editing purposes.
        return "";
      }
    },
    enabled: Boolean(client && filePath && workspaceId),
  });

  const contextQuery = useQuery({
    queryKey: ["project-context", workspaceId],
    queryFn: async () => {
      if (!client || !workspaceId) return [];
      const result = await client.listWorkspaceFiles(workspaceId);
      return (result.items ?? []).filter((file) => file.path.startsWith("context/"));
    },
    enabled: Boolean(client && workspaceId && tab === "context"),
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

  const content = fileQuery.data ?? "";
  const isDirty = draft !== null && draft !== content;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">{workspaceName || "Proyecto"}</h2>
      </div>
      <div className="flex gap-1 border-b border-border px-6 pt-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { setTab(entry.id); setDraft(null); }}
            className={cn(
              "flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm",
              tab === entry.id
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <entry.icon className="size-4" aria-hidden />
            {entry.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === "context" ? (
          <ContextSection query={contextQuery} />
        ) : (
          <FileEditor
            title={TABS.find((entry) => entry.id === tab)?.description ?? ""}
            content={content}
            draft={draft}
            onDraftChange={setDraft}
            isPending={fileQuery.isPending}
            isDirty={isDirty}
            isSaving={saving}
            filePath={filePath ?? ""}
            onSave={() => filePath && void save(filePath, draft ?? content)}
          />
        )}
      </div>
    </div>
  );
}

function FileEditor({
  title, content, draft, onDraftChange, isPending, isDirty, isSaving, filePath, onSave,
}: {
  title: string;
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
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <Textarea
        value={draft ?? content}
        onChange={(event) => onDraftChange(event.target.value)}
        className="min-h-80 resize-y font-mono text-sm"
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
    return <Skeleton className="h-32 w-full" />;
  }
  const files = query.data ?? [];
  if (files.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          No hay ficheros de contexto. Añade ficheros a la carpeta <code className="rounded bg-muted px-1 text-xs">context/</code> del proyecto y el agente los leerá al arrancar.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.path} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted/60">
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {file.path}
        </li>
      ))}
    </ul>
  );
}
