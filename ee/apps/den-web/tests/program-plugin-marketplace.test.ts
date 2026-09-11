import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryPluginItem, LibraryWorkflowItem } from "../app/(den)/dashboard/_components/library-data";
import { LibraryRow } from "../app/(den)/dashboard/_components/library-screen";
import { getLibraryFocus, getLibraryKindItems, getLibraryView } from "../app/(den)/dashboard/_components/library-view";

const components = join(import.meta.dir, "../app/(den)/dashboard/_components");
const marketplaceDetail = readFileSync(join(components, "marketplace-detail-screen.tsx"), "utf8");
const pluginData = readFileSync(join(components, "plugin-data.tsx"), "utf8");
const pluginDetail = readFileSync(join(components, "plugin-detail-screen.tsx"), "utf8");
const libraryData = readFileSync(join(components, "library-data.tsx"), "utf8");
const libraryScreen = readFileSync(join(components, "library-screen.tsx"), "utf8");
const workflowDetail = readFileSync(join(components, "workflow-detail-screen.tsx"), "utf8");
const adminPanel = readFileSync(join(import.meta.dir, "../components/den-admin-panel.tsx"), "utf8");
const legacyWorkflowPage = readFileSync(join(import.meta.dir, "../app/(den)/dashboard/library/programs/[programId]/page.tsx"), "utf8");
const workflowPage = readFileSync(join(import.meta.dir, "../app/(den)/dashboard/library/workflows/[workflowId]/page.tsx"), "utf8");

const plugin: LibraryPluginItem = {
  type: "plugin", id: "plugin-1", name: "Team procedures", description: null,
  componentCount: 2, componentKinds: ["mcp", "workflow"], sourceRepositoryUrl: null,
  edges: [{ kind: "team", team: { id: "team-1", name: "Operations" } }], role: "viewer",
};
const workflow: LibraryWorkflowItem = {
  type: "workflow", id: "workflow-1", name: "Weekly summary", description: null,
  plugin: { id: plugin.id, name: plugin.name }, role: "viewer", edges: [{ kind: "mine" }],
  state: "needs_signin", resultState: "never_run", latestSuccessfulAt: null,
  viewState: "default", activeViewTitle: null, automationCount: 0, source: { kind: "created" },
};

