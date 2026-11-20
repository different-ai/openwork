import { describe, expect, test } from "bun:test";

import { isFilesRailActive, openFileTabId } from "../src/react-app/domains/session/panel/files-rail";

describe("isFilesRailActive", () => {
  const open = { panelOpen: true, activeTabType: null, emptyView: "chooser" as const };

  test("is on for a file tab and for the no-files screen", () => {
    expect(isFilesRailActive({ ...open, activeTabType: "artifact" })).toBe(true);
    expect(isFilesRailActive({ ...open, emptyView: "files" })).toBe(true);
  });

  test("is off for the chooser and for tabs that are not files", () => {
    expect(isFilesRailActive(open)).toBe(false);
    for (const activeTabType of ["browser", "app", "mcp-app", "remote-thread", "side-chat"] as const) {
      expect(isFilesRailActive({ ...open, activeTabType, emptyView: "files" })).toBe(false);
    }
  });

  test("is off while the panel is closed", () => {
    expect(isFilesRailActive({ ...open, panelOpen: false, activeTabType: "artifact" })).toBe(false);
  });
});

describe("openFileTabId", () => {
  const tabs = [
    { id: "chat", type: "side-chat" as const },
    { id: "a.md", type: "artifact" as const },
    { id: "b.md", type: "artifact" as const },
  ];

  test("keeps the file tab already on screen", () => {
    expect(openFileTabId(tabs, "b.md")).toBe("b.md");
  });

  test("picks a file tab, never a side chat or an app", () => {
    expect(openFileTabId(tabs, "chat")).toBe("a.md");
    expect(openFileTabId([tabs[0]], "chat")).toBeNull();
  });
});
