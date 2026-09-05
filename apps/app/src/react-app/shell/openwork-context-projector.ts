import type {
  OpenworkAffordanceDescriptor,
  OpenworkProviderRef,
} from "@openwork/types/openwork-affordance";
import type {
  OpenworkConversationLayout,
  OpenworkContextSnapshot,
  OpenworkPanelTab,
  OpenworkResourceDescriptor,
  OpenworkScreen,
} from "@openwork/types/openwork-context";

import type { PanelTabStore } from "../domains/session/panel/panel-tab-store";
import type { WorkbenchSnapshot } from "../domains/session/chat/workbench-store";
import type { UiState } from "./ui-state-store";

type OpenworkContextProjectorInput = {
  route: string;
  revision: number;
  capturedAt: string;
  workbench: WorkbenchSnapshot;
  ui: Pick<
    UiState,
    "sidebarOpen" | "sidePanelState" | "applicationMenuVisible" | "workspaceRightSidebarExpanded"
  >;
  panelSessions: PanelTabStore["sessions"];
  pinnedSessionIds: string[];
  availableAffordances: OpenworkAffordanceDescriptor[];
};

function decoded(value: string | undefined) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function screenFromRoute(route: string): OpenworkScreen {
  const workspaceSettings = route.match(/^\/workspace\/([^/]+)\/settings(?:\/([^/?#]+))?/);
  if (workspaceSettings) {
    return {
      kind: "settings",
      route,
      workspaceId: decoded(workspaceSettings[1]),
      panel: decoded(workspaceSettings[2]) ?? "general",
    };
  }

  const settings = route.match(/^\/settings(?:\/([^/?#]+))?/);
  if (settings) {
    return {
      kind: "settings",
      route,
      panel: decoded(settings[1]) ?? "general",
    };
  }

  const workspaceSession = route.match(/^\/workspace\/([^/]+)\/session(?:\/([^/?#]+))?/);
  if (workspaceSession) {
    return {
      kind: "conversation",
      route,
      workspaceId: decoded(workspaceSession[1]),
      sessionId: decoded(workspaceSession[2]),
    };
  }

  const session = route.match(/^\/session(?:\/([^/?#]+))?/);
  if (session) {
    return {
      kind: "conversation",
      route,
      sessionId: decoded(session[1]),
    };
  }

  return { kind: "other", route };
}

function panelTab(tab: PanelTabStore["sessions"][string]["tabs"][number]): OpenworkPanelTab {
  if (tab.type === "browser") {
    return {
      id: tab.id,
      kind: "browser",
      label: tab.label,
      url: tab.url,
      status: tab.status,
    };
  }
  return {
    id: tab.id,
    kind: "artifact",
    label: tab.label,
  };
}

export function buildOpenworkContext(
  input: OpenworkContextProjectorInput,
): OpenworkContextSnapshot {
  const primary = input.workbench.primary;
  const secondary = input.workbench.secondary;
  const layout: OpenworkConversationLayout = primary && secondary
    ? {
        kind: "split",
        primarySessionId: primary.sessionId,
        primaryWorkspaceId: primary.workspaceId,
        secondarySessionId: secondary.sessionId,
        secondaryWorkspaceId: secondary.workspaceId,
        focused: input.workbench.focusedPane,
      }
    : primary
      ? { kind: "single", workspaceId: primary.workspaceId, sessionId: primary.sessionId }
      : { kind: "empty" };

  const focusedSessionId = input.workbench.focusedPane === "secondary" && secondary
    ? secondary.sessionId
    : primary?.sessionId ?? null;
  const panelOwnerSessionId = focusedSessionId && input.ui.sidePanelState[focusedSessionId]
    ? focusedSessionId
    : primary?.sessionId ?? null;
  const sessionPanelKind = panelOwnerSessionId
    ? input.ui.sidePanelState[panelOwnerSessionId] ?? null
    : null;
  const voiceOpen = Object.values(input.ui.sidePanelState).includes("voice");
  const sidePanelKind = voiceOpen ? "voice" : sessionPanelKind;
  const ownerSessionId = sidePanelKind === "voice" ? null : panelOwnerSessionId;
  const sessionPanel = ownerSessionId ? input.panelSessions[ownerSessionId] : undefined;
  const screen = screenFromRoute(input.route);
  const provider: OpenworkProviderRef = { id: "openwork-ui", kind: "builtin" };
  const resources: OpenworkResourceDescriptor[] = [{
    ref: `screen:${input.route}`,
    kind: "screen",
    title: screen.kind === "settings" ? `${screen.panel} settings` : "OpenWork",
    provider,
    state: { kind: screen.kind, route: input.route },
  }];
  const visibleWorkspaces = [primary, secondary].flatMap((session) => session ? [session] : []);
  for (const [index, session] of visibleWorkspaces.entries()) {
    if (visibleWorkspaces.slice(0, index).some((candidate) => candidate.workspaceId === session.workspaceId)) continue;
    resources.push({
      ref: `workspace:${session.workspaceId}`,
      kind: "workspace",
      title: session.workspaceTitle ?? session.workspaceId,
      provider,
      state: { active: primary?.workspaceId === session.workspaceId, visible: true },
    });
  }
  for (const tab of input.workbench.tabs) {
    const inPrimary = tab.workspaceId === primary?.workspaceId && tab.sessionId === primary.sessionId;
    const inSecondary = tab.workspaceId === secondary?.workspaceId && tab.sessionId === secondary.sessionId;
    resources.push({
      ref: `session:${tab.workspaceId}:${tab.sessionId}`,
      kind: "session",
      title: tab.title ?? tab.sessionId,
      provider,
      state: {
        workspaceId: tab.workspaceId,
        open: true,
        visible: inPrimary || inSecondary,
        pinned: input.pinnedSessionIds.includes(tab.sessionId),
        pane: inPrimary ? "primary" : inSecondary ? "secondary" : null,
        focused: inPrimary
          ? input.workbench.focusedPane === "primary"
          : inSecondary && input.workbench.focusedPane === "secondary",
      },
    });
  }
  if (screen.kind === "settings") {
    resources.push({
      ref: `settings:${screen.panel}`,
      kind: "settings",
      title: `${screen.panel} settings`,
      provider,
      state: { active: true, workspaceId: screen.workspaceId ?? null },
    });
  }
  if (sidePanelKind) {
    resources.push({
      ref: `side-panel:${ownerSessionId ?? "global"}`,
      kind: "side-panel",
      title: sidePanelKind,
      provider,
      state: {
        open: true,
        kind: sidePanelKind,
        ownerSessionId,
      },
    });
  }

  return {
    schemaVersion: 1,
    revision: input.revision,
    capturedAt: input.capturedAt,
    screen,
    conversations: {
      tabs: input.workbench.tabs,
      layout,
      pinnedSessionIds: input.pinnedSessionIds,
    },
    chrome: {
      sidebarOpen: input.ui.sidebarOpen,
      applicationMenuVisible: input.ui.applicationMenuVisible,
      rightSidebarExpanded: input.ui.workspaceRightSidebarExpanded,
    },
    execution: {
      queries: "parallel",
      commands: "serialized",
      busyCommandId: null,
      busyActor: null,
    },
    sidePanel: {
      open: sidePanelKind !== null,
      ownerSessionId,
      kind: sidePanelKind,
      tabs: sidePanelKind === "panel" ? (sessionPanel?.tabs ?? []).map(panelTab) : [],
      activeTabId: sidePanelKind === "panel" ? sessionPanel?.activeTabId ?? null : null,
    },
    resources,
    availableAffordances: input.availableAffordances,
    contributions: [],
  };
}
