import type { Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";

/**
 * More MCP server presets (`expandedMcpPresets`): an organization admin on
 * Manage › Connectors › Add a connector. The flag starts off, as it ships; the
 * proof turns it on and off through the platform-admin route /admin uses.
 * Nothing is connected or signed in to: the catalog is what is under test.
 */
export async function expandedMcpPresetsWorld(seed: Seed) {
  const den = await seed.den({ org: { name: "Fieldnotes Studio", admin: { name: "Catalog Admin" } } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Could not resolve the synthetic organization.");

  async function setExpandedPresets(enabled: boolean) {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilities: { expandedMcpPresets: enabled } }),
    });
    if (!result.response.ok) throw new Error(`Could not set expandedMcpPresets=${enabled}: ${result.text}`);
  }

  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections/new", headless: true, viewport: { width: 1280, height: 1400 } });
  return { web, setExpandedPresets, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
