import { For, Show, createSignal, onMount } from "solid-js";
import { ChevronRight, ChevronDown, File, Folder } from "lucide-solid";
import type { FileEntry } from "../lib/tauri";
import { fsReadDir } from "../lib/tauri";

interface FileTreeProps {
  workspacePath: string;
  expandedPaths: string[];
  selectedPath?: string;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
}

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
  expandedPaths: string[];
  selectedPath?: string;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FileTreeItem(props: FileTreeItemProps) {
  const isExpanded = () => props.expandedPaths.includes(props.entry.path);
  const isSelected = () => props.selectedPath === props.entry.path;
  const isDirectory = () => props.entry.type === "directory";

  const [children, setChildren] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(false);

  const loadChildren = async () => {
    if (!isDirectory() || children().length > 0) return;
    
    setLoading(true);
    try {
      const entries = await fsReadDir(props.entry.path);
      setChildren(entries);
    } catch (error) {
      console.error("Failed to load directory:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = () => {
    if (isDirectory()) {
      if (!isExpanded()) {
        loadChildren();
      }
      props.onToggleExpand(props.entry.path);
    }
  };

  const handleClick = () => {
    if (isDirectory()) {
      handleToggle();
    } else {
      props.onSelectFile(props.entry.path);
    }
  };

  // Load children if initially expanded
  onMount(() => {
    if (isDirectory() && isExpanded()) {
      loadChildren();
    }
  });

  return (
    <div>
      <div
        class={`flex items-center gap-1 px-2 py-1 cursor-pointer text-sm ${
          isSelected()
            ? "bg-dls-active text-dls-text"
            : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
        }`}
        style={{ "padding-left": `${props.depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        <Show when={isDirectory()}>
          <span class="w-4 h-4 flex items-center justify-center">
            <Show when={isExpanded()} fallback={<ChevronRight size={14} />}>
              <ChevronDown size={14} />
            </Show>
          </span>
        </Show>
        <Show when={!isDirectory()}>
          <span class="w-4" />
        </Show>

        <span class="w-4 h-4 flex items-center justify-center mr-1">
          <Show
            when={isDirectory()}
            fallback={<File size={14} class="text-dls-secondary" />}
          >
            <Folder size={14} class="text-amber-11" />
          </Show>
        </span>

        <span class="truncate">{props.entry.name}</span>

        <Show when={loading()}>
          <span class="ml-2 text-xs text-dls-secondary">Loading...</span>
        </Show>
      </div>

      <Show when={isDirectory() && isExpanded()}>
        <For each={children()}>
          {(child) => (
            <FileTreeItem
              entry={child}
              depth={props.depth + 1}
              expandedPaths={props.expandedPaths}
              selectedPath={props.selectedPath}
              onToggleExpand={props.onToggleExpand}
              onSelectFile={props.onSelectFile}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

export default function FileTree(props: FileTreeProps) {
  const [rootEntries, setRootEntries] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const rootPath = props.workspacePath?.trim();
      if (!rootPath) {
        setError("Workspace path is not available");
        setLoading(false);
        return;
      }
      setLoading(true);
      const entries = await fsReadDir(rootPath);
      setRootEntries(entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="text-sm">
      <Show when={loading()}>
        <div class="px-3 py-2 text-dls-secondary text-xs">Loading files...</div>
      </Show>

      <Show when={error()}>
        <div class="px-3 py-2 text-red-11 text-xs">{error()}</div>
      </Show>

      <Show when={!loading() && !error()}>
        <For each={rootEntries()}>
          {(entry) => (
            <FileTreeItem
              entry={entry}
              depth={0}
              expandedPaths={props.expandedPaths}
              selectedPath={props.selectedPath}
              onToggleExpand={props.onToggleExpand}
              onSelectFile={props.onSelectFile}
            />
          )}
        </For>

        <Show when={rootEntries().length === 0}>
          <div class="px-3 py-2 text-dls-secondary text-xs">Empty directory</div>
        </Show>
      </Show>
    </div>
  );
}
