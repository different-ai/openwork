import { describe, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { planManagedImportedConfigObjectCleanup } from "../src/routes/org/plugin-system/managed-component-cleanup.js"

function version(normalizedPayloadJson: Record<string, unknown> | null) {
  return { normalizedPayloadJson }
}

describe("managed imported component cleanup planning", () => {
  test("deletes plugin-owned imported skills and MCP connections with no active references", () => {
    const skillId = createDenTypeId("skill")
    const connectionId = createDenTypeId("externalMcpConnection")

    const result = planManagedImportedConfigObjectCleanup({
      active: [],
      deleting: [{
        latestVersion: version({ denSkillId: skillId, openworkManaged: "den_skill" }),
        objectType: "skill",
      }, {
        latestVersion: version({
          externalMcpConnectionId: connectionId,
          externalMcpConnectionOwnedByPlugin: true,
          openworkManaged: "den_external_mcp",
        }),
        objectType: "mcp",
      }, {
        latestVersion: version({
          denSkillId: skillId,
          openworkManaged: "den_skill",
        }),
        objectType: "skill",
      }],
    })

    expect(result).toEqual({
      externalMcpConnectionIds: [connectionId],
      skillIds: [skillId],
    })
  })

  test("keeps underlying skills and MCP connections referenced by other active imported config objects", () => {
    const skillId = createDenTypeId("skill")
    const connectionId = createDenTypeId("externalMcpConnection")

    const result = planManagedImportedConfigObjectCleanup({
      active: [{
        latestVersion: version({ denSkillId: skillId, openworkManaged: "den_skill" }),
        objectType: "skill",
      }, {
        latestVersion: version({
          mcpServers: {
            sales: {
              externalMcpConnectionId: connectionId,
              openworkManaged: "den_external_mcp",
              url: "https://example.com/mcp",
            },
          },
        }),
        objectType: "mcp",
      }],
      deleting: [{
        latestVersion: version({ denSkillId: skillId, openworkManaged: "den_skill" }),
        objectType: "skill",
      }, {
        latestVersion: version({
          externalMcpConnectionId: connectionId,
          externalMcpConnectionOwnedByPlugin: true,
          openworkManaged: "den_external_mcp",
        }),
        objectType: "mcp",
      }],
    })

    expect(result).toEqual({
      externalMcpConnectionIds: [],
      skillIds: [],
    })
  })

  test("does not delete external MCP connections the plugin import does not own", () => {
    const ownedConnectionId = createDenTypeId("externalMcpConnection")
    const sharedConnectionId = createDenTypeId("externalMcpConnection")

    const result = planManagedImportedConfigObjectCleanup({
      active: [],
      deleting: [{
        latestVersion: version({
          externalMcpConnectionId: sharedConnectionId,
          externalMcpConnectionOwnedByPlugin: false,
          openworkManaged: "den_external_mcp",
        }),
        objectType: "mcp",
      }, {
        latestVersion: version({
          externalMcpConnectionId: createDenTypeId("externalMcpConnection"),
          openworkManaged: "den_external_mcp",
        }),
        objectType: "mcp",
      }, {
        latestVersion: version({
          mcpServers: {
            owned: {
              externalMcpConnectionId: ownedConnectionId,
              externalMcpConnectionOwnedByPlugin: true,
              openworkManaged: "den_external_mcp",
              url: "https://example.com/owned",
            },
            shared: {
              externalMcpConnectionId: sharedConnectionId,
              externalMcpConnectionOwnedByPlugin: false,
              openworkManaged: "den_external_mcp",
              url: "https://example.com/shared",
            },
          },
        }),
        objectType: "mcp",
      }],
    })

    expect(result).toEqual({
      externalMcpConnectionIds: [ownedConnectionId],
      skillIds: [],
    })
  })

  test("ignores malformed managed payload metadata", () => {
    const result = planManagedImportedConfigObjectCleanup({
      active: [],
      deleting: [{
        latestVersion: undefined,
        objectType: "skill",
      }, {
        latestVersion: version(null),
        objectType: "mcp",
      }, {
        latestVersion: version({
          denSkillId: "not-a-skill-id",
          openworkManaged: "den_skill",
        }),
        objectType: "skill",
      }, {
        latestVersion: version({
          externalMcpConnectionId: "not-a-connection-id",
          externalMcpConnectionOwnedByPlugin: true,
          openworkManaged: "den_external_mcp",
        }),
        objectType: "mcp",
      }, {
        latestVersion: version({
          denSkillId: createDenTypeId("skill"),
          openworkManaged: "unknown",
        }),
        objectType: "skill",
      }],
    })

    expect(result).toEqual({
      externalMcpConnectionIds: [],
      skillIds: [],
    })
  })
})
