import { For, Show, createEffect, createMemo } from "solid-js";

import { Check, Globe, Loader2, Plus, Search, Trash2, Upload } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import type { WorkspaceInfo } from "../lib/tauri";

export default function WorkspacePicker(props: {
  open: boolean;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  onSelect: (workspaceId: string) => Promise<boolean> | boolean | void;
  onCreateLocal: () => void;
  onCreateRemote: () => void;
  onImport: () => void;
  importing?: boolean;
  onForget: (workspaceId: string) => void;
  connectingWorkspaceId?: string | null;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const filtered = createMemo(() => {
    const query = props.search.trim().toLowerCase();
    if (!query) return props.workspaces;
    return props.workspaces.filter((w) =>
      `${w.name} ${w.path} ${w.baseUrl ?? ""} ${w.displayName ?? ""} ${w.directory ?? ""} ${
        w.openworkHostUrl ?? ""
      } ${w.openworkWorkspaceName ?? ""}`
        .toLowerCase()
        .includes(query)
    );
  });

  const totalCount = createMemo(() => props.workspaces.length);
  let searchInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => searchInputRef?.focus());
    }
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-gray-1/20 backdrop-blur-[2px]"
        onClick={props.onClose}
      >
        <div
          class="bg-gray-2 border border-gray-6 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="p-2 border-b border-gray-6">
            <div class="relative">
              <Search size={14} class="absolute left-3 top-2.5 text-gray-10" />
              <input
                ref={(el) => (searchInputRef = el)}
                type="text"
                placeholder={translate("dashboard.find_workspace")}
                value={props.search}
                onInput={(e) => props.onSearch(e.currentTarget.value)}
                class="w-full bg-gray-1 border border-gray-6 rounded-lg py-1.5 pl-9 pr-3 text-sm text-gray-12 focus:outline-none focus:border-gray-7"
              />
            </div>
          </div>

          <div class="max-h-64 overflow-y-auto p-1">
            <div class="px-3 py-2 text-[10px] font-semibold text-gray-10 uppercase tracking-wider">
              {translate("dashboard.workspaces")} ({totalCount()})
            </div>

            <For each={filtered()}>
              {(ws) => (
                <div
                  class={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    props.activeWorkspaceId === ws.id
                      ? "bg-gray-4 text-gray-12"
                      : "text-gray-11 hover:text-gray-12 hover:bg-gray-4/50"
                  }`}
                >
                  <button
                    onClick={() => {
                      const result = props.onSelect(ws.id);
                      if (result instanceof Promise) {
                        result.then((ok) => {
                          if (ok !== false) props.onClose();
                        });
                        return;
                      }
                      if (result !== false) props.onClose();
                    }}
                    class="flex-1 text-left min-w-0"
                  >
                    <div class="flex items-center gap-2">
                      <div class="font-medium truncate">{ws.name}</div>
                      <Show when={ws.workspaceType === "remote"}>
                        <span class="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gray-3 text-gray-11">
                          <Globe size={10} />
                          {translate("dashboard.remote")}
                        </span>
                        <span class="inline-flex items-center text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gray-2 text-gray-10">
                          {ws.remoteType === "openwork"
                            ? translate("dashboard.remote_connection_openwork")
                            : translate("dashboard.remote_connection_direct")}
                        </span>
                      </Show>
                    </div>
                    <div class="text-[10px] text-gray-7 font-mono truncate max-w-[200px]">
                      {ws.workspaceType === "remote"
                        ? ws.remoteType === "openwork"
                          ? ws.openworkHostUrl ?? ws.baseUrl ?? ws.path
                          : ws.baseUrl ?? ws.path
                        : ws.path}
                    </div>
                    <Show
                      when={
                        ws.workspaceType === "remote" &&
                        (ws.directory || ws.openworkWorkspaceName)
                      }
                    >
                      <div class="text-[10px] text-gray-8 truncate max-w-[200px]">
                        {ws.openworkWorkspaceName ?? ws.directory}
                      </div>
                    </Show>
                  </button>
                  <Show when={props.activeWorkspaceId === ws.id}>
                    <Check size={14} class="text-indigo-11" />
                  </Show>
                  <Show when={props.connectingWorkspaceId === ws.id}>
                    <Loader2 size={14} class="text-gray-10 animate-spin" />
                  </Show>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onForget(ws.id);
                    }}
                    class="p-1 rounded-md text-gray-9 hover:text-gray-12 hover:bg-gray-3 transition-colors"
                    title={translate("dashboard.forget_workspace")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>

          <div class="p-2 border-t border-gray-6 bg-gray-2">
            <div class="grid gap-2">
              <button
                onClick={() => {
                  props.onImport();
                  props.onClose();
                }}
                disabled={props.importing}
                class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <Upload size={16} />
                Import workspace config
              </button>
              <button
                onClick={() => {
                  props.onCreateLocal();
                  props.onClose();
                }}
                class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors"
              >
                <Plus size={16} />
                {translate("dashboard.new_workspace")}
              </button>
              <button
                onClick={() => {
                  props.onCreateRemote();
                  props.onClose();
                }}
                class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-11 hover:bg-gray-4 hover:text-gray-12 transition-colors"
              >
                <Globe size={16} />
                {translate("dashboard.new_remote_workspace")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
