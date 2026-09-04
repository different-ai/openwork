import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(libraryScreen).toContain("item.plugin ? `Plugin ${item.plugin.name} · ` : \"\"");
    expect(libraryScreen).toContain("getLibraryPluginRoute(orgSlug, item.id)");
    expect(libraryScreen).toContain("item.type === \"connection\"");
    expect(libraryScreen).toContain("? connectionHref");
    expect(workflowDetail).toContain("detail.workflow.plugin ?");
    expect(pluginDetail).toContain('workflow.plugin ? `Currently in ${workflow.plugin.name}` : "Shared directly"');
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
