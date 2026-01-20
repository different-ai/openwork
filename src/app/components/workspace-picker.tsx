import { For, Show, createMemo } from "solid-js";

import { Check, Plus, Search } from "lucide-solid";

import type { WorkspaceInfo } from "../lib/tauri";

export default function WorkspacePicker(props: {
  open: boolean;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onSelect: (workspaceId: string) => void;
  onCreateNew: () => void;
}) {
  const filtered = createMemo(() => {
    const query = props.search.trim().toLowerCase();
    if (!query) return props.workspaces;
    return props.workspaces.filter((w) => `${w.name} ${w.path}`.toLowerCase().includes(query));
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/20 backdrop-blur-[2px]"
        onClick={props.onClose}
      >
        <div
          class="bg-zinc-900 border border-zinc-800 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="p-2 border-b border-zinc-800">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-2.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Find workspace..."
                value={props.search}
                onInput={(e) => props.onSearch(e.currentTarget.value)}
                class="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-1.5 pl-9 pr-3 text-sm text-white focus:outline-none focus:border-zinc-700"
              />
            </div>
          </div>

          <div class="max-h-64 overflow-y-auto p-1">
            <div class="px-3 py-2 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              Workspaces
            </div>

            <For each={filtered()}>
              {(ws) => (
                <button
                  onClick={() => {
                    props.onSelect(ws.id);
                    props.onClose();
                  }}
                  class={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    props.activeWorkspaceId === ws.id
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
                  }`}
                >
                  <div class="flex-1 text-left min-w-0">
                    <div class="font-medium truncate">{ws.name}</div>
                    <div class="text-[10px] text-zinc-600 font-mono truncate max-w-[200px]">
                      {ws.path}
                    </div>
                  </div>
                  <Show when={props.activeWorkspaceId === ws.id}>
                    <Check size={14} class="text-indigo-400" />
                  </Show>
                </button>
              )}
            </For>
          </div>

          <div class="p-2 border-t border-zinc-800 bg-zinc-900">
            <button
              onClick={() => {
                props.onCreateNew();
                props.onClose();
              }}
              class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <Plus size={16} />
              New Workspace...
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
