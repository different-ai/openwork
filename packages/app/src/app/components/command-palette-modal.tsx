import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Search, X } from "lucide-solid";

import Button from "./button";
import { formatKeybindLabel } from "../utils/keybinds";

export type PaletteItem = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  keybind?: string;
  onSelect: () => void;
  onHighlight?: () => void;
};

export type PaletteGroup = {
  id: string;
  title: string;
  items: PaletteItem[];
};

export type CommandPaletteModalProps = {
  open: boolean;
  mode: "command" | "file";
  query: string;
  setQuery: (value: string) => void;
  groups: PaletteGroup[];
  onClose: () => void;
};

export default function CommandPaletteModal(props: CommandPaletteModalProps) {
  let searchInputRef: HTMLInputElement | undefined;
  const [activeIndex, setActiveIndex] = createSignal(0);

  const filteredGroups = createMemo(() => {
    const query = props.query.trim().toLowerCase();
    if (!query) return props.groups;
    return props.groups
      .map((group: PaletteGroup) => {
        const items = group.items.filter((item) => {
          const haystack = `${item.title} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase();
          return haystack.includes(query);
        });
        return { ...group, items };
      })
      .filter((group) => group.items.length > 0);
  });

  const flattenedItems = createMemo(() => filteredGroups().flatMap((group) => group.items));

  createEffect(() => {
    if (props.open) {
      setActiveIndex(0);
      requestAnimationFrame(() => searchInputRef?.focus());
    }
  });

  createEffect(() => {
    const item = flattenedItems()[activeIndex()];
    item?.onHighlight?.();
  });

  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current: number) => Math.min(current + 1, flattenedItems().length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current: number) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        const item = flattenedItems()[activeIndex()];
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        item.onSelect();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  const placeholder = () =>
    props.mode === "file" ? "Search files" : "Search commands or files";

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-5 border-b border-gray-6/50 flex items-center gap-3">
            <Search size={16} class="text-gray-10" />
            <input
              ref={(el) => (searchInputRef = el)}
              type="text"
              value={props.query}
              onInput={(event: InputEvent) => props.setQuery((event.currentTarget as HTMLInputElement).value)}
              placeholder={placeholder()}
              class="flex-1 bg-transparent text-sm text-gray-12 placeholder-gray-7 focus:outline-none"
            />
            <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
              <X size={16} />
            </Button>
          </div>

          <div class="p-4 space-y-5 overflow-y-auto">
            <Show
              when={filteredGroups().length}
              fallback={<div class="text-sm text-gray-9">No results found.</div>}
            >
              <For each={filteredGroups()}>
                {(group: PaletteGroup) => (
                  <div class="space-y-2">
                    <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-9">
                      {group.title}
                    </div>
                    <div class="space-y-1">
                      <For each={group.items}>
                        {(item: PaletteItem) => {
                          const isActive = createMemo(
                            () => flattenedItems()[activeIndex()]?.id === item.id,
                          );
                          return (
                            <button
                              type="button"
                              class={`w-full flex items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                isActive()
                                  ? "bg-gray-12/10 text-gray-12"
                                  : "text-gray-11 hover:bg-gray-12/5"
                              }`}
                              onMouseEnter={() => {
                                const index = flattenedItems().findIndex((entry) => entry.id === item.id);
                                if (index >= 0) setActiveIndex(index);
                                item.onHighlight?.();
                              }}
                              onMouseDown={(event: MouseEvent) => {
                                event.preventDefault();
                                item.onSelect();
                                props.onClose();
                              }}
                            >
                              <div class="min-w-0">
                                <div class="text-sm font-medium text-gray-12 truncate">{item.title}</div>
                                <Show when={item.description}>
                                  <div class="text-[11px] text-gray-9 truncate">{item.description}</div>
                                </Show>
                              </div>
                              <Show when={item.keybind}>
                                <span class="text-[10px] text-gray-9 uppercase tracking-wide border border-gray-6/60 rounded-lg px-2 py-1">
                                  {formatKeybindLabel(item.keybind!)}
                                </span>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
