import { expect, test } from "bun:test";

import type {
  DenOrgMarketplace,
  DenOrgPlugin,
  DenPluginConfigObject,
} from "../src/app/lib/den";
import {
  listAssignedConnectCapabilities,
  type ConnectCapabilityClient,
} from "../src/react-app/domains/session/surface/connect-capability-inventory";

const marketplace = (id: string, name: string): DenOrgMarketplace => ({
  id,
  name,
  description: null,
  status: "active",
  pluginCount: 1,
  updatedAt: null,
});

const plugin = (id: string, name: string): DenOrgPlugin => ({
  id,
  name,
  description: null,
  status: "active",
  memberCount: 1,
  updatedAt: null,
  componentCounts: {},
});

const configObject = (
  id: string,
  objectType: "mcp" | "skill",
  title: string,
): DenPluginConfigObject => ({
  id,
  objectType,
  title,
  description: title,
  currentFileName: null,
  currentFileExtension: objectType === "mcp" ? ".json" : ".md",
  currentRelativePath: objectType === "skill" ? `skills/${id}/SKILL.md` : `mcps/${id}.json`,
  status: "active",
  updatedAt: null,
  latestVersion: {
    id: `version-${id}`,
    rawSourceText: objectType === "skill" ? `# ${title}` : null,
    normalizedPayloadJson: objectType === "mcp"
      ? { mcpServers: { [id]: { url: `https://${id}.example.test/mcp` } } }
      : null,
    sourceRevisionRef: null,
    createdAt: null,
  },
});

test("admin desktop inventory intersects management data with assigned capability references", async () => {
  const assignedMarketplace = marketplace("market-assigned", "Assigned marketplace");
  const adminOnlyMarketplace = marketplace("market-admin", "Admin-only marketplace");
  const mixedPlugin = plugin("plugin-mixed", "Mixed plugin");
  const assignedMcpPlugin = plugin("plugin-mcp", "Assigned MCP plugin");
  const adminOnlyPlugin = plugin("plugin-admin", "Admin-only plugin");

  const client = {
    async listAssignedMarketplaceCapabilities() {
      return [
        {
          marketplaceId: assignedMarketplace.id,
          pluginId: mixedPlugin.id,
          configObjectId: "skill-assigned",
          objectType: "skill" as const,
        },
        {
          marketplaceId: assignedMarketplace.id,
          pluginId: assignedMcpPlugin.id,
          configObjectId: "mcp-assigned",
          objectType: "mcp" as const,
        },
      ];
    },
    async listOrgMarketplaces() {
      return [assignedMarketplace, adminOnlyMarketplace];
    },
    async getOrgMarketplaceResolved(_organizationId: string, marketplaceId: string) {
      return marketplaceId === assignedMarketplace.id
        ? { marketplace: assignedMarketplace, plugins: [mixedPlugin, assignedMcpPlugin] }
        : { marketplace: adminOnlyMarketplace, plugins: [adminOnlyPlugin] };
    },
    async getOrgPluginResolved(_organizationId: string, selectedPlugin: DenOrgPlugin) {
      const objects = selectedPlugin.id === mixedPlugin.id
        ? [
            configObject("skill-assigned", "skill", "Assigned Skill"),
            configObject("mcp-admin-only", "mcp", "Unassigned MCP"),
          ]
        : selectedPlugin.id === assignedMcpPlugin.id
          ? [configObject("mcp-assigned", "mcp", "Assigned MCP")]
          : [configObject("skill-admin-only", "skill", "Admin-only Skill")];
      return {
        plugin: selectedPlugin,
        memberships: objects.map((object) => ({
          id: `membership-${object.id}`,
          pluginId: selectedPlugin.id,
          configObjectId: object.id,
          configObject: object,
        })),
      };
    },
  } satisfies ConnectCapabilityClient;

  const inventory = await listAssignedConnectCapabilities({
    client,
    organizationId: "org-admin",
  });

  expect(inventory.skills.map((skill) => skill.name)).toEqual(["Assigned Skill"]);
  expect(inventory.mcpServers.map((server) => server.name)).toEqual(["Assigned MCP"]);
  expect(inventory.mcpServers.some((server) => server.name === "Unassigned MCP")).toBe(false);
});
