import { useEffect, useEffectEvent } from "react";

import { usePlatform } from "@/react-app/kernel/platform";

import { useModelShortcutsStore, shortcutForKeys, type Shortcut } from "./model-shortcuts-store";
import { chordFromEvent, formatChord, resolveShortcutOs } from "./shortcut-keys";

/** Set on the key recorder while it listens, so a press is recorded, not run. */
export const SHORTCUT_RECORDER_ATTRIBUTE = "data-shortcut-recorder";

function recorderActive(target: EventTarget | null) {
  if (typeof document === "undefined") return false;
  if (target instanceof Element && target.closest(`[${SHORTCUT_RECORDER_ATTRIBUTE}]`)) return true;
  return document.querySelector(`[${SHORTCUT_RECORDER_ATTRIBUTE}="recording"]`) !== null;
}

/**
 * Run saved shortcuts from anywhere in the window, including while typing in
 * the composer. Capture phase so editors and open menus cannot swallow the
 * chord first; every saved chord requires Cmd/Ctrl plus Option/Alt or Shift,
 * so plain typing never matches.
 */
export function useModelShortcutKeys(onShortcut: (shortcut: Shortcut, chordLabel: string) => void) {
  const platform = usePlatform();
  const os = resolveShortcutOs(platform.os, typeof navigator === "undefined" ? "" : navigator.platform);

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (!event.metaKey && !event.ctrlKey) return;
    const chord = chordFromEvent(event, os);
    if (!chord) return;
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
