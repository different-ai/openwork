import { For, Show, createMemo } from "solid-js";
import { Check, ChevronDown, Plus } from "lucide-solid";

import type { TodoItem } from "../../types";

export type SidebarSectionState = {
  progress: boolean;
  artifacts: boolean;
  context: boolean;
};

export type SidebarProps = {
  todos: TodoItem[];
  expandedSections: SidebarSectionState;
  onToggleSection: (section: keyof SidebarSectionState) => void;
  sessions: Array<{ id: string; title: string; slug?: string | null }>;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  sessionStatusById: Record<string, string>;
  onCreateSession: () => void;
  newTaskDisabled: boolean;
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
            <div class="rounded-2xl border border-gray-6 bg-gray-2/30" id="sidebar-progress">
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
        </div>
      </div>
    </div>
  );
}
