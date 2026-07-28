import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function readComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("marketplace plugin assignment", () => {
  const data = readComponent("marketplace-data.tsx");
  const marketplaceDetail = readComponent("marketplace-detail-screen.tsx");
  const pluginDetail = readComponent("plugin-detail-screen.tsx");

  test("uses the relationship assignment routes and refreshes marketplace views", () => {
    expect(data).toContain("/plugins`,");
    expect(data).toContain('{ method: "POST", body: JSON.stringify({ pluginId: input.pluginId }) }');
    expect(data).toContain("/plugins/${encodeURIComponent(input.pluginId)}`");
    expect(data).toContain('{ method: "DELETE" }');
    expect(data.match(/marketplaceQueryKeys\.resolved\(marketplaceId\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(data.match(/marketplaceQueryKeys\.list\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("manages marketplace relationships from a dedicated Plugin tab", () => {
    expect(pluginDetail).toContain('type PluginDetailTab = "contents" | "marketplaces"');
    expect(pluginDetail).toContain('{ value: "marketplaces", label: "Marketplaces", icon: Store');
    expect(pluginDetail).toContain('role="tabpanel" aria-label="Marketplaces"');
    expect(pluginDetail).toContain("plugin-marketplace-assignment-controls");
    expect(pluginDetail).toContain("useMarketplaces()");
    expect(pluginDetail).toContain("!assignedIds.has(marketplace.id)");
    expect(pluginDetail).toContain("Add Marketplace");
    expect(pluginDetail).toContain("Added to every available Marketplace.");
  });

  test("removes only the relationship with confirmation and keeps Marketplace detail read-only", () => {
    expect(pluginDetail).toContain("useRemoveMarketplacePlugin");
    expect(pluginDetail).toContain("confirm-remove-plugin-marketplace");
    expect(pluginDetail).toContain("The Plugin and Marketplace remain available.");
    expect(pluginDetail).toContain("Failed to remove Marketplace.");
    expect(pluginDetail).not.toContain("useDeletePlugin");
    expect(marketplaceDetail).not.toContain("marketplace-plugin-assignment-controls");
    expect(marketplaceDetail).not.toContain("confirm-remove-marketplace-plugin");
    expect(marketplaceDetail).not.toContain("useAssignMarketplacePlugin");
    expect(marketplaceDetail).not.toContain("useRemoveMarketplacePlugin");
  });
});
