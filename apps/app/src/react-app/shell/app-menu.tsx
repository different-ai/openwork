/** @jsxImportSource react */
import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useUpdateCheckRequestStore } from "../domains/settings/state/update-check-request";
import {
  NATIVE_MENU_CHECK_UPDATES_EVENT,
  NATIVE_MENU_OPEN_SETTINGS_EVENT,
  NATIVE_MENU_TOGGLE_SIDEBAR_EVENT,
  nativeMenuSettingsTab,
  useNativeMenuEvent,
} from "./native-menu-events";
import { useUiStateStore } from "./ui-state-store";
import { settingsNavigationFromPathname } from "./workspace-routes";

export function AppMenuProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);

  const openSettingsTab = (tab: string) => {
    const target = settingsNavigationFromPathname(pathname, tab);
    navigate(target.to, { state: target.state });
  };

  useNativeMenuEvent(NATIVE_MENU_OPEN_SETTINGS_EVENT, (event) => {
    openSettingsTab(nativeMenuSettingsTab(event) ?? "general");
  });
  useNativeMenuEvent(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => toggleSidebar());
  useNativeMenuEvent(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
    useUpdateCheckRequestStore.getState().requestUpdateCheck();
    openSettingsTab("updates");
  });

  return <>{children}</>;
}
