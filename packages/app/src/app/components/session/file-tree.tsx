import { For, Show, createMemo } from "solid-js";
import { ChevronDown, File, Folder, GitBranch } from "lucide-solid";

import type { FileStatusEntry, FileTreeNode } from "../../types";

export type FileTreeProps = {
  rootLabel: string;
  entries: Record<string, FileTreeNode[]>;
  expanded: Set<string>;
  loading: Set<string>;
  statusMap: Record<string, FileStatusEntry>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
};

const sortEntries = (list: FileTreeNode[]) =>
  list
    .filter((entry) => !entry.ignored)
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

export default function FileTree(props: FileTreeProps) {
  const rootEntries = createMemo(() => sortEntries(props.entries[""] ?? []));

  const statusBadge = (path: string) => {
    const status = props.statusMap[path];
    if (!status) return null;
    if (status.status === "added") return "bg-green-9";
    if (status.status === "deleted") return "bg-red-9";
    return "bg-amber-9";
  };

  const renderNode = (entry: FileTreeNode, depth: number) => {
    const isDir = entry.type === "directory";
    const isExpanded = () => props.expanded.has(entry.path);
    const children = createMemo(() => sortEntries(props.entries[entry.path] ?? []));

    return (
      <div>
        <button
          type="button"
          class={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-gray-11 hover:bg-gray-12/5 ${
            isDir ? "font-medium" : "font-normal"
          }`}
          style={{ "padding-left": `${depth * 12 + 8}px` }}
          onClick={() => {
            if (isDir) {
              props.onToggleDir(entry.path);
            } else {
              props.onOpenFile(entry.path);
            }
          }}
        >
          <Show
            when={isDir}
            fallback={<File size={12} class="text-gray-9" />}
          >
            <ChevronDown
              size={12}
              class={`text-gray-9 transition-transform ${isExpanded() ? "rotate-180" : ""}`}
            />
            <Folder size={12} class="text-gray-9" />
          </Show>
          <span class="truncate">{entry.name}</span>
          <Show when={statusBadge(entry.path)}>
            <span class={`ml-auto h-2 w-2 rounded-full ${statusBadge(entry.path)}`} />
          </Show>
        </button>
        <Show when={isDir && isExpanded()}>
          <div class="space-y-0.5">
            <Show
              when={!props.loading.has(entry.path)}
              fallback={
                <div class="text-[11px] text-gray-8 px-4 py-1">Loading...</div>
              }
            >
              <For each={children()}>{(child) => renderNode(child, depth + 1)}</For>
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
      <div class="flex items-center justify-between px-4 py-3 text-sm text-gray-12 font-medium">
        <span>Files</span>
        <GitBranch size={14} class="text-gray-8" />
      </div>
      <div class="px-2 pb-3 space-y-1">
        <div class="text-[10px] uppercase tracking-wider text-gray-9 font-semibold px-2 pb-1">
          {props.rootLabel}
        </div>
        <Show
          when={rootEntries().length}
          fallback={<div class="text-xs text-gray-9 px-3 py-2">No files found.</div>}
        >
          <For each={rootEntries()}>{(entry) => renderNode(entry, 1)}</For>
        </Show>
      </div>
    </div>
  );
}
