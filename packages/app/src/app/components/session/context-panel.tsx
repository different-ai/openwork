import { For, Show } from "solid-js";
import { ChevronDown, Circle, File, Folder } from "lucide-solid";

export type ContextPanelProps = {
  activePlugins: string[];
  activePluginStatus: string | null;
  authorizedDirs: string[];
  workingFiles: string[];
  expanded: boolean;
  onToggle: () => void;
};

const humanizePlugin = (name: string) => {
  const cleaned = name
    .replace(/^@[^/]+\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b(opencode|plugin)\b/gi, "")
    .trim();
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();
};

export default function ContextPanel(props: ContextPanelProps) {
  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex-1 overflow-y-auto px-4 py-4">
        <div class="rounded-2xl border border-gray-6 bg-gray-2/30" id="sidebar-context">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={props.onToggle}
          >
            <span>Context</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${props.expanded ? "rotate-180" : ""}`.trim()}
            />
          </button>
          <Show when={props.expanded}>
            <div class="px-4 pb-4 pt-1 space-y-5">
              <Show when={props.activePlugins.length || props.activePluginStatus}>
                <div>
                  <div class="flex items-center justify-between text-[11px] uppercase tracking-wider text-gray-9 font-semibold mb-2">
                    <span>Active plugins</span>
                  </div>
                  <div class="space-y-2">
                    <Show
                      when={props.activePlugins.length}
                      fallback={
                        <div class="text-xs text-gray-9">
                          {props.activePluginStatus ?? "No plugins loaded."}
                        </div>
                      }
                    >
                      <For each={props.activePlugins}>
                        {(plugin) => (
                          <div class="flex items-center gap-2 text-xs text-gray-11">
                            <Circle size={6} class="text-green-9 fill-green-9" />
                            <span class="truncate">{humanizePlugin(plugin) || plugin}</span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Show>

              <div>
                <div class="flex items-center justify-between text-[11px] uppercase tracking-wider text-gray-9 font-semibold mb-2">
                  <span>Authorized folders</span>
                </div>
                <div class="space-y-2">
                  <For each={props.authorizedDirs.slice(0, 3)}>
                    {(folder) => (
                      <div class="flex items-center gap-2 text-xs text-gray-11">
                        <Folder size={12} class="text-gray-9" />
                        <span class="truncate" title={folder}>
                          {folder.split(/[/\\]/).pop()}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div>
                <div class="flex items-center justify-between text-[11px] uppercase tracking-wider text-gray-9 font-semibold mb-2">
                  <span>Working files</span>
                </div>
                <div class="space-y-2">
                  <Show
                    when={props.workingFiles.length}
                    fallback={<div class="text-xs text-gray-9">None yet.</div>}
                  >
                    <For each={props.workingFiles}>
                      {(file) => (
                        <div class="flex items-center gap-2 text-xs text-gray-11">
                          <File size={12} class="text-gray-9" />
                          <span class="truncate">{file}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
