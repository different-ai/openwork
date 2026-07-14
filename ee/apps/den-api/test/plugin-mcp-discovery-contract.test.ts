import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { pluginArchEndpointContracts, pluginArchRoutePaths } from "../src/routes/org/plugin-system/contracts.js"
import {
  githubPluginMcpImportPreviewResponseSchema,
  githubPluginMcpImportResponseSchema,
  githubPluginMcpImportSchema,
  pluginMcpRequirementConfigureResponseSchema,
  pluginMcpRequirementDiscoveryRequestSchema,
  pluginMcpRequirementDiscoveryResponseSchema,
} from "../src/routes/org/plugin-system/schemas.js"

const marketplaceId = createDenTypeId("marketplace")
const configObjectId = createDenTypeId("configObject")
const pluginId = createDenTypeId("plugin")

function configurationDiscovery() {
  return {
    auth: { confidence: "verified" as const, kind: "oauth" as const, source: "live_protocol" as const },
    inputs: [],
    oauth: {
      authorizationServer: "https://auth.example.test/",
      clientIdRequired: false,
      clientSecretRequired: false,
      documentationUrl: null,
      pkce: "s256" as const,
      registration: "dynamic" as const,
      scopes: ["issues:read"],
      scopesSource: "challenge" as const,
    },
    support: { status: "auto_configurable" as const },
    transport: { kind: "remote_http" as const, supported: true, url: "https://mcp.example.test/mcp" },
    warnings: [],
  }
}

