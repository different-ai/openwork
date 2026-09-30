import type { SessionReference } from "@/components/chat/session-reference";
import {
  isSameWorkbenchSession,
  type WorkbenchPane,
  type WorkbenchSessionTab,
  type WorkbenchSnapshot,
} from "./workbench-store";

export function openSessionReference(
  reference: SessionReference,
  workbench: Pick<WorkbenchSnapshot, "primary" | "secondary" | "focusedPane">,
  actions: {
    openTab: (tab: WorkbenchSessionTab) => void;
    focusPane: (pane: WorkbenchPane) => void;
    setSplit: (session: WorkbenchSessionTab) => void;
    onOpenSession: (workspaceId: string, sessionId: string) => void;
  },
): void {
  if (isSameWorkbenchSession(workbench.primary, reference)) {
    actions.focusPane("primary");
    return;
  }
  if (isSameWorkbenchSession(workbench.secondary, reference)) {
    actions.focusPane("secondary");
    return;
  }
  actions.openTab(reference);
  if (workbench.primary && workbench.secondary && workbench.focusedPane === "secondary" && !reference.archived) {
    actions.setSplit(reference);
    actions.focusPane("secondary");
    return;
  }
  actions.focusPane("primary");
  actions.onOpenSession(reference.workspaceId, reference.sessionId);
}
