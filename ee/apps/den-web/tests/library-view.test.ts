import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryConnectionItem, LibraryItem, LibraryPluginItem } from "../app/(den)/dashboard/_components/library-data";
import { LibraryAddControl, LibraryEmpty, LibraryRow } from "../app/(den)/dashboard/_components/library-screen";
import { DashboardHeaderActions, DashboardHeaderActionsProvider, DashboardHeaderActionsSlot } from "../app/(den)/dashboard/_components/dashboard-header-actions";
import {
  getLibraryAddAction,
  getLibraryKind,
  getLibraryKindItems,
  getLibraryState,
  getLibraryView,
  LIBRARY_DEFAULT_KIND,
  LIBRARY_DEFAULT_STATE,
  LIBRARY_KINDS,
  LIBRARY_STATES,
  type LibraryLayout,
  parseLibraryLayout,
} from "../app/(den)/dashboard/_components/library-view";

const native: LibraryConnectionItem = {
  type: "connection", id: "native-1", name: "Workspace tools", description: null,
  url: "https://example.test/native", transport: "native", provider: "google-workspace",
  state: "needs_signin", connectedAt: null, edges: [{ kind: "org_wide" }],
};
const mcp: LibraryConnectionItem = { ...native, id: "mcp-1", name: "Notes", transport: "mcp", provider: null, state: "connected" };
const plugin: LibraryPluginItem = {
  type: "plugin", id: "plugin-1", name: "Team tools", description: "Reusable notes and instructions",
  componentCount: 2, componentKinds: ["mcp", "skill"], sourceRepositoryUrl: null,
  edges: [{ kind: "team", team: { id: "team-1", name: "Design" } }], role: "viewer",
};
const items: LibraryItem[] = [native, mcp, plugin];

describe("My Library filters", () => {
  test("only MCPs, Skills, Plugins are primary, with MCPs and Ready to use selected first", () => {
    expect(LIBRARY_KINDS.map((kind) => kind.label)).toEqual(["MCPs", "Skills", "Plugins"]);
    expect(LIBRARY_DEFAULT_KIND).toBe("mcps");
    expect(LIBRARY_DEFAULT_STATE).toBe("ready");
    // Den does not invent Desktop's local/hidden/disabled states.
    expect(LIBRARY_STATES.map((state) => state.label)).toEqual(["Ready to use", "Needs your sign-in", "Needs admin setup", "Ready to set up"]);
    const view = getLibraryView(items, LIBRARY_DEFAULT_KIND, LIBRARY_DEFAULT_STATE, "");
    expect(view.tabs.map((tab) => tab.label)).toEqual(["Ready to use", "Needs your sign-in"]);
    expect(view.visibleItems).toEqual([mcp]);
    expect(view.counts).toEqual({ ready: 1, needs_signin: 1, needs_admin_setup: 0, needs_setup: 0 });
  });

  test("only projects actual native and remote connections into MCPs, preserving bundles in Plugins", () => {
    expect(getLibraryKindItems(items, "mcps")).toEqual([native, mcp]);
    expect(getLibraryKindItems([native, native, mcp, plugin, plugin], "mcps")).toEqual([native, mcp]);
    expect(getLibraryKindItems([mcp, { ...plugin, id: mcp.id, name: mcp.name }], "mcps")).toEqual([mcp]);
    expect(getLibraryKindItems([mcp, { ...mcp, id: "mcp-2" }], "mcps")).toHaveLength(2);
    expect(getLibraryKindItems(items, "skills")).toEqual([plugin]);
    expect(getLibraryKindItems([...items, plugin], "plugins")).toEqual([plugin]);
    expect(getLibraryKindItems(items, "plugins")[0]).toBe(plugin);
    expect(getLibraryKindItems([{ ...plugin, componentKinds: ["MCP"] }], "mcps")).toEqual([]);
    expect(getLibraryView([plugin], "mcps", "ready", "").counts.ready).toBe(0);
    expect(getLibraryView([plugin], "mcps", "ready", "").empty.title).toBe("No MCPs yet");
  });

  test("retains every unavailable connection under an accurate nonzero state, never Ready", () => {
    const unavailable: LibraryItem[] = [native, { ...mcp, id: "admin-1", state: "needs_admin_setup" }, { ...mcp, id: "setup-1", state: "available" }];
    const ready = getLibraryView(unavailable, "mcps", "ready", "");
    expect(ready.visibleItems).toEqual([]);
    expect(ready.tabs.map((tab) => tab.value)).toEqual(["ready", "needs_signin", "needs_admin_setup", "needs_setup"]);
    expect(ready.tabs.flatMap((tab) => getLibraryView(unavailable, "mcps", tab.value, "").visibleItems)).toHaveLength(3);
    expect(getLibraryState(unavailable[2])).toBe("needs_setup");
    expect(getLibraryView(items, "skills", "needs_admin_setup", "").activeState).toBe("needs_admin_setup");
  });

  test("hides zero-count status tabs except Ready and the explicitly selected state", () => {
    expect(getLibraryView([mcp], "mcps", "ready", "").tabs.map((tab) => tab.value)).toEqual(["ready"]);
    for (const state of ["needs_signin", "needs_admin_setup", "needs_setup"] satisfies Parameters<typeof getLibraryView>[2][]) {
      const view = getLibraryView([mcp], "mcps", state, "");
      expect(view.tabs.map((tab) => tab.value)).toEqual(["ready", state]);
      expect(view.counts[state]).toBe(0);
      expect(view.activeState).toBe(state);
      expect(view.visibleItems).toEqual([]);
    }
    expect(getLibraryView([mcp], "mcps", "needs_admin_setup", "").empty.title).toBe("No items in this state");
    expect(getLibraryView([mcp], "mcps", "needs_setup", "").empty.title).toBe("No items in this state");
    // Recovery goes to a populated state, not back to an equally empty Ready tab.
    expect(getLibraryView([native], "mcps", "needs_setup", "").empty.action).toBe("needs_signin");
  });

  test("counts only the selected kind, independently of search, without a source filter", () => {
    const view = getLibraryView(items, "skills", "ready", "  INSTRUCTIONS  ");
    expect(view.visibleItems).toEqual([plugin]);
    expect(view.counts.ready).toBe(1);
    expect(view.counts.needs_signin).toBe(0);
    expect(getLibraryView(items, "mcps", "needs_signin", "workspace").visibleItems).toEqual([native]);
  });

  test("focus chooses a visible primary kind, including native connections", () => {
    expect(getLibraryKind(native)).toBe("mcps");
    expect(getLibraryKind(plugin)).toBe("plugins");
    expect(getLibraryKind({ ...plugin, componentKinds: ["skill"] })).toBe("skills");
    expect(getLibraryKind({ ...plugin, componentKinds: ["command"] })).toBe("plugins");
  });
});