describe("plugin MCP discovery contracts", () => {
  test("threads the request-derived public base through Marketplace and GitHub OAuth callbacks", () => {
    const routeSource = readFileSync(new URL("../src/routes/org/plugin-system/routes.ts", import.meta.url), "utf8")
    const storeSource = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")

    expect(routeSource.match(
      /apiPublicBaseUrl: resolvePublicOrigin\(c\.req\.raw, env\.apiPublicUrl\)/g,
    ) ?? []).toHaveLength(2)
    expect(routeSource).toMatch(
      /configureMarketplacePluginMcpRequirement\(\{[\s\S]*?apiPublicBaseUrl: resolvePublicOrigin\(c\.req\.raw, env\.apiPublicUrl\)/,
    )
    expect(routeSource).toMatch(
      /importGithubPluginMcps\(\{[\s\S]*?apiPublicBaseUrl: resolvePublicOrigin\(c\.req\.raw, env\.apiPublicUrl\)/,
    )
    expect(storeSource.match(
      /pluginMcpValidationRedirectUri\(connection\.id, input\.apiPublicBaseUrl\)/g,
    ) ?? []).toHaveLength(2)
  })

  test("pins GitHub file reads to the previewed commit and applies declared scope fallbacks", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("encodeURIComponent(input.snapshot.headSha)")
    expect(source).not.toContain("encodeURIComponent(input.branch)")
    expect(source).toContain("requestedOAuthScopes")
    expect(source).toContain("assertPluginMcpDiscoveryAllowsConfiguration")
  })

  test("keeps plugin discovery server-derived and admin-only", () => {
    expect(pluginArchRoutePaths.pluginMcpConnectionDiscovery).toBe("/v1/plugins/:pluginId/mcp-connections/discover")
    expect(pluginArchEndpointContracts.discoverPluginMcpRequirement).toMatchObject({
      audience: "admin",
      method: "POST",
      path: pluginArchRoutePaths.pluginMcpConnectionDiscovery,
    })
    expect(pluginMcpRequirementDiscoveryRequestSchema.safeParse({ configObjectId, serverName: "atlassian" }).success).toBe(true)
    expect(pluginMcpRequirementDiscoveryRequestSchema.safeParse({
      configObjectId,
      serverName: "atlassian",
      url: "https://attacker.example/mcp",
    }).success).toBe(true)
    expect(Object.keys(pluginMcpRequirementDiscoveryRequestSchema.parse({ configObjectId, serverName: "atlassian", url: "https://attacker.example/mcp" }))).toEqual([
      "configObjectId",
      "serverName",
    ])
  })

  test("returns discovery evidence with the effective assignment union", () => {
    const response = pluginMcpRequirementDiscoveryResponseSchema.parse({
      ok: true,
      item: {
        assignment: {
          access: { memberIds: [], orgWide: true, teamIds: [] },
          policy: "union_of_active_config_object_plugin_and_marketplace_grants",
        },
        configObjectId,
        discovery: configurationDiscovery(),
        pluginId,
        serverName: "atlassian",
        url: "https://mcp.example.test/mcp",
      },
    })

    expect(response.item.assignment.access.orgWide).toBe(true)
    expect(response.item.discovery.oauth?.scopes).toEqual(["issues:read"])
  })

  test("allows configure to return the exact pre-registered OAuth callback", () => {
    const oauthCallback = "https://api.example.test/v1/mcp-connections/connection/connect/callback"
    const response = pluginMcpRequirementConfigureResponseSchema.parse({
      ok: true,
      item: {
        binding: {
          id: createDenTypeId("pluginMcpRequirementBinding"),
          configObjectId,
          externalMcpConnectionId: "connection",
          pluginId,
          serverName: "atlassian",
        },
        connection: {
          id: "connection",
          name: "Plugin / Atlassian",
          url: "https://mcp.example.test/mcp",
          authType: "oauth",
          credentialMode: "per_member",
          connected: false,
          connectedAt: null,
        },
        links: { oauthCallback, yourConnections: "https://app.example.test/dashboard/your-connections" },
      },
    })

    expect(response.item.links.oauthCallback).toBe(oauthCallback)
  })
})

describe("GitHub MCP import compatibility", () => {
  test("keeps all import materialization inside one crash-atomic publication transaction", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    const importSource = source.slice(
      source.indexOf("export async function importGithubPluginMcps"),
      source.indexOf("function readGithubDiscoveryCache"),
    )
    const publicationSource = source.slice(
      source.indexOf("async function publishGithubImportAtomically"),
      source.indexOf("async function publishStagedGithubImport"),
    )
    expect(importSource).toContain("prepareGithubImportExternalMcpConnection")
    expect(importSource).toContain("publishGithubImportAtomically")
    expect(importSource).toContain("claimLegacyGithubImportSource")
    expect(importSource).not.toContain("createStagedGithubImportPlugin")
    expect(importSource).not.toContain("rollbackGithubPluginMcpImport")
    expect(publicationSource).toContain("const publication = await db.transaction(async (tx) =>")
    expect(publicationSource).toContain("await tx.insert(PluginTable)")
    expect(publicationSource).toContain("await tx.insert(ExternalMcpConnectionTable)")
    expect(publicationSource).toContain("await tx.insert(OrgOAuthClientTable)")
    expect(publicationSource).toContain("await tx.insert(ConfigObjectTable)")
    expect(publicationSource).toContain("await tx.insert(PluginMcpRequirementBindingTable)")
    expect(publicationSource).toContain("await tx.insert(MarketplacePluginTable)")
  })

  test("publishes immutable provenance, assignments, derived grants, and readiness atomically", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("GITHUB_MCP_IMPORT_MATERIALIZATION_RESERVE_MS")
    expect(source).toContain("GITHUB_MCP_IMPORT_FINAL_COMMIT_RESERVE_MS")
    expect(source).toContain("MAX_GITHUB_MCP_IMPORT_COMPONENTS")
    expect(source).toContain("MAX_GITHUB_MCP_IMPORT_ACCESS_TARGETS")
    expect(source).toContain("githubImportViewerAccessGrantRows")
    expect(source).toContain("assertGithubImportAccessTargetsForPublication")
    expect(source).toContain("github_import_authority_changed")
    expect(source).toContain('memberHasRole(actor.role, "admin")')
    expect(source).toContain("PluginImportSourceTable")
    expect(source).toContain("githubPluginImportSourceKey")
    expect(source).toContain("const oldestLegacyDescription = `Plugin components imported from ${legacySource}.`")
    expect(source).toContain("const revisionedLegacyPrefix = `Plugin components imported from ${legacySource} at immutable GitHub revision `")
    expect(source).toContain("if (existingLegacyClaim[0]) return null")
    expect(source).toContain("await tx.insert(MarketplacePluginTable)")
    expect(source).toContain("derivedAccessRows")
    expect(source).toContain("assertGithubImportPublicationAvailable")
    expect(source).toContain("github_plugin_already_imported")
    expect(source).toContain(".from(OrganizationTable)")
    expect(source).toContain('.for("update")')
    expect(source).not.toContain("grantImportAccessToPluginArchResource")
  })

  test("treats an explicitly empty server-key selection as a skills-only import", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("input.selectedServerKeys !== undefined")
    expect(source).toContain("plan.servers.filter((server) => selectedServerKeys.has(server.serverKey))")
  })

  test("requires reviewed revisions, excludes inferred no-auth legacy defaults, and bounds validation", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("input.selectedServerKeys !== undefined && input.selectedServerKeys.length > 0")
    expect(source).toContain("input.selectedServerNames?.length")
    expect(source).toContain('server.discovery?.support.status !== "needs_review"')
    expect(source).toContain("github_server_review_required")
    expect(source).toContain("MAX_GITHUB_MCP_IMPORT_SELECTIONS")
    expect(source).toContain("const MAX_GITHUB_MCP_IMPORT_SELECTIONS = 12")
    expect(source).toContain("requireVerifiedOauthPkce: configuration.authType === \"oauth\"")
    expect(source).toContain("createExternalMcpLifecycleDeadline")
    expect(source).toContain("githubMcpRemainingTimeoutMs")
  })

  test("uses bounded opaque server keys and persists trusted live discovery scopes", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain('createHash("sha256")')
    expect(source).toContain('return `github-mcp:${digest}`')
    expect(source).toContain("validatedDiscoveries")
    expect(source).toContain("trustedPluginMcpRequestedOAuthScopes")
  })

  test("treats fresh live discovery as authoritative over manifest-only auth inference", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    const configurationSource = source.slice(
      source.indexOf("function githubPluginMcpServerConfiguration"),
      source.indexOf("type GithubImportOAuthClientMutation"),
    )
    expect(configurationSource).not.toContain("input.configured.authType !== discoveredAuthType")
    expect(source).toContain("assertPluginMcpDiscoveryAllowsConfiguration({")
    expect(source).toContain("requireVerifiedOauthPkce: configuration.authType === \"oauth\"")
  })

  test("persists the reviewed immutable GitHub revision on every imported artifact", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")

    expect(source).toContain("githubImportedPluginDescription(input.canonicalGithubUrl)")
    expect(source).toContain("sourceRevisionRef: normalizeOptionalString(input.value.sourceRevisionRef)")
    expect(source).toContain("sourceRevisionRef: input.plan.sourceRevisionRef")
    expect(source).toContain("revision: input.sourceRevisionRef")
    expect(source).toContain("GitHub source: ${input.repositoryFullName}@${input.sourceRevisionRef}:${input.skill.sourcePath}")
    expect(source).toContain("github_source_revision_required")
  })

  test("persists only a canonical credential-free GitHub source URL", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("const canonicalGithubUrl = parsePublicGithubPluginUrl(input.githubUrl).canonicalUrl")
    expect(source).toContain("githubUrl: canonicalGithubUrl")
    expect(source).toContain("canonicalUrl: input.canonicalGithubUrl")
  })

  test("only reclaims plugin-owned imported connections after their bindings are gone", () => {
    const source = readFileSync(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url), "utf8")
    expect(source).toContain("PluginManagedExternalMcpConnectionTable")
    expect(source).toContain("managedByPluginImport")
    expect(source).toContain("deleteOwnedImportedExternalMcpConnectionsWithoutBindings")
    expect(source).toContain("deleteExternalMcpConnectionIfUnused")
    expect(source).toContain("allowConnectedAt: true")
    expect(source).toContain("importedExternalMcpConnectionCleanupSnapshots")
    expect(source).toContain("expectedConnection: expected?.connection")
    expect(source).toContain("expectedOwnedOAuthClient: expected?.oauthClient ?? undefined")
    expect(source).toContain("legacyOwnerPluginIds")
    expect(source).toContain(".onDuplicateKeyUpdate({ set: { createdByPluginId: legacyOwnerPluginId } })")
  })

  test("retains legacy global authentication defaults", () => {
    const parsed = githubPluginMcpImportSchema.parse({
      githubUrl: "https://github.com/example/mcp-plugin",
      marketplaceId,
    })

    expect(parsed.authType).toBe("oauth")
    expect(parsed.credentialMode).toBe("per_member")
    expect(parsed.serverConfigurations).toEqual([])
  })

  test("accepts stable per-server API key and OAuth client configuration", () => {
    const parsed = githubPluginMcpImportSchema.parse({
      githubUrl: "https://github.com/example/mcp-plugin",
      marketplaceId,
      sourceRevisionRef: "abc123",
      serverConfigurations: [
        { serverKey: "plugin:path:exa:url", authType: "apikey", apiKey: "secret" },
        { serverKey: "plugin:path:atlassian:url", authType: "oauth", credentialMode: "per_member", oauthClient: { clientId: "client-id" } },
      ],
    })

    expect(parsed.serverConfigurations).toHaveLength(2)
    expect(parsed.sourceRevisionRef).toBe("abc123")
    expect(parsed.serverConfigurations[0]).toMatchObject({ authType: "apikey", serverKey: "plugin:path:exa:url" })
  })

  test("rejects mismatched, missing, and duplicate per-server credentials", () => {
    const base = { githubUrl: "https://github.com/example/mcp-plugin", marketplaceId }
    expect(githubPluginMcpImportSchema.safeParse({
      ...base,
      serverConfigurations: [{ serverKey: "exa", authType: "apikey" }],
    }).success).toBe(false)
    expect(githubPluginMcpImportSchema.safeParse({
      ...base,
      serverConfigurations: [{ serverKey: "public", authType: "none", apiKey: "secret" }],
    }).success).toBe(false)
    expect(githubPluginMcpImportSchema.safeParse({
      ...base,
      serverConfigurations: [
        { serverKey: "duplicate", authType: "none" },
        { serverKey: "duplicate", authType: "oauth" },
      ],
    }).success).toBe(false)
  })

  test("projects a discovery descriptor per supported preview server", () => {
    const response = githubPluginMcpImportPreviewResponseSchema.parse({
      ok: true,
      item: {
        branch: "main",
        classification: "claude_single_plugin_repo",
        marketplace: null,
        plugins: [{ description: null, key: "plugin", mcpCount: 1, name: "Plugin", skillCount: 0 }],
        repositoryFullName: "example/mcp-plugin",
        rootPath: "",
        servers: [{
          authType: "oauth",
          connectionId: null,
          discovery: configurationDiscovery(),
          name: "atlassian",
          pluginKey: "plugin",
          pluginName: "Plugin",
          serverKey: "plugin:path:atlassian:url",
          skippedReason: null,
          sourcePath: ".mcp.json",
          supported: true,
          url: "https://mcp.example.test/mcp",
        }],
        skills: [],
        sourceRevisionRef: "abc123",
        warnings: [],
      },
    })

    expect(response.item.servers[0]?.discovery?.auth.kind).toBe("oauth")
  })

  test("allows previews to report dynamically discovered authentication kinds", () => {
    for (const authType of ["apikey", "none", "unknown"] as const) {
      const parsed = githubPluginMcpImportPreviewResponseSchema.safeParse({
        ok: true,
        item: {
          branch: "main",
          classification: "claude_single_plugin_repo",
          marketplace: null,
          plugins: [{ description: null, key: "plugin", mcpCount: 1, name: "Plugin", skillCount: 0 }],
          repositoryFullName: "example/mcp-plugin",
          rootPath: "",
          servers: [{
            authType,
            connectionId: null,
            discovery: null,
            name: "server",
            pluginKey: "plugin",
            pluginName: "Plugin",
            serverKey: `plugin:path:${authType}:url`,
            skippedReason: null,
            sourcePath: ".mcp.json",
            supported: true,
            url: "https://mcp.example.test/mcp",
          }],
          skills: [],
          sourceRevisionRef: "abc123",
          warnings: [],
        },
      })
      expect(parsed.success).toBe(true)
    }
  })

  test("returns exact OAuth callback URLs only for pre-registered imported clients", () => {
    const oauthCallback = "https://api.example.test/v1/mcp-connections/connection/connect/callback"
    const response = githubPluginMcpImportResponseSchema.parse({
      ok: true,
      item: {
        imported: [{ connectionId: "connection", name: "Atlassian", oauthCallback, url: "https://mcp.example.test/mcp" }],
        importedSkills: [],
        marketplaceId,
        plugin: {
          id: pluginId,
          organizationId: createDenTypeId("organization"),
          createdByOrgMembershipId: createDenTypeId("member"),
          name: "Plugin",
          description: null,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          marketplaces: [],
          extension: {
            id: pluginId,
            name: "Plugin",
            description: null,
            sourceFormat: "claude-plugin",
            manifest: {
              schemaVersion: 1,
              id: pluginId,
              name: "Plugin",
              description: "Plugin extension",
              source: { format: "claude-plugin", origin: "den", reference: pluginId, trusted: false },
              resources: [],
              contributions: [{ type: "setup-instructions", ref: "den.claudePlugin.setup", label: "Claude-compatible plugin import", location: "settings-detail" }],
              setup: { instructions: "Imported from a Claude-compatible plugin." },
              lifecycle: { detection: [] },
            },
          },
        },
        skipped: [],
        skippedSkills: [],
      },
    })

    expect(response.item.imported[0]?.oauthCallback).toBe(oauthCallback)
  })
})
