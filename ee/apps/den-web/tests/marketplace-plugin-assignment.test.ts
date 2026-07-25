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
  const detail = readComponent("marketplace-detail-screen.tsx");

  test("uses the relationship assignment routes and refreshes marketplace views", () => {
    expect(data).toContain('"/v1/plugins?status=active&limit=100"');
    expect(data).toContain("/plugins`,");
    expect(data).toContain('{ method: "POST", body: JSON.stringify({ pluginId: input.pluginId }) }');
    expect(data).toContain("/plugins/${encodeURIComponent(input.pluginId)}`");
    expect(data).toContain('{ method: "DELETE" }');
    expect(data.match(/marketplaceQueryKeys\.resolved\(marketplaceId\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(data.match(/marketplaceQueryKeys\.list\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("shows admins eligible existing plugins and assignment copy", () => {
    expect(detail).toContain("access.isAdmin ? (");
    expect(detail).toContain("marketplace-plugin-assignment-controls");
    expect(detail).toContain("!assignedPluginIds.has(plugin.id)");
    expect(detail).toContain("Assign an existing plugin");
    expect(detail).toContain("Assign plugin");
    expect(detail).toContain("No eligible plugins");
  });

  test("removes only the marketplace relationship with pending and error feedback", () => {
    expect(detail).toContain("useRemoveMarketplacePlugin");
    expect(detail).toContain("removePlugin.isPending && removePlugin.variables?.pluginId === plugin.id");
    expect(detail).toContain("Removes this plugin from the marketplace only.");
    expect(detail).toContain("Failed to remove plugin.");
    expect(detail).not.toContain("useDeletePlugin");
  });
});
