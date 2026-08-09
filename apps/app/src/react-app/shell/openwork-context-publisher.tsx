/** @jsxImportSource react */
import { useMemo } from "react";
import { useLocation } from "react-router";

import { usePanelTabStore } from "../domains/session/panel/panel-tab-store";
import { useWorkbenchStore } from "../domains/session/chat/workbench-store";
import { usePublishOpenworkContext } from "./control/control-provider";
import { buildOpenworkContext } from "./openwork-context-projector";
import { useUiStateStore } from "./ui-state-store";

export function OpenworkContextPublisher() {
  const location = useLocation();
  const revision = useWorkbenchStore((state) => state.revision);
  const workspaceId = useWorkbenchStore((state) => state.workspaceId);
  const workspaceTitle = useWorkbenchStore((state) => state.workspaceTitle);
  const primarySessionId = useWorkbenchStore((state) => state.primarySessionId);
  const tabs = useWorkbenchStore((state) => state.tabs);
  const splitSessionId = useWorkbenchStore((state) => state.splitSessionId);
  const focusedPane = useWorkbenchStore((state) => state.focusedPane);
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const sidePanelState = useUiStateStore((state) => state.sidePanelState);
  const applicationMenuVisible = useUiStateStore((state) => state.applicationMenuVisible);
  const workspaceRightSidebarExpanded = useUiStateStore((state) => state.workspaceRightSidebarExpanded);
  const panelSessions = usePanelTabStore((state) => state.sessions);
  const route = `${location.pathname}${location.search}${location.hash}`;

  const context = useMemo(() => buildOpenworkContext({
    route,
    revision,
    capturedAt: new Date().toISOString(),
    workbench: {
      revision,
      workspaceId,
      workspaceTitle,
      primarySessionId,
      tabs,
      splitSessionId,
      focusedPane,
    },
    ui: {
      sidebarOpen,
      sidePanelState,
      applicationMenuVisible,
      workspaceRightSidebarExpanded,
    },
    panelSessions,
    availableAffordances: [],
  }), [
    applicationMenuVisible,
    focusedPane,
    panelSessions,
    primarySessionId,
    revision,
    route,
    sidebarOpen,
    sidePanelState,
    splitSessionId,
    tabs,
    workspaceId,
    workspaceTitle,
    workspaceRightSidebarExpanded,
  ]);

  usePublishOpenworkContext(context);
  return null;
}
