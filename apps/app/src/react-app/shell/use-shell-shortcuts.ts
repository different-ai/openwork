// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePlatform } from "../kernel/platform";
import {
  getSessionNumberShortcutIntent,
  hasSessionNumberShortcutOwner,
  isSessionNumberModifierKey,
  isSessionNumberModifierPressed,
  nextSessionNumberModifierHeld,
  readVisibleSessionNumberShortcutTargets,
  resolveSessionNumberShortcutOs,
  sameSessionNumberShortcutTargets,
  type SessionNumberShortcutOs,
  type SessionNumberShortcutTarget,
  type SessionNumberShortcutTransition,
} from "./session-number-shortcuts";

export type UseShellShortcutsInput = {
  canCreateTask: boolean;
  workspaceId: string;
  onCreateTask: (workspaceId: string) => void | Promise<void>;
  onNextSessionTab?: () => void;
  onPrevSessionTab?: () => void;
};

export function useCommandPaletteShortcut(enabled = true) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const handleCommandPaletteShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "k") return;
    event.preventDefault();
    setCommandPaletteOpen((value) => !value);
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleCommandPaletteShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { commandPaletteOpen, setCommandPaletteOpen };
}

export function useShellShortcuts(input: UseShellShortcutsInput) {
  const platform = usePlatform();
  const { canCreateTask, workspaceId, onCreateTask, onNextSessionTab, onPrevSessionTab } = input;
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut();
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionNumberModifierHeld, setSessionNumberModifierHeld] = useState(false);
  const [sessionNumberTargets, setSessionNumberTargets] = useState<SessionNumberShortcutTarget[]>([]);
  const sessionNumberCancelledRef = useRef(false);
  const sessionNumberModifierHeldRef = useRef(false);
  const sessionNumberOs: SessionNumberShortcutOs = resolveSessionNumberShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );

  const clearSessionNumberShortcuts = useEffectEvent((
    cancelUntilRelease: boolean,
    transition: SessionNumberShortcutTransition,
  ) => {
    sessionNumberCancelledRef.current = cancelUntilRelease;
    const modifierHeld = nextSessionNumberModifierHeld(transition);
    sessionNumberModifierHeldRef.current = modifierHeld;
    setSessionNumberModifierHeld(modifierHeld);
    setSessionNumberTargets((current) => current.length === 0 ? current : []);
  });

  const refreshSessionNumberShortcuts = useEffectEvent(() => {
    if (hasSessionNumberShortcutOwner(document)) {
      clearSessionNumberShortcuts(true, "owner-change");
      return [];
    }
    const targets = readVisibleSessionNumberShortcutTargets(document);
    sessionNumberModifierHeldRef.current = true;
    setSessionNumberModifierHeld(true);
    setSessionNumberTargets((current) => (
      sameSessionNumberShortcutTargets(current, targets) ? current : targets
    ));
    return targets;
  });

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new task in selected workspace
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+F        -> find in current conversation (handled by session surface)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages)
  //   Cmd/Ctrl+T        -> next session tab
  //   Cmd/Ctrl+Shift+T  -> previous session tab
  //   Cmd/Ctrl+1–9      -> matching visible sidebar session
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "f") {
      event.preventDefault();
      setSessionSearchOpen((value) => !value);
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "t") {
      event.preventDefault();
      onPrevSessionTab?.();
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
    if (key === "j" && platform.capabilities.terminal) {
      event.preventDefault();
      setTerminalOpen((value) => !value);
      return;
    }
    if (key === "t") {
      event.preventDefault();
      onNextSessionTab?.();
      return;
    }
  });

  const handleSessionNumberKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      sessionNumberModifierHeldRef.current &&
      !isSessionNumberModifierPressed(event, sessionNumberOs)
    ) {
      clearSessionNumberShortcuts(false, "modifier-mismatch");
    }
    const intent = getSessionNumberShortcutIntent(event, sessionNumberOs, {
      ownerActive: hasSessionNumberShortcutOwner(document),
      cancelled: sessionNumberCancelledRef.current,
    });
    if (intent.type === "ignore") {
      if (isSessionNumberModifierKey(event.key, sessionNumberOs)) {
        clearSessionNumberShortcuts(true, "owner-change");
      }
      return;
    }
    if (intent.type === "hold") {
      sessionNumberCancelledRef.current = false;
      refreshSessionNumberShortcuts();
      return;
    }

    const targets = refreshSessionNumberShortcuts();
    const target = targets[intent.digit - 1];
    if (!target) return;
    event.preventDefault();
    if (!event.repeat) target.button.click();
  });

  const handleSessionNumberKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (!isSessionNumberModifierKey(event.key, sessionNumberOs)) return;
    clearSessionNumberShortcuts(false, "modifier-up");
  });

  const handleSessionNumberMouseMove = useEffectEvent((event: MouseEvent) => {
    if (
      sessionNumberModifierHeldRef.current &&
      !isSessionNumberModifierPressed(event, sessionNumberOs)
    ) {
      clearSessionNumberShortcuts(false, "modifier-mismatch");
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleGlobalShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => handleSessionNumberKeyDown(event);
    const keyUp = (event: KeyboardEvent) => handleSessionNumberKeyUp(event);
    const mouseMove = (event: MouseEvent) => handleSessionNumberMouseMove(event);
    const loseOwnership = () => clearSessionNumberShortcuts(true, "owner-change");
    const blur = () => clearSessionNumberShortcuts(true, "blur");
    const focus = () => clearSessionNumberShortcuts(true, "focus");
    const visibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearSessionNumberShortcuts(true, "visibility-hidden");
      }
    };
    const focusIn = () => {
      if (hasSessionNumberShortcutOwner(document)) {
        loseOwnership();
      }
    };
    const observer = new MutationObserver(() => {
      if (!sessionNumberModifierHeldRef.current) return;
      if (hasSessionNumberShortcutOwner(document)) {
        loseOwnership();
      } else {
        refreshSessionNumberShortcuts();
      }
    });

    // Capture first so text fields and open select/menu popovers cannot consume
    // the global session jump before the shell sees it.
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("mousemove", mouseMove, { passive: true });
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibilityChange);
    document.addEventListener("focusin", focusIn);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibilityChange);
      document.removeEventListener("focusin", focusIn);
      sessionNumberModifierHeldRef.current = false;
      observer.disconnect();
    };
  }, []);

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
    sessionNumberShortcuts: {
      modifierHeld: sessionNumberModifierHeld,
      os: sessionNumberOs,
      targets: sessionNumberTargets,
    },
  };
}