test("header actions survive late slot mounting, slot replacement, and page remounts", async () => {
  GlobalRegistrator.register({ url: "https://app.example.test" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  async function render(showSlot: boolean, showActions: boolean, slotKey = "library") {
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(DashboardHeaderActionsProvider, null,
        createElement("header", null, showSlot ? createElement(DashboardHeaderActionsSlot, { key: slotKey }) : null),
        showActions ? createElement(DashboardHeaderActions, null, createElement("button", { "aria-label": "Add MCP" }, "+")) : null,
      ),
    )));
  }
  try {
    await render(false, false);
    await render(false, true);
    expect(container.querySelector("button")).toBeNull();
    await render(true, true);
    expect(container.querySelectorAll('header [aria-label="Add MCP"]')).toHaveLength(1);
    const originalSlot = container.querySelector("[data-dashboard-header-actions]");
    await render(true, true, "replacement");
    expect(originalSlot?.isConnected).toBe(false);
    expect(container.querySelectorAll('header [aria-label="Add MCP"]')).toHaveLength(1);
    await render(false, true);
    expect(container.querySelector("button")).toBeNull();
    await render(false, false);
    await render(true, false);
    expect(container.querySelector("button")).toBeNull();
    await render(true, true);
    expect(container.querySelectorAll('header [aria-label="Add MCP"]')).toHaveLength(1);
    await render(true, false);
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await GlobalRegistrator.unregister();
  }
});

