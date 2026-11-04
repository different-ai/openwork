// Window events the desktop preload dispatches when a native menu item is
// chosen (see apps/desktop/electron/app-menu.mjs). Menu items for shortcuts the
// renderer already owns (Cmd/Ctrl+N, Cmd/Ctrl+K, Cmd/Ctrl+Shift+F) only fire
// these on click; the key presses keep going through the shell shortcut hooks.
import { useEffect, useEffectEvent } from "react";

export const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
export const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
export const NATIVE_MENU_CHECK_UPDATES_EVENT = "openwork:native-menu:check-updates";
export const NATIVE_MENU_NEW_SESSION_EVENT = "openwork:native-menu:new-session";
export const NATIVE_MENU_SEARCH_SESSIONS_EVENT = "openwork:native-menu:search-sessions";
export const NATIVE_MENU_COMMAND_PALETTE_EVENT = "openwork:native-menu:command-palette";

export type NativeMenuEvent =
  | typeof NATIVE_MENU_OPEN_SETTINGS_EVENT
  | typeof NATIVE_MENU_TOGGLE_SIDEBAR_EVENT
  | typeof NATIVE_MENU_CHECK_UPDATES_EVENT
  | typeof NATIVE_MENU_NEW_SESSION_EVENT
  | typeof NATIVE_MENU_SEARCH_SESSIONS_EVENT
  | typeof NATIVE_MENU_COMMAND_PALETTE_EVENT;

/** The settings tab a menu item asked for, or null for the default tab. */
export function nativeMenuSettingsTab(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  return typeof detail === "string" && detail.trim() ? detail.trim() : null;
}

export function useNativeMenuEvent(name: NativeMenuEvent, handler: (event: Event) => void, enabled = true) {
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const listener = (event: Event) => onEvent(event);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [enabled, name]);
}
