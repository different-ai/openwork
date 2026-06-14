// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useState } from "react";

export type UseShellShortcutsInput = {
  canCreateTask: boolean;
  workspaceId: string;
  onCreateTask: (workspaceId: string) => void | Promise<void>;
};

export function useShellShortcuts(input: UseShellShortcutsInput) {
  const { canCreateTask, workspaceId, onCreateTask } = input;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new task in selected workspace
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages)
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "f") {
      event.preventDefault();
      setSessionSearchOpen((value) => !value);
      return;
    }
    if (event.shiftKey || event.altKey) return;

    const target = event.target as HTMLElement | null;
    const inEditable =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const key = event.key?.toLowerCase();
    if (key === "n" && !inEditable) {
      event.preventDefault();
      if (canCreateTask && workspaceId) {
        void onCreateTask(workspaceId);
      }
      return;
    }
    if (key === "k") {
      event.preventDefault();
      setCommandPaletteOpen((value) => !value);
      return;
    }
    if (key === "j") {
      event.preventDefault();
      setTerminalOpen((value) => !value);
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleGlobalShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
  };
}