describe("Workflow Plugin and Marketplace presentation", () => {
  test("presents saved procedures as Workflows inside Plugins", () => {
    expect(pluginData).toContain("export type PluginWorkflow");
    expect(pluginData).toContain("workflows: PluginWorkflow[]");
    expect(pluginData).toContain('objectType === "workflow"');
    expect(pluginDetail).toContain("No Workflows in this Plugin yet.");
    expect(pluginDetail).toContain("Add Workflow");
    expect(pluginDetail).toContain("collection audiences");
    expect(pluginDetail).toContain("Create one from a successful Code Mode run");
    expect(pluginData).toContain("useAttachWorkflowToPlugin");
    expect(pluginData).toContain("/config-objects`");
    expect(pluginData).toContain('membershipSource: "manual"');
    expect(pluginDetail).not.toContain('label="Scripts"');
  });

  test("labels Workflow component counts on Marketplace Plugin rows", () => {
    expect(marketplaceDetail).toContain('workflow: { singular: "Workflow", plural: "Workflows" }');
    expect(marketplaceDetail).toContain("componentTypeLabel(type, count)");
  });

  test("does not render an inaccessible parent Plugin for a directly shared Workflow", () => {
    expect(libraryData).toContain("plugin: LibraryNamedEntity | null");
    const directlyShared: LibraryWorkflowItem = {
      ...workflow,
      plugin: null,
      edges: [{ kind: "person", sharedBy: null, grantedAt: "2026-09-10T10:00:00.000Z" }],
    };
    const focus = getLibraryFocus([directlyShared], `workflow-${workflow.id}`);
    expect(focus).toMatchObject({ key: `workflow-${workflow.id}`, kind: "plugins", state: "needs_signin" });
    expect(focus?.item).toBe(directlyShared);
    expect(focus?.item.edges).toBe(directlyShared.edges);
    expect(focus?.item).toMatchObject({ role: "viewer", plugin: null });
    expect(getLibraryFocus([plugin, directlyShared], `workflow-${workflow.id}`)?.item).toBe(directlyShared);
    expect(getLibraryFocus([workflow], `workflow-${workflow.id}`)?.item).toBe(workflow);
    expect(getLibraryFocus([workflow], `plugin-${plugin.id}`)).toBeNull();
    expect(getLibraryView([directlyShared], "plugins", "needs_signin", "weekly").visibleItems).toEqual([directlyShared]);
    expect(getLibraryKindItems([plugin, directlyShared], "plugins")).toEqual([plugin, directlyShared]);
    expect(getLibraryKindItems([directlyShared, directlyShared], "plugins")).toEqual([directlyShared]);
    expect(getLibraryKindItems([directlyShared], "mcps")).toEqual([]);
    expect(getLibraryKindItems([directlyShared], "skills")).toEqual([]);
    for (const state of ["ready", "needs_signin", "needs_admin_setup"] satisfies LibraryWorkflowItem["state"][]) {
      const item = { ...directlyShared, state };
      expect(getLibraryView([item], "plugins", state, "").visibleItems).toEqual([item]);
    }
    expect(workflowDetail).toContain("const pluginAccess = workflow.plugin ? (");
    expect(workflowDetail).toContain("pluginId={workflow.plugin.id}");
    expect(pluginDetail).toContain('workflow.plugin ? `Currently in ${workflow.plugin.name}` : "Shared directly"');
  });

  test("Workflow focus selects its already-accessible parent under Plugins without changing grants", () => {
    expect(libraryScreen).toContain("getLibraryFocus(items, requestedFocus)");
    const focus = getLibraryFocus([workflow, plugin], `workflow-${workflow.id}`);
    expect(focus).toMatchObject({ key: `plugin-${plugin.id}`, kind: "plugins" });
    if (!focus) throw new Error("The accessible parent plugin was not resolved.");
    expect(focus.item).toBe(plugin);
    expect(focus.item.edges).toBe(plugin.edges);
    expect(focus.item).toMatchObject({ role: "viewer" });
    expect(getLibraryView([workflow, plugin], focus.kind, focus.state, "").visibleItems).toEqual([plugin]);
    expect(getLibraryKindItems([workflow, plugin], "plugins")).toEqual([plugin]);
    expect(getLibraryFocus([plugin], `plugin-${plugin.id}`)?.kind).toBe("plugins");
    expect(getLibraryFocus([workflow, { ...plugin, componentKinds: ["skill", "workflow"] }], `workflow-${workflow.id}`)?.kind).toBe("plugins");
    expect(getLibraryView([workflow, plugin], "mcps", "ready", "").visibleItems).toEqual([]);
  });

  test("standalone Workflow cards and rows link to the existing detail without inventing a parent", () => {
    for (const layout of ["grid", "list"] satisfies ("grid" | "list")[]) {
      const markup = renderToStaticMarkup(createElement(LibraryRow, {
        item: { ...workflow, plugin: null }, isFocused: true, orgName: "Workspace", orgSlug: null, layout,
      }));
      expect(markup).toContain('href="/dashboard/library/workflows/workflow-1"');
      expect(markup).toContain('data-library-item-type="workflow"');
      expect(markup).toContain('data-library-item-key="workflow-workflow-1"');
      expect(markup).toContain('data-library-item-state="needs_signin"');
      expect(markup).toContain('data-library-focused=""');
      expect(markup).toContain(">Workflow</span>");
      expect(markup).not.toContain("/dashboard/library/plugins/");
    }
  });

  test("does not expose a workflows rollout toggle now that Workflows are always on", () => {
    expect(adminPanel).not.toContain('saveOrganizationCapability(org, "workflows"');
    expect(adminPanel).not.toContain('saveOrganizationCapability(org, "codemodeScripts"');
    expect(adminPanel).not.toContain('saveOrganizationCapability(org, "remoteMcpApps"');
  });

  test("serves the canonical Workflow page and redirects the old Program path", () => {
    expect(workflowPage).toContain("WorkflowDetailScreen");
    expect(legacyWorkflowPage).toContain("/dashboard/library/workflows/");
  });

  test("does not offer the retired agent handoff on Workflow detail", () => {
    expect(workflowDetail).not.toContain("Use with agent");
  });
});
