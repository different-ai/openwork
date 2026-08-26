/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";

import type { OpenworkServerClient, OpenworkWorkspaceCatalogEntry } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

export type WorkspaceFileAction = {
  id: string;
  label: string;
  run: (entry: OpenworkWorkspaceCatalogEntry) => void;
};

type WorkspaceFileTreeProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  workspaceName: string;
  selectedPath: string;
  onOpenFile: (entry: OpenworkWorkspaceCatalogEntry) => void;
  fileActions?: readonly WorkspaceFileAction[];
};

/**
 * Pierre slots context-menu content into the tree host's light DOM, so the
 * document stylesheet (Tailwind) applies. Built imperatively because the
 * composition API expects a plain HTMLElement.
 */
function buildFileContextMenu(
  entry: OpenworkWorkspaceCatalogEntry,
  actions: readonly WorkspaceFileAction[],
  close: () => void,
) {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.className = "bg-popover text-popover-foreground min-w-36 rounded-lg border border-border p-1 shadow-md";
  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.className = "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex w-full items-center rounded-md px-2 py-1.5 text-start text-xs outline-none";
    item.textContent = action.label;
    item.addEventListener("click", () => {
      close();
      action.run(entry);
    });
    menu.appendChild(item);
  }
  return menu;
}

function treePath(entry: OpenworkWorkspaceCatalogEntry) {
  return entry.kind === "dir" ? `${entry.path}/` : entry.path;
}

export function WorkspaceFileTree({ client, workspaceId, workspaceName, selectedPath, onOpenFile, fileActions }: WorkspaceFileTreeProps) {
  const query = useQuery({
    queryKey: ["workspace-file-tree", workspaceId] as const,
    queryFn: () => client.listWorkspaceFiles(workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const entries = query.data?.items ?? [];
  const entriesByPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const entriesByPathRef = useRef(entriesByPath);
  entriesByPathRef.current = entriesByPath;
  const fileActionsRef = useRef(fileActions);
  fileActionsRef.current = fileActions;
  const paths = useMemo(() => entries.map(treePath), [entries]);
  const { model } = useFileTree({
    // useFileTree captures options on first render, so callbacks read refs.
    composition: {
      contextMenu: {
        triggerMode: "both",
        buttonVisibility: "when-needed",
        render: (item, context) => {
          if (item.kind !== "file") return null;
          const entry = entriesByPathRef.current.get(item.path.replace(/\/$/, ""));
          const actions = fileActionsRef.current ?? [];
          if (!entry || entry.kind !== "file" || actions.length === 0) return null;
          return buildFileContextMenu(entry, actions, () => context.close());
        },
      },
    },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths.at(-1)?.replace(/\/$/, "");
      const entry = path ? entriesByPathRef.current.get(path) : undefined;
      if (entry?.kind === "file") onOpenFile(entry);
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_CSS,
  });
  const search = useFileTreeSearch(model);

  useEffect(() => model.resetPaths(paths), [model, paths]);

  useEffect(() => {
    const selected = model.getItem(selectedPath);
    if (!selected) return;
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
    selected.select();
  }, [model, paths, selectedPath]);

  return (
    <aside
      className="flex h-full min-h-0 w-40 shrink-0 flex-col border-r border-border bg-muted/20"
      data-workspace-file-tree
      data-workspace-file-count={entries.length}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <InputGroup className="h-7 min-w-0 flex-1 bg-background">
          <InputGroupAddon align="inline-start"><Search /></InputGroupAddon>
          <InputGroupInput
            aria-label={`Search ${workspaceName} files`}
            placeholder="Search files"
            value={search.value}
            onChange={(event) => {
              const value = event.target.value;
              if (value.trim()) search.setValue(value);
              else search.close();
            }}
          />
        </InputGroup>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh workspace files"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={cn(query.isFetching && "animate-spin")} />
        </Button>
      </div>
      {query.isError ? (
        <p className="p-3 text-xs text-destructive">Could not load workspace files.</p>
      ) : (
        <FileTree
          model={model}
          aria-label={`${workspaceName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{ ["--trees-fg-override" as string]: "var(--foreground)" }}
        />
      )}
      {query.data?.truncated ? (
        <p className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">Showing the first 10,000 entries</p>
      ) : null}
    </aside>
  );
}
