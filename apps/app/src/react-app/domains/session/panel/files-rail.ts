import type { PanelTab } from "./panel-tab-store";

export type EmptyPanelView = "chooser" | "files";

export function isFilesRailActive(input: {
  panelOpen: boolean;
  activeTabType: PanelTab["type"] | null;
  emptyView: EmptyPanelView;
}): boolean {
  if (!input.panelOpen) return false;
  if (input.activeTabType === null) return input.emptyView === "files";
  return input.activeTabType === "artifact";
}

export function openFileTabId(
  tabs: ReadonlyArray<Pick<PanelTab, "id" | "type">>,
  activeTabId: string | null,
): string | null {
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (active?.type === "artifact") return active.id;
  return tabs.find((tab) => tab.type === "artifact")?.id ?? null;
}