describe("My Library empty states and entry points", () => {
  test("has distinct catalog copy for all three kinds", () => {
    expect(getLibraryView([], "mcps", "ready", "").empty).toEqual({ title: "No MCPs yet", description: "Connect a cloud MCP to give your agents access to your tools and services.", action: "add" });
    expect(getLibraryView([], "skills", "ready", "").empty).toEqual({ title: "No skills yet", description: "Add reusable instructions for work your agents do often.", action: "add" });
    expect(getLibraryView([], "plugins", "ready", "").empty).toEqual({ title: "No plugins yet", description: "Add a plugin to bring related skills and MCPs into your Library.", action: "add" });
  });

  test("does not confuse search misses or unavailable records with an empty catalog", () => {
    expect(getLibraryView([], "mcps", "ready", "missing").empty).toEqual({ title: "No library items match these filters.", description: "Try changing your search or filters.", action: "clear_filters" });
    expect(getLibraryView([native], "mcps", "ready", "").empty).toMatchObject({ title: "No MCPs ready to use", action: "needs_signin" });
    expect(getLibraryView([{ ...mcp, state: "needs_admin_setup" }], "mcps", "ready", "").empty.action).toBe("needs_admin_setup");
    expect(getLibraryView([{ ...mcp, state: "available" }], "mcps", "ready", "").empty.action).toBe("needs_setup");
    expect(getLibraryView(items, "skills", "needs_signin", "").empty.action).toBe("ready");
  });

  test("uses Cloud setup for admins, member sign-in for members, and no unavailable capability shortcut", () => {
    const input = { kind: "mcps", isAdmin: true, mcpConnections: true, orgSlug: null } satisfies Parameters<typeof getLibraryAddAction>[0];
    expect(getLibraryAddAction(input)).toEqual({ label: "Add MCP", href: "/dashboard/mcp-connections" });
    expect(getLibraryAddAction({ ...input, isAdmin: false })).toEqual({ label: "View available MCPs", href: "/dashboard/your-connections" });
    expect(getLibraryAddAction({ ...input, mcpConnections: false })).toBeNull();
    expect(getLibraryAddAction({ ...input, kind: "plugins", isAdmin: false })).toBeNull();
    expect(getLibraryAddAction({ ...input, kind: "skills", isAdmin: false })).toBeNull();
    expect(getLibraryAddAction({ ...input, kind: "plugins" })).toEqual({ label: "Add plugin", href: "/dashboard/plugins/new" });
    expect(getLibraryAddAction({ ...input, kind: "skills" })).toEqual({ label: "Create skill", href: "/dashboard/plugins/new?component=skill" });
  });

  test("generic Create skill never selects an existing shared plugin or inherits its audience", () => {
    const input = { kind: "skills", isAdmin: true, mcpConnections: true, orgSlug: null } satisfies Parameters<typeof getLibraryAddAction>[0];
    for (const sharedPlugin of [
      { ...plugin, role: "editor" },
      { ...plugin, role: "manager", edges: [{ kind: "org_wide" }] },
    ] satisfies LibraryPluginItem[]) {
      const libraryContext = { ...input, items: [sharedPlugin] };
      expect(getLibraryView(libraryContext.items, "skills", "ready", "").visibleItems).toEqual([sharedPlugin]);
      expect(getLibraryAddAction(libraryContext)).toEqual({ label: "Create skill", href: "/dashboard/plugins/new?component=skill" });
      expect(getLibraryAddAction({ ...libraryContext, isAdmin: false })).toBeNull();
    }
  });

  test("matches neutral connected cards without treating plugin bundles as connected MCPs", () => {
    const connectedMarkup = renderToStaticMarkup(createElement(LibraryRow, { item: mcp, isFocused: false, orgName: "Workspace", orgSlug: null, layout: "grid" }));
    const link = connectedMarkup.match(/<a\b[^>]*>/)?.[0];
    expect(link).toContain("bg-white");
    expect(link).toContain("border-gray-200");
    expect(link).not.toMatch(/(?:bg|border|ring)-(?:green|emerald)-/);
    expect(connectedMarkup).toContain('data-library-ready=""');
    expect(connectedMarkup).toContain("Connected");
    expect(connectedMarkup).toContain("View details");
    expect(connectedMarkup).toContain("Cloud");
    const bundleMarkup = renderToStaticMarkup(createElement(LibraryRow, { item: plugin, isFocused: false, orgName: "Workspace", orgSlug: null, layout: "grid" }));
    expect(bundleMarkup).toContain("Ready to use");
    expect(bundleMarkup).not.toContain("Connected");
    const pendingMarkup = renderToStaticMarkup(createElement(LibraryRow, { item: { ...mcp, state: "available" }, isFocused: false, orgName: "Workspace", orgSlug: null, layout: "grid" }));
    expect(pendingMarkup).toContain("Ready to set up");
    expect(pendingMarkup).not.toContain("data-library-ready=");
  });

  test("keeps person, team, catalog, and organization provenance in cards and rows", () => {
    for (const edges of [
      [{ kind: "person", sharedBy: { orgMembershipId: "member-1", name: "Test Member" }, grantedAt: "2026-09-11T10:00:00Z" }],
      plugin.edges,
      [{ kind: "catalog", marketplace: { id: "catalog-1", name: "Tools" } }],
      [{ kind: "org_wide" }],
    ] satisfies LibraryPluginItem["edges"][]) {
      for (const layout of ["grid", "list"] satisfies LibraryLayout[]) {
        const markup = renderToStaticMarkup(createElement(LibraryRow, { item: { ...plugin, edges }, isFocused: false, orgName: "Workspace", orgSlug: null, layout }));
        expect(markup).toContain("data-library-source");
        expect(markup).toContain(edges[0].kind === "person" ? "Shared by Test" : edges[0].kind === "team" ? "Design" : edges[0].kind === "catalog" ? "Catalog" : "Workspace");
        expect(markup.match(/<a\s/g)).toHaveLength(1);
      }
    }
  });

  test("header Add stays focusable but has no destination when Den permissions forbid authoring", () => {
    const disabledReason = "An organization admin manages additions to this Library.";
    const blocked = renderToStaticMarkup(createElement(LibraryAddControl, { action: null, label: "Create skill", disabledReason }));
    expect(blocked).toContain('aria-label="Create skill"');
    expect(blocked).toContain('aria-disabled="true"');
    expect(blocked).toContain(disabledReason);
    expect(blocked).not.toContain("href=");
    expect(blocked).not.toContain('disabled=""');
    const action = getLibraryAddAction({ kind: "mcps", isAdmin: false, mcpConnections: true, orgSlug: null });
    const enabled = renderToStaticMarkup(createElement(LibraryAddControl, { action, label: "Add MCP", disabledReason }));
    expect(enabled).toContain('aria-label="View available MCPs"');
    expect(enabled).toContain('href="/dashboard/your-connections"');
    expect(enabled).not.toContain("/dashboard/mcp-connections");
    expect(enabled.match(/<a\s/g)).toHaveLength(1);
  });

  test("empty-state recovery distinguishes a failed load from an empty inventory", () => {
    const props = {
      empty: getLibraryView([], "mcps", "ready", "").empty,
      addAction: { label: "Add MCP", href: "/dashboard/mcp-connections" },
      disabledReason: "Connections are not enabled for this organization.",
      onAction: () => {}, onRefresh: () => {},
    };
    const failed = renderToStaticMarkup(createElement(LibraryEmpty, { ...props, error: "Try again later." }));
    expect(failed).toContain("Your Library is unavailable");
    expect(failed).toContain("Refresh");
    expect(failed).not.toContain("No MCPs yet");
    expect(failed).not.toContain("Add MCP");
    const normal = renderToStaticMarkup(createElement(LibraryEmpty, props));
    expect(normal).toContain("No MCPs yet");
    expect(normal).toContain('href="/dashboard/mcp-connections"');
    expect(normal).not.toContain("Your Library is unavailable");
    const blocked = renderToStaticMarkup(createElement(LibraryEmpty, { ...props, addAction: null }));
    expect(blocked).toContain(props.disabledReason);
    expect(blocked).not.toContain("href=");
    const noMatches = renderToStaticMarkup(createElement(LibraryEmpty, { ...props, empty: getLibraryView(items, "mcps", "needs_signin", "missing").empty }));
    expect(noMatches).toContain("Clear filters");
    expect(noMatches).not.toContain("Add MCP");
  });

  test("defaults to grid and respects a persisted explicit list selection", () => {
    expect(parseLibraryLayout(null)).toBe("grid");
    expect(parseLibraryLayout("invalid")).toBe("grid");
    expect(parseLibraryLayout("grid")).toBe("grid");
    expect(parseLibraryLayout("list")).toBe("list");
  });

  test("grid and list keep connection sign-in, plugin details, and source attribution without nested links", () => {
    for (const layout of ["grid", "list"] satisfies ("grid" | "list")[]) {
      const connectionMarkup = renderToStaticMarkup(createElement(LibraryRow, { item: native, isFocused: false, orgName: "Workspace", orgSlug: null, layout }));
      expect(connectionMarkup).toContain('href="/dashboard/your-connections?connectionId=native-1"');
      expect(connectionMarkup).not.toContain("Connected");
      expect(connectionMarkup).toContain("Sign in");
      expect(connectionMarkup).toContain("Native");
      expect(connectionMarkup).not.toContain("Local ·");
      expect(connectionMarkup.match(/<a\s/g)).toHaveLength(1);
      const pluginMarkup = renderToStaticMarkup(createElement(LibraryRow, { item: plugin, isFocused: true, orgName: "Workspace", orgSlug: null, layout }));
      expect(pluginMarkup).toContain('href="/dashboard/library/plugins/plugin-1"');
      expect(pluginMarkup).toContain("data-library-source=");
      expect(pluginMarkup).toContain("Design");
      expect(pluginMarkup).toContain('data-library-focused=""');
    }
  });
});
