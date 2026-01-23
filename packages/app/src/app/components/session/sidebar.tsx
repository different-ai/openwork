import { For, Show, createMemo } from "solid-js";
import { Check, ChevronDown, Circle, File, FileText, Folder, Plus } from "lucide-solid";

import type { ArtifactItem, TodoItem } from "../../types";

export type SidebarSectionState = {
  progress: boolean;
  artifacts: boolean;
  context: boolean;
};

export type SidebarProps = {
  todos: TodoItem[];
  artifacts: ArtifactItem[];
  activePlugins: string[];
  activePluginStatus: string | null;
  authorizedDirs: string[];
  workingFiles: string[];
  expandedSections: SidebarSectionState;
  onToggleSection: (section: keyof SidebarSectionState) => void;
  onOpenArtifact: (artifact: ArtifactItem) => void;
  sessions: Array<{ id: string; title: string; slug?: string | null }>;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  sessionStatusById: Record<string, string>;
  onCreateSession: () => void;
  newTaskDisabled: boolean;
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

export default function SessionSidebar(props: SidebarProps) {
  const realTodos = createMemo(() => props.todos.filter((todo) => todo.content.trim()));

  const progressDots = createMemo(() => {
    const activeTodos = realTodos();
    const total = activeTodos.length;
    if (!total) return [] as boolean[];
    const completed = activeTodos.filter((todo) => todo.status === "completed").length;
    return Array.from({ length: total }, (_, idx) => idx < completed);
  });

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="px-4 pt-4 shrink-0">
        <button
          class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-gray-12 text-gray-1 text-sm font-medium shadow-lg shadow-gray-12/10 hover:bg-gray-11 transition-colors"
          onClick={props.onCreateSession}
          disabled={props.newTaskDisabled}
        >
          <Plus size={16} />
          New task
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        <div>
          <div class="text-[10px] text-gray-9 uppercase tracking-widest font-semibold mb-3 px-2">Recents</div>
          <div class="space-y-1">
            <For each={props.sessions.slice(0, 8)}>
              {(session) => (
                <button
                  class={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    session.id === props.selectedSessionId
                      ? "bg-gray-3 text-gray-12 font-medium"
                      : "text-gray-11 hover:text-gray-12 hover:bg-gray-2"
                  }`}
                  onClick={() => props.onSelectSession(session.id)}
                >
                  <div class="flex items-center justify-between gap-2 w-full overflow-hidden">
                    <span class="truncate">{session.title}</span>
                    <Show
                      when={
                        props.sessionStatusById[session.id] &&
                        props.sessionStatusById[session.id] !== "idle"
                      }
                    >
                      <span
                        class={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 ${
                          props.sessionStatusById[session.id] === "running"
                            ? "border-amber-7/50 text-amber-11 bg-amber-2/50"
                            : "border-gray-7/50 text-gray-10 bg-gray-2/50"
                        }`}
                      >
                        <div
                          class={`w-1 h-1 rounded-full ${
                            props.sessionStatusById[session.id] === "running"
                              ? "bg-amber-9 animate-pulse"
                              : "bg-gray-9"
                          }`}
                        />
                      </span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="space-y-4">
          <Show when={realTodos().length > 0}>
            <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
              <button
                class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
                onClick={() => props.onToggleSection("progress")}
              >
                <span>Progress</span>
                <ChevronDown
                  size={16}
                  class={`transition-transform text-gray-10 ${
                    props.expandedSections.progress ? "rotate-180" : ""
                  }`.trim()}
                />
              </button>
              <Show when={props.expandedSections.progress}>
                <div class="px-4 pb-4 pt-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <For each={progressDots()}>
                      {(done) => (
                        <div
                          class={`h-6 w-6 rounded-full border flex items-center justify-center transition-colors ${
                            done
                              ? "border-green-6 bg-green-2 text-green-11"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                          }`}
                        >
                          <Show when={done}>
                            <Check size={14} />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
            <button
              class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
              onClick={() => props.onToggleSection("artifacts")}
            >
              <span>Artifacts</span>
              <ChevronDown
                size={16}
                class={`transition-transform text-gray-10 ${
                  props.expandedSections.artifacts ? "rotate-180" : ""
                }`.trim()}
              />
            </button>
            <Show when={props.expandedSections.artifacts}>
              <div class="px-4 pb-4 pt-1 space-y-3">
                <Show
                  when={props.artifacts.length}
                  fallback={<div class="text-xs text-gray-9 pl-1">No artifacts yet.</div>}
                >
                  <For each={props.artifacts}>
                    {(artifact) => (
                      <button
                        class="flex items-center gap-3 text-sm text-gray-11 hover:text-gray-12 w-full text-left group"
                        onClick={() => props.onOpenArtifact(artifact)}
                      >
                        <div class="h-8 w-8 rounded-lg bg-gray-3 group-hover:bg-gray-4 flex items-center justify-center transition-colors shrink-0">
                          <FileText size={16} class="text-gray-10 group-hover:text-gray-11" />
                        </div>
                        <div class="min-w-0">
                          <div class="truncate">{artifact.name}</div>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>

          <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
            <button
              class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
              onClick={() => props.onToggleSection("context")}
            >
              <span>Context</span>
              <ChevronDown
                size={16}
                class={`transition-transform text-gray-10 ${
                  props.expandedSections.context ? "rotate-180" : ""
                }`.trim()}
              />
            </button>
            <Show when={props.expandedSections.context}>
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
    </div>
  );
}
