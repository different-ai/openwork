/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, FolderClosed, Pin, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { RouteSession, RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { relativeTime } from "@/react-app/lib/relative-time";
import { cn } from "@/lib/utils";

const PINNED_KEY = "openwork.projects.pinned";

function readPinnedIds(): string[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedIds(ids: string[]) {
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode): pins live for this session only.
  }
}

function latestActivityAt(sessions: RouteSession[] | undefined): number | null {
  let latest: number | null = null;
  for (const session of sessions ?? []) {
    const at = session.time?.updated ?? session.time?.created ?? 0;
    if (at > 0 && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

type SortMode = "recent" | "name";

type ProjectsIndexPageProps = {
  workspaces: RouteWorkspace[];
  sessionsByWorkspaceId: Record<string, RouteSession[]>;
  workspacesLoading: boolean;
  onOpenProject: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
};

export function ProjectsIndexPage({
  workspaces,
  sessionsByWorkspaceId,
  workspacesLoading,
  onOpenProject,
  onOpenCreateWorkspace,
}: ProjectsIndexPageProps) {
  const [filter, setFilter] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedIds());

  useEffect(() => {
    writePinnedIds(pinnedIds);
  }, [pinnedIds]);

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const decorated = workspaces.map((workspace) => ({
      workspace,
      pinned: pinnedIds.includes(workspace.id),
      activityAt: latestActivityAt(sessionsByWorkspaceId[workspace.id]),
    }));
    const filtered = query
      ? decorated.filter((row) => row.workspace.displayNameResolved.toLowerCase().includes(query))
      : decorated;
    return filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sortMode === "name") {
        return a.workspace.displayNameResolved.localeCompare(b.workspace.displayNameResolved);
      }
      const atA = a.activityAt ?? 0;
      const atB = b.activityAt ?? 0;
      if (atA !== atB) return atB - atA;
      return a.workspace.displayNameResolved.localeCompare(b.workspace.displayNameResolved);
    });
  }, [filter, pinnedIds, sessionsByWorkspaceId, sortMode, workspaces]);

  const togglePin = (id: string) => {
    setPinnedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-4 px-10 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Proyectos</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Buscar"
              aria-label="Buscar proyectos"
              className="h-8 w-44 pl-8"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={sortMode === "recent" ? "Ordenar por nombre" : "Ordenar por actividad"}
            title={sortMode === "recent" ? "Ordenar por nombre" : "Ordenar por actividad"}
            onClick={() => setSortMode((mode) => mode === "recent" ? "name" : "recent")}
          >
            <ArrowUpDown className="size-4" aria-hidden />
          </Button>
          <Button size="sm" onClick={onOpenCreateWorkspace}>
            <Plus className="size-4" aria-hidden />
            Nuevo proyecto
          </Button>
        </div>
      </div>

      <div className="px-10 pt-8 pb-10">
        {workspacesLoading ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {filter.trim() ? "Ningún proyecto coincide con la búsqueda." : "Aún no hay proyectos."}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {rows.map(({ workspace, pinned, activityAt }) => (
              <div
                key={workspace.id}
                className="group relative flex items-center gap-3 rounded-xl border border-transparent bg-muted/50 px-4 py-3.5 transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => onOpenProject(workspace.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted-foreground/15">
                    <FolderClosed className="size-4 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {workspace.displayNameResolved}
                    </span>
                    <span className="block text-xs text-muted-foreground">{relativeTime(activityAt, Date.now())}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(workspace.id)}
                  aria-label={pinned ? `Quitar fijado de ${workspace.displayNameResolved}` : `Fijar ${workspace.displayNameResolved}`}
                  title={pinned ? "Quitar fijado" : "Fijar"}
                  className={cn(
                    "shrink-0 rounded-md p-1.5 transition-opacity",
                    pinned
                      ? "text-foreground opacity-100"
                      : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <Pin className={cn("size-4", pinned && "fill-current")} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
