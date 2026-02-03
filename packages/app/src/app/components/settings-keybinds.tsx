import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import Button from "./button";
import { formatKeybindLabel, keybindFromEvent } from "../utils/keybinds";

export type KeybindSetting = {
  id: string;
  title: string;
  category?: string;
  description?: string;
  defaultKeybind?: string | null;
  overrideKeybind?: string | null;
  conflicts?: string[];
};

export type SettingsKeybindsProps = {
  items: KeybindSetting[];
  onOverride: (id: string, keybind: string | null) => void;
  onReset: (id: string) => void;
  onResetAll: () => void;
};

export default function SettingsKeybinds(props: SettingsKeybindsProps) {
  const [capturingId, setCapturingId] = createSignal<string | null>(null);

  const grouped = createMemo(() => {
    const groups = new Map<string, KeybindSetting[]>();
    for (const item of props.items) {
      const category = item.category ?? "General";
      const list = groups.get(category) ?? [];
      list.push(item);
      groups.set(category, list);
    }
    return Array.from(groups.entries()).map(([title, items]) => ({
      title,
      items: items.sort((a, b) => a.title.localeCompare(b.title)),
    }));
  });

  createEffect(() => {
    if (!capturingId()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!capturingId()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCapturingId(null);
        return;
      }
      const keybind = keybindFromEvent(event);
      if (!keybind) return;
      event.preventDefault();
      event.stopPropagation();
      props.onOverride(capturingId()!, keybind);
      setCapturingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  const hasOverrides = createMemo(() =>
    props.items.some((item) => item.overrideKeybind && item.overrideKeybind !== item.defaultKeybind),
  );

  return (
    <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-medium text-gray-12">Keybinds</div>
          <div class="text-xs text-gray-10">Customize global and session shortcuts.</div>
        </div>
        <Button variant="outline" disabled={!hasOverrides()} onClick={props.onResetAll}>
          Reset all
        </Button>
      </div>

      <div class="space-y-6">
        <For each={grouped()}>
          {(group: { title: string; items: KeybindSetting[] }) => (
            <div class="space-y-3">
              <div class="text-xs font-semibold uppercase tracking-wider text-gray-9">{group.title}</div>
              <div class="space-y-2">
                <For each={group.items}>
                  {(item: KeybindSetting) => {
                    const activeKeybind = () => item.overrideKeybind ?? item.defaultKeybind ?? null;
                    const conflictText = () =>
                      item.conflicts?.length
                        ? `Conflicts with ${item.conflicts.join(", ")}`
                        : null;
                    return (
                      <div class="bg-gray-1 border border-gray-6 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
                        <div class="min-w-0">
                          <div class="text-sm text-gray-12">{item.title}</div>
                          <Show when={item.description}>
                            <div class="text-xs text-gray-8 mt-1">{item.description}</div>
                          </Show>
                          <Show when={conflictText()}>
                            <div class="text-xs text-amber-11 mt-1">{conflictText()}</div>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <div class="text-xs text-gray-8 font-mono px-2 py-1 border border-gray-6 rounded-lg">
                            {activeKeybind() ? formatKeybindLabel(activeKeybind()!) : "Unassigned"}
                          </div>
                          <Button
                            variant={capturingId() === item.id ? "secondary" : "outline"}
                            class="text-xs h-8 px-3"
                            onClick={() =>
                              setCapturingId(capturingId() === item.id ? null : item.id)
                            }
                          >
                            {capturingId() === item.id ? "Press keys" : "Record"}
                          </Button>
                          <Button
                            variant="ghost"
                            class="text-xs h-8 px-3"
                            disabled={!item.overrideKeybind}
                            onClick={() => props.onReset(item.id)}
                          >
                            Reset
                          </Button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
