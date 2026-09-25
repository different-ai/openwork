import { describe, expect, test } from "bun:test";

import { createDenClient, type DenOrgPlugin } from "../src/app/lib/den";
import {
  connectPluginsForComposer,
  listAssignedConnectCapabilities,
} from "../src/react-app/domains/session/surface/connect-capability-inventory";

describe("assigned OpenWork Connect capability inventory", () => {
  test.each(["workflow", "app"])("keeps assigned %s components returned by Den", async (objectType) => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      items: [{
        marketplaceId: "marketplace_1",
        pluginId: "plugin_1",
        configObjectId: "script_1",
        objectType,
      }],
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    try {
      const capabilities = await createDenClient({ baseUrl: "http://den.local", token: "token" })
        .listAssignedMarketplaceCapabilities("organization_1");

      expect(capabilities).toEqual([{
        marketplaceId: "marketplace_1",
        pluginId: "plugin_1",
        configObjectId: "script_1",
        objectType,
      }]);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });

  test.each([null, "private-author-source"])("projects redacted Apps into Library without installing or exposing source (%s)", async (rawSourceText) => {
    const app = {
      kind: "authored_mcp_app", schemaVersion: 1,
      appId: "cob_00000000000000000000000001", pluginId: "plg_00000000000000000000000002",
      revisionId: "cov_00000000000000000000000003", title: "Planning board",
      description: "Plan the week", textFallback: "Planning board is ready.",
      toolName: "open_app_cob_00000000000000000000000001",
      resourceUri: "ui://openwork/apps/cob_00000000000000000000000001/revisions/cov_00000000000000000000000003/index.html",
    };
    const plugin: DenOrgPlugin = {
      id: app.pluginId, name: "Planning kit", description: null, status: "active",
      memberCount: 1, updatedAt: null, componentCounts: { app: 1 },
    };
    const payloads = [
      { ...app, reactSource: "private-react-source", cssSource: "private-css-source", html: "private-compiled-html" },
      { kind: "remote_mcp_app", sourceUrl: "https://example.test/legacy.html" },
      { ...app, kind: "unknown_app" },
      { ...app, schemaVersion: 2 },
    ];
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = async () => Response.json({ items: payloads.map((payload, index) => ({
      id: `membership_${index}`, pluginId: plugin.id, configObjectId: index === 0 ? app.appId : `legacy_${index}`,
      configObject: {
        id: index === 0 ? app.appId : `legacy_${index}`, objectType: "app", title: index === 0 ? app.title : "Legacy app",
        status: "active", latestVersion: {
          id: app.revisionId, schemaVersion: "openwork.mcp-app/1", rawSourceText, normalizedPayloadJson: payload,
        },
      },
    })) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    try {
      const resolved = await createDenClient({ baseUrl: "http://den.local", token: "token" }).getOrgPluginResolved("org_1", plugin);
      expect(resolved.memberships.map((item) => item.configObject?.objectType)).toEqual(["app", "app", "app", "app"]);
      expect(resolved.memberships[0]?.configObject?.latestVersion?.normalizedPayloadJson).toEqual(app);
      expect(resolved.memberships.every((item) => item.configObject?.latestVersion?.rawSourceText === null)).toBe(true);
      const inventory = await listAssignedConnectCapabilities({
        organizationId: "org_1",
        client: {
          listAssignedMarketplaceCapabilities: async () => [],
          listMeLibraryPlugins: async () => [plugin],
          listOrgMarketplaces: async () => [],
          getOrgMarketplaceResolved: async () => { throw new Error("No marketplace assigned"); },
          getOrgPluginResolved: async () => resolved,
        },
      });
      const cards = connectPluginsForComposer(inventory.plugins);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.files).toEqual([{
        configObjectId: app.appId, objectType: "app", title: app.title,
        path: `openwork-connect://me-library/${app.pluginId}/${app.appId}`,
        versionId: app.revisionId, updatedAt: null, marketplaceName: "Library", pluginName: plugin.name,
        skillName: undefined, skillOrigin: undefined, connectCapabilityName: undefined,
      }]);
      expect(cards[0]?.importedAt).toBeNull();
      expect(inventory.skills).toEqual([]);
      expect(inventory.mcpServers).toEqual([]);
      for (const hidden of ["private-", "legacy.html", ".opencode/", app.toolName, app.resourceUri]) {
        expect(JSON.stringify(cards)).not.toContain(hidden);
      }
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });

  test("normalizes legacy script inventory objects to Workflows", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      items: [{
        marketplaceId: "marketplace_1",
        pluginId: "plugin_1",
        configObjectId: "script_1",
        objectType: "script",
      }],
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    try {
      const capabilities = await createDenClient({ baseUrl: "http://den.local", token: "token" })
        .listAssignedMarketplaceCapabilities("organization_1");

      expect(capabilities).toEqual([{
        marketplaceId: "marketplace_1",
        pluginId: "plugin_1",
        configObjectId: "script_1",
        objectType: "workflow",
      }]);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });

  test("returns active marketplace skills and MCPs with Connect provenance", async () => {
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listAssignedMarketplaceCapabilities: async () => [
          {
            marketplaceId: "marketplace_1",
            pluginId: "plugin_1",
            configObjectId: "skill_1",
            objectType: "skill",
          },
          {
            marketplaceId: "marketplace_1",
            pluginId: "plugin_1",
            configObjectId: "mcp_1",
            objectType: "mcp",
          },
        ],
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
        trigger: "escalate-ticket",
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
    expect(inventory.plugins).toEqual([
      expect.objectContaining({
        pluginId: "plugin_1",
        name: "Support kit",
        marketplaceName: "Team tools",
      }),
    ]);
    expect(inventory.plugins[0]?.files.map((file) => file.objectType)).toEqual(["skill", "mcp"]);
  });

  test("only uses marketplaces visible to the member and ignores inactive objects", async () => {
    let resolvedMarketplaceIds: string[] = [];
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listAssignedMarketplaceCapabilities: async () => [
          {
            marketplaceId: "marketplace_active",
            pluginId: "plugin_1",
            configObjectId: "skill_inactive",
            objectType: "skill",
          },
        ],
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

  test("derives the trigger from Windows-style skill paths and omits it when the path is not a SKILL.md", async () => {
    const marketplace = {
      id: "marketplace_1",
      name: "Team tools",
      description: null,
      status: "active" as const,
      pluginCount: 1,
      updatedAt: null,
    };
    const makeSkill = (id: string, title: string, currentRelativePath: string | null) => ({
      id: `membership_${id}`,
      pluginId: "plugin_1",
      configObjectId: id,
      configObject: {
        id,
        objectType: "skill" as const,
        title,
        description: null,
        currentFileName: null,
        currentFileExtension: null,
        currentRelativePath,
        status: "active" as const,
        updatedAt: null,
        latestVersion: null,
      },
    });

    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listAssignedMarketplaceCapabilities: async () => [
          {
            marketplaceId: "marketplace_1",
            pluginId: "plugin_1",
            configObjectId: "skill_win",
            objectType: "skill",
          },
          {
            marketplaceId: "marketplace_1",
            pluginId: "plugin_1",
            configObjectId: "skill_nomatch",
            objectType: "skill",
          },
        ],
        listOrgMarketplaces: async () => [marketplace],
        getOrgMarketplaceResolved: async () => ({
          marketplace,
          plugins: [
            {
              id: "plugin_1",
              name: "Support kit",
              description: null,
              status: "active",
              memberCount: 2,
              updatedAt: null,
              componentCounts: { skill: 2 },
            },
          ],
        }),
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            makeSkill("skill_win", "Windows skill", "skills\\escalate-ticket\\SKILL.md"),
            makeSkill("skill_nomatch", "Loose skill", "docs/escalate-ticket/README.md"),
          ],
        }),
      },
    });

    const byName = Object.fromEntries(inventory.skills.map((skill) => [skill.name, skill]));
    expect(byName["Windows skill"]?.trigger).toBe("escalate-ticket");
    expect(byName["Loose skill"]?.trigger).toBeUndefined();
  });

  test("includes plugins from My Library even when no marketplace is assigned", async () => {
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listAssignedMarketplaceCapabilities: async () => [],
        listMeLibraryPlugins: async () => [
          { id: "plugin_mine", name: "Briefing kit", description: "My plugin" },
        ],
        listOrgMarketplaces: async () => [],
        getOrgMarketplaceResolved: async () => {
          throw new Error("marketplace resolve should not run");
        },
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            {
              id: "membership_skill",
              pluginId: plugin.id,
              configObjectId: "skill_mine",
              configObject: {
                id: "skill_mine",
                objectType: "skill",
                title: "Customer briefing",
                description: null,
                currentFileName: "SKILL.md",
                currentFileExtension: "md",
                currentRelativePath: "skills/customer-briefing/SKILL.md",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_skill",
                  rawSourceText: "# Brief",
                  normalizedPayloadJson: null,
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
          ],
        }),
      },
    });

    expect(inventory.plugins).toEqual([
      expect.objectContaining({
        pluginId: "plugin_mine",
        name: "Briefing kit",
        marketplaceName: "Library",
      }),
    ]);
    expect(inventory.skills.map((skill) => skill.name)).toEqual(["Customer briefing"]);
  });
});
