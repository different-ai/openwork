// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePlatform } from "../kernel/platform";
import {
  createSessionNumberHintReveal,
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
import {
  getThinkingModeShortcutDirection,
  resolveThinkingModeShortcutOs,
  type ThinkingModeShortcutDirection,
} from "./thinking-mode-shortcut";
import { isFavoriteModelShortcut } from "./favorite-model-shortcut";
import { isCycleModelSourceShortcut } from "@/react-app/domains/models/model-catalog";
import { isFastModeShortcut } from "./fast-mode-shortcut";
import { isNewSessionShortcut } from "./new-session-shortcut";

const NO_SESSION_NUMBER_TARGETS: readonly SessionNumberShortcutTarget[] = [];

export type UseShellShortcutsInput = {
  /** Same action as the command palette's "New session". */
  onCreateNewSession: () => void;
  onNextSessionTab?: () => void;
  onPrevSessionTab?: () => void;
  onCycleThinkingMode?: (direction: ThinkingModeShortcutDirection) => void;
  onCycleFavoriteModel?: () => void;
  onCycleModelSource?: () => void;
  onToggleFastMode?: () => void;
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
  const {
    onCreateNewSession,
    onNextSessionTab,
    onPrevSessionTab,
    onCycleThinkingMode,
    onCycleFavoriteModel,
    onToggleFastMode,
  } = input;
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut();
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionNumberModifierHeld, setSessionNumberModifierHeld] = useState(false);
  const [sessionNumberTargets, setSessionNumberTargets] = useState<SessionNumberShortcutTarget[]>([]);
  const sessionNumberCancelledRef = useRef(false);
  const sessionNumberModifierHeldRef = useRef(false);
  // Shortcuts work as soon as the modifier is down; only the sidebar hints wait.
  const [sessionNumberHintsVisible, setSessionNumberHintsVisible] = useState(false);
  const [sessionNumberHintReveal] = useState(() => createSessionNumberHintReveal({
    onChange: setSessionNumberHintsVisible,
  }));
  const sessionNumberOs: SessionNumberShortcutOs = resolveSessionNumberShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const thinkingModeShortcutOs = resolveThinkingModeShortcutOs(
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
    sessionNumberHintReveal.release();
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
    sessionNumberHintReveal.hold();
    setSessionNumberTargets((current) => (
      sameSessionNumberShortcutTargets(current, targets) ? current : targets
    ));
    return targets;
  });

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new session (handleNewSessionKeyDown, capture phase)
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+F        -> find in current conversation (handled by session surface)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages)
  //   Cmd/Ctrl+T        -> next session tab
  //   Cmd/Ctrl+Shift+T  -> previous session tab
  //   Ctrl+T / Ctrl+Shift+T (macOS) -> next / previous thinking mode
  //   Ctrl+Alt+T / Ctrl+Alt+Shift+T (Windows/Linux) -> next / previous thinking mode
  //   Ctrl+Shift+M      -> next favorite model
  //   Ctrl+Shift+F (macOS) / Ctrl+Alt+F (Windows/Linux) -> toggle Fast
  //   Cmd/Ctrl+1–9      -> matching visible sidebar session
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (isCycleModelSourceShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) input.onCycleModelSource?.();
      return;
    }
    if (isFavoriteModelShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) onCycleFavoriteModel?.();
      return;
    }
    if (isFastModeShortcut(event, thinkingModeShortcutOs)) {
      event.preventDefault();
      if (!event.repeat) onToggleFastMode?.();
      return;
    }
    const thinkingModeDirection = getThinkingModeShortcutDirection(event, thinkingModeShortcutOs);
    if (thinkingModeDirection) {
      event.preventDefault();
      if (!event.repeat) onCycleThinkingMode?.(thinkingModeDirection);
      return;
    }
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

    const key = event.key?.toLowerCase();
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

  // Cmd/Ctrl+N must work while the composer (or any text field) has focus,
  // which is nearly always. An open modal dialog keeps the key.
  const handleNewSessionKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!isNewSessionShortcut(event, sessionNumberOs)) return;
    if (hasSessionNumberShortcutOwner(document)) return;
    event.preventDefault();
    if (!event.repeat) onCreateNewSession();
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
    const handler = (event: KeyboardEvent) => handleNewSessionKeyDown(event);
    // Capture first so editor keydown handlers cannot consume Cmd/Ctrl+N
    // before the shell sees it (same as the Cmd/Ctrl+1–9 session jump).
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
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
      sessionNumberHintReveal.release();
      observer.disconnect();
    };
  }, [sessionNumberHintReveal]);

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
      targets: sessionNumberHintsVisible ? sessionNumberTargets : NO_SESSION_NUMBER_TARGETS,
    },
  };
}
