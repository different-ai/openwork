import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboardComponents = join(import.meta.dir, "../app/(den)/dashboard/_components");
const editor = readFileSync(join(dashboardComponents, "skill-editor-screen.tsx"), "utf8");
const detail = readFileSync(join(dashboardComponents, "skill-detail-screen.tsx"), "utf8");
const data = readFileSync(join(dashboardComponents, "skill-data.tsx"), "utf8");
const pluginData = readFileSync(join(dashboardComponents, "plugin-data.tsx"), "utf8");
const pluginDetail = readFileSync(join(dashboardComponents, "plugin-detail-screen.tsx"), "utf8");
const pluginsScreen = readFileSync(join(dashboardComponents, "plugins-screen.tsx"), "utf8");
const dashboardShell = readFileSync(join(dashboardComponents, "org-dashboard-shell.tsx"), "utf8");
const legacySkillsPage = readFileSync(join(import.meta.dir, "../app/(den)/dashboard/(admin)/skills/page.tsx"), "utf8");

describe("Den plugin skill CRUD UI contract", () => {
  test("exposes the complete create and edit fields inside the plugin route", () => {
    expect(editor).toContain('placeholder="e.g. customer-research"');
    expect(editor).toContain('placeholder="When should an agent use this skill?"');
    expect(editor).toContain('placeholder="# Instructions\\n\\nDescribe the complete workflow..."');
    expect(editor).toContain('"Create skill"');
    expect(editor).toContain('"Save changes"');
    expect(editor).toContain("getPluginSkillRoute(orgSlug, pluginId, saved.id)");
  });

  test("shows the owning plugin's skills with an empty state and add action", () => {
    expect(pluginDetail).toContain("No skills in this plugin yet.");
    expect(pluginDetail).toContain("Add skill");
    expect(pluginDetail).toContain("getNewPluginSkillRoute(orgSlug, plugin.id)");
    expect(pluginDetail).toContain("getPluginSkillRoute(orgSlug, pluginId, skill.id)");
  });

  test("shows the complete body and returns to the plugin after confirmed deletion", () => {
    expect(detail).toContain("Complete skill body");
    expect(detail).not.toContain("font-semibold uppercase tracking-[0.14em]");
    expect(detail).toContain("<pre");
    expect(detail).toContain("border-gray-200 bg-gray-50");
    expect(detail).not.toContain("rounded-xl bg-gray-950");
    expect(detail).toContain("Delete “{skill.name}”?");
    expect(detail).toContain("Delete “{skill.name}”");
    expect(detail).toContain("getPluginRoute(orgSlug, pluginId)");
  });

  test("persists CRUD with plugin and organization scope", () => {
    expect(data).toContain("pluginIds: [pluginId]");
    expect(data).toContain("/plugins`");
    expect(data).toContain("entry.pluginId === pluginId");
    expect(data).toContain('sourceMode: "cloud"');
    expect(data).toContain("/versions`");
    expect(data).toContain("/delete`");
    expect(data).toContain("organizationId");
    expect(data).toContain("pluginQueryKeys.detail(pluginId)");
  });

  test("lets administrators edit and safely archive the owning plugin", () => {
    expect(pluginDetail).toContain('data-testid="plugin-actions-trigger"');
    expect(pluginDetail).toContain("Edit plugin");
    expect(pluginDetail).toContain('data-testid="plugin-edit-save"');
    expect(pluginDetail).toContain("Archive “{pluginName}”?");
    expect(pluginDetail).toContain("without deleting its historical skills");
    expect(pluginDetail).toContain('data-testid="archive-plugin-confirm"');
    expect(pluginData).toContain('runReauthableAction("update-plugin"');
    expect(pluginData).toContain('method: "PATCH"');
    expect(pluginData).toContain('runReauthableAction("archive-plugin"');
    expect(pluginData).toContain("/archive`");
  });

  test("removes the standalone Skills navigation and catalog surface", () => {
    expect(dashboardShell).not.toContain('label: "Skills"');
    expect(dashboardShell).not.toContain("getSkillsRoute");
    expect(pluginsScreen).not.toContain('label: "Skills"');
    expect(pluginsScreen).not.toContain("No skills in this catalog yet.");
    expect(legacySkillsPage).toContain('redirect("/dashboard/plugins")');
  });
});
