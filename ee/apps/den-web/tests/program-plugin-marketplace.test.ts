import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const components = join(import.meta.dir, "../app/(den)/dashboard/_components");
const marketplaceDetail = readFileSync(join(components, "marketplace-detail-screen.tsx"), "utf8");
const pluginData = readFileSync(join(components, "plugin-data.tsx"), "utf8");
const pluginDetail = readFileSync(join(components, "plugin-detail-screen.tsx"), "utf8");
const libraryData = readFileSync(join(components, "library-data.tsx"), "utf8");
const libraryScreen = readFileSync(join(components, "library-screen.tsx"), "utf8");
const programDetail = readFileSync(join(components, "program-detail-screen.tsx"), "utf8");

describe("Program Plugin and Marketplace presentation", () => {
  test("presents saved Code Mode scripts as Programs inside Plugins", () => {
    expect(pluginData).toContain("export type PluginProgram");
    expect(pluginData).toContain("programs: PluginProgram[]");
    expect(pluginData).toContain('objectType === "script"');
    expect(pluginDetail).toContain("No Programs in this Plugin yet.");
    expect(pluginDetail).toContain("Add Program");
    expect(pluginDetail).toContain("collection audiences");
    expect(pluginDetail).toContain("Create one from a successful Code Mode run");
    expect(pluginData).toContain("useAttachProgramToPlugin");
    expect(pluginData).toContain("/config-objects`");
    expect(pluginData).toContain('membershipSource: "manual"');
    expect(pluginDetail).not.toContain('label="Scripts"');
  });

  test("labels Program component counts on Marketplace Plugin rows", () => {
    expect(marketplaceDetail).toContain('script: { singular: "Program", plural: "Programs" }');
    expect(marketplaceDetail).toContain("componentTypeLabel(type, count)");
  });

  test("does not render an inaccessible parent Plugin for a directly shared Program", () => {
    expect(libraryData).toContain("plugin: LibraryNamedEntity | null");
    expect(libraryScreen).toContain("item.plugin ? `Plugin ${item.plugin.name} · ` : \"\"");
    expect(programDetail).toContain("detail.program.plugin ?");
    expect(pluginDetail).toContain('program.plugin ? `Currently in ${program.plugin.name}` : "Shared directly"');
  });
});
