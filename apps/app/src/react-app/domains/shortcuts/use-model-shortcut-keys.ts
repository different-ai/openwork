import { useEffect, useEffectEvent } from "react";

import { usePlatform } from "@/react-app/kernel/platform";

import { resolveActionBindings, useActionShortcutsStore, type ShortcutTarget } from "@/react-app/kernel/app-actions";
import { useModelShortcutsStore, shortcutForKeys, type Shortcut } from "./model-shortcuts-store";
import { chordFromEvent, formatChord, resolveShortcutOs } from "./shortcut-keys";

export const SHORTCUT_RECORDER_ATTRIBUTE = "data-shortcut-recorder";

function recorderActive(target: EventTarget | null) {
  if (typeof document === "undefined") return false;
  if (target instanceof Element && target.closest(`[${SHORTCUT_RECORDER_ATTRIBUTE}]`)) return true;
  return document.querySelector(`[${SHORTCUT_RECORDER_ATTRIBUTE}="recording"]`) !== null;
}

export function useModelShortcutKeys(
  onShortcut: (shortcut: Shortcut, chordLabel: string) => void,
  onAction?: (target: ShortcutTarget) => void,
) {
  const platform = usePlatform();
  const os = resolveShortcutOs(platform.os, typeof navigator === "undefined" ? "" : navigator.platform);

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (!event.metaKey && !event.ctrlKey) return;
    const chord = chordFromEvent(event, os);
    if (!chord) return;
    if (onAction && !recorderActive(event.target)) {
      const bindings = resolveActionBindings(useActionShortcutsStore.getState());
      const target = bindings.byChord.get(chord);
      if (target || bindings.silenced.has(chord)) {
        event.preventDefault();
        event.stopPropagation();
        if (target && !event.repeat) onAction(target);
        return;
      }
    }
    const shortcut = shortcutForKeys(useModelShortcutsStore.getState().shortcuts, chord);
    if (!shortcut) return;
    if (recorderActive(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    onShortcut(shortcut, formatChord(chord, os));
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
}
