import type { Seed } from "@openwork/env";

/**
 * More MCP server presets (`expandedMcpPresets`): an organization admin on
 * Manage › Connectors › Add a connector. The full catalog is generally available without a rollout.
 * Nothing is connected or signed in to: the catalog is what is under test.
 */
export async function expandedMcpPresetsWorld(seed: Seed) {
  const den = await seed.den({ org: { name: "Fieldnotes Studio", admin: { name: "Catalog Admin" } } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections/new", headless: true, viewport: { width: 1280, height: 1400 } });
  return { web, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
