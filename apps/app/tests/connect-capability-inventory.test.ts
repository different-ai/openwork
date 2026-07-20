import { describe, expect, test } from "bun:test";

import {
  listAssignedConnectCapabilities,
} from "../src/react-app/domains/session/surface/connect-capability-inventory";

describe("assigned OpenWork Connect capability inventory", () => {
  test("returns active marketplace skills and MCPs with Connect provenance", async () => {
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listOrgMarketplaces: async () => [
          {
            id: "marketplace_1",
            name: "Team tools",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
        ],
        getOrgMarketplaceResolved: async () => ({
          marketplace: {
            id: "marketplace_1",
            name: "Team tools",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
          plugins: [
            {
              id: "plugin_1",
              name: "Support kit",
              description: null,
              status: "active",
              memberCount: 2,
              updatedAt: null,
              componentCounts: { skill: 1, mcp: 1 },
              cloudReadiness: {
                state: "ready",
                hasInstructional: true,
                connections: [
                  {
                    id: "connection_1",
                    name: "Support search",
                    url: "https://support.example.test/mcp",
                    configObjectId: "mcp_1",
                    serverName: "support",
                    credentialMode: "shared",
                    connectedForMe: true,
                  },
                ],
              },
            },
          ],
        }),
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            {
              id: "membership_skill",
              pluginId: plugin.id,
              configObjectId: "skill_1",
              configObject: {
                id: "skill_1",
                objectType: "skill",
                title: "Escalate ticket",
                description: "Prepare a support escalation.",
                currentFileName: "SKILL.md",
                currentFileExtension: "md",
                currentRelativePath: "skills/escalate-ticket/SKILL.md",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_skill",
                  rawSourceText: "# Escalate ticket",
                  normalizedPayloadJson: null,
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
            {
              id: "membership_mcp",
              pluginId: plugin.id,
              configObjectId: "mcp_1",
              configObject: {
                id: "mcp_1",
                objectType: "mcp",
                title: "Support MCP",
                description: null,
                currentFileName: "support.json",
                currentFileExtension: "json",
                currentRelativePath: "mcp/support.json",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_mcp",
                  rawSourceText: null,
                  normalizedPayloadJson: {
                    mcpServers: {
                      support: {
                        url: "https://support.example.test/mcp",
                        headers: { Authorization: "Bearer ${SUPPORT_TOKEN}" },
                      },
                    },
                  },
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
          ],
        }),
      },
    });

    expect(inventory.skills).toEqual([
      expect.objectContaining({
        name: "Escalate ticket",
        origin: "openwork-connect",
        marketplaceName: "Team tools",
        pluginName: "Support kit",
        connectCapabilityName: "plugin:plugin_1:skill_1",
      }),
    ]);
    expect(inventory.mcpServers).toEqual([
      expect.objectContaining({
        name: "Support MCP",
        origin: "openwork-connect",
        marketplaceName: "Team tools",
        pluginName: "Support kit",
        config: {
          type: "remote",
          url: "https://support.example.test/mcp",
        },
      }),
    ]);
    expect(inventory.mcpStatuses[inventory.mcpServers[0]?.id ?? ""]).toEqual({ status: "connected" });
  });

  test("only uses marketplaces visible to the member and ignores inactive objects", async () => {
    let resolvedMarketplaceIds: string[] = [];
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listOrgMarketplaces: async () => [
          {
            id: "marketplace_active",
            name: "Assigned",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
          {
            id: "marketplace_archived",
            name: "Archived",
            description: null,
            status: "archived",
            pluginCount: 1,
            updatedAt: null,
          },
        ],
        getOrgMarketplaceResolved: async (_organizationId, marketplaceId) => {
          resolvedMarketplaceIds.push(marketplaceId);
          return {
            marketplace: {
              id: marketplaceId,
              name: "Assigned",
              description: null,
              status: "active",
              pluginCount: 1,
              updatedAt: null,
            },
            plugins: [
              {
                id: "plugin_1",
                name: "Assigned plugin",
                description: null,
                status: "active",
                memberCount: 1,
                updatedAt: null,
                componentCounts: { skill: 1 },
              },
            ],
          };
        },
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            {
              id: "membership_1",
              pluginId: plugin.id,
              configObjectId: "skill_inactive",
              configObject: {
                id: "skill_inactive",
                objectType: "skill",
                title: "Old skill",
                description: null,
                currentFileName: null,
                currentFileExtension: null,
                currentRelativePath: null,
                status: "archived",
                updatedAt: null,
                latestVersion: null,
              },
            },
          ],
        }),
      },
    });

    expect(resolvedMarketplaceIds).toEqual(["marketplace_active"]);
    expect(inventory.skills).toEqual([]);
    expect(inventory.mcpServers).toEqual([]);
  });
});
