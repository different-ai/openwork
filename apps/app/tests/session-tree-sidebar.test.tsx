/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarMenuSub, SidebarProvider } from "../src/components/ui/sidebar";
import { SidebarContext, type SidebarContextValue } from "../src/react-app/domains/session/sidebar/app-sidebar-provider";
import { SessionMenuItem, SidebarReorderScope } from "../src/react-app/domains/session/sidebar/app-sidebar";
import { EMPTY_SESSION_TREE, buildSessionTree } from "../src/react-app/domains/session/sidebar/session-tree";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import type { SessionListItem } from "../src/react-app/domains/session/sidebar/utils";

const session = (id: string, parent?: { id: string; kind: "side" | "sub" }): SessionListItem => ({
  id, title: `Title ${id}`, time: { created: 1, updated: 1 },
  ...(parent ? { openworkSessionLink: { kind: parent.kind, parentID: parent.id } } : {}),
});
const sessions = [session("main"), session("side", { id: "main", kind: "side" }), session("sub", { id: "main", kind: "sub" }), session("deep", { id: "sub", kind: "sub" })];

function render(enabled: boolean) {
  const tree = enabled ? buildSessionTree(sessions) : EMPTY_SESSION_TREE;
  const noop = () => undefined;
  const context: SidebarContextValue = {
    selectedWorkspaceId: "ws", selectedSessionId: null, developerMode: false, newTaskDisabled: false,
    connectingWorkspaceId: null, workspaceConnectionStateById: {}, onSelectWorkspace: noop, onOpenSession: noop,
    onCreateTaskInWorkspace: noop, onCreateSplitTaskInWorkspace: noop, onOpenRenameWorkspace: noop, onRevealWorkspace: noop,
    onForgetWorkspace: noop, expandWorkspace: noop, toggleWorkspaceExpanded: noop, expandedWorkspaceIds: new Set(),
    sessionNumberShortcutOs: "macos", sessionNumberShortcutByTarget: new Map(), sessionTreeFor: () => tree,
  };
  return renderToStaticMarkup(
    <PlatformProvider value={{ ...createDefaultPlatform(), os: "macos" }}>
      <SidebarProvider>
        <SidebarContext.Provider value={context}>
          <SidebarReorderScope>
            <SidebarMenuSub>
              <SessionMenuItem session={sessions[0]!} workspaceId="ws" />
            </SidebarMenuSub>
          </SidebarReorderScope>
        </SidebarContext.Provider>
      </SidebarProvider>
    </PlatformProvider>,
  );
}

const rows = (html: string) => [...html.matchAll(/<li[^>]*data-sidebar-session-id="([^"]+)"[^>]*>/g)].map((match) => ({
  id: match[1],
  depth: /data-session-tree-depth="(\d)"/.exec(match[0])?.[1] ?? null,
  kind: /data-session-tree-kind="(\w+)"/.exec(match[0])?.[1] ?? null,
}));

describe("nested session rows in the sidebar", () => {
  test("a session lists the sessions started from it under its own row, each a level in", () => {
    const html = render(true);
    expect(rows(html)).toEqual([
      { id: "main", depth: null, kind: null },
      { id: "side", depth: "1", kind: "side" },
      { id: "sub", depth: "1", kind: "sub" },
      { id: "deep", depth: "2", kind: "sub" },
    ]);
    // One rail segment per nested row, and the row says what it is to assistive tech.
    expect(html.match(/data-session-tree-rail/g)?.length).toBe(3);
    expect(html).toContain('aria-label="Title side, Side chat"');
    expect(html).toContain('aria-label="Title sub, Started by the agent"');
    // Nested rows are indented one 16px step per level from the 12px lane.
    expect(html).toContain("padding-inline-start:28px");
    expect(html).toContain("padding-inline-start:44px");
  });

  test("off, a row renders alone, exactly as before", () => {
    const html = render(false);
    expect(rows(html)).toEqual([{ id: "main", depth: null, kind: null }]);
    expect(html).not.toContain("data-session-tree-rail");
  });
});
