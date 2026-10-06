import { declarativeDeleteSchema, declarativeResponses, externalKeyParamsSchema, isDuplicateEntry } from "../declarative.js"
import { findMarketplaceByExternalKey } from "./store.js"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { queryValidator, jsonValidator, paramValidator } from "../../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../../openapi.js"
import type { OrgRouteVariables } from "../shared.js"
import {
  accessGrantListResponseSchema,
  accessGrantMutationResponseSchema,
  configObjectAccessGrantParamsSchema,
  configObjectCreateSchema,
  configObjectCreateVersionSchema,
  configObjectDetailResponseSchema,
  configObjectListQuerySchema,
  configObjectListResponseSchema,
  configObjectMutationResponseSchema,
  configObjectParamsSchema,
  configObjectPluginAttachSchema,
  configObjectVersionDetailResponseSchema,
  configObjectVersionListQuerySchema,
  configObjectVersionListResponseSchema,
  configObjectVersionParamsSchema,
  githubPluginMcpImportPreviewResponseSchema,
  githubPluginMcpImportPreviewSchema,
  githubPluginMcpImportResponseSchema,
  githubPluginMcpImportSchema,
  marketplaceAccessGrantParamsSchema,
  marketplaceCreateSchema,
  marketplaceDetailResponseSchema,
  marketplaceListQuerySchema,
  marketplaceListResponseSchema,
  marketplaceMutationResponseSchema,
  marketplaceParamsSchema,
  marketplacePluginListResponseSchema,
  marketplaceResolvedResponseSchema,
  marketplacePluginMutationResponseSchema,
  marketplacePluginParamsSchema,
  marketplacePluginWriteSchema,
  marketplaceUpdateSchema,
  meLibraryListResponseSchema,
  mePluginAccessListResponseSchema,
  pluginAccessGrantParamsSchema,
  pluginCreateSchema,
  pluginDetailResponseSchema,
  pluginListQuerySchema,
  pluginListResponseSchema,
  pluginMcpRequirementConfigureResponseSchema,
  pluginMcpRequirementConfigureSchema,
  pluginMembershipListResponseSchema,
  pluginMembershipMutationResponseSchema,
  pluginMembershipWriteSchema,
  pluginMutationResponseSchema,
  pluginParamsSchema,
  pluginUpdateSchema,
  resourceAccessGrantWriteSchema,
  teamParamsSchema,
  teamPluginAccessListResponseSchema,
} from "./schemas.js"
import { isPluginArchOrgAdmin, requirePluginArchCapability, PluginArchAuthorizationError } from "./access.js"
import { pluginArchRoutePaths } from "./contracts.js"
import { registerGithubInstallRoutes, registerGithubSyncRoutes } from "../../../modules/marketplace/github-sync/routes.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "../shared.js"
import { isAgentOAuthClientConnection, listMemberUsableConnectionFacts } from "../mcp-connections.js"
import { listWorkflowLibraryItems } from "../../../workflow-library.js"
import {
  addPluginMembership,
  attachConfigObjectToPlugin,
  createConfigObject,
  createConfigObjectVersion,
  createMarketplace,
  createPluginBundle,
  configureMarketplacePluginMcpRequirement,
  createResourceAccessGrant,
  deleteResourceAccessGrant,
  getConfigObjectDetail,
  getConfigObjectVersion,
  getLatestConfigObjectVersion,
  getMarketplaceDetail,
  getMarketplaceResolved,
  getPluginDetail,
  listConfigObjectPlugins,
  listConfigObjectVersions,
  listConfigObjects,
  listMarketplaceMemberships,
  listMarketplaces,
  listMeLibraryConnectionItems,
  listMeLibraryPluginItems,
  listMeEffectivePluginAccess,
  listPluginMemberships,
  listPlugins,
  listResourceAccess,
  listTeamEffectivePluginAccess,
  attachPluginToMarketplace,
  importGithubPluginMcps,
  previewGithubPluginMcpImport,
  removeConfigObjectFromPlugin,
  removePluginFromMarketplace,
  removePluginMembership,
  setConfigObjectLifecycle,
  setMarketplaceLifecycle,
  setPluginLifecycle,
  updateMarketplace,
  updatePlugin,
} from "./store.js"
import {
  actorContext,
  type OrgContext,
  routeErrorResponse,
  validJson,
  validParam,
  validQuery,
  withPluginArchOrgContext,
} from "../../../modules/marketplace/routes/shared.js"

type PluginCreateBody = z.infer<typeof pluginCreateSchema>

const marketplaceConflictSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
}).meta({ ref: "PluginArchMarketplaceConflictError" })

async function configurePluginMcpConnectionResponse(c: OrgContext) {
  try {
    const params = validParam<z.infer<typeof pluginParamsSchema>>(c)
    const body = validJson<z.infer<typeof pluginMcpRequirementConfigureSchema>>(c)
    if (isAgentPluginMcpSecretSetup({ apiKey: body.apiKey, oauthClient: body.oauthClient, sessionId: c.get("session")?.id })) {
      return c.json({ error: "invalid_request", message: "Plugin MCP credentials cannot be set from the agent. Add them in the OpenWork Cloud dashboard under Connections." }, 400)
    }
    const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can configure plugin MCP requirements.")
    if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
    return c.json({ ok: true, item: await configureMarketplacePluginMcpRequirement({
      authType: body.authType,
      apiKey: body.apiKey,
      configObjectId: body.configObjectId,
      context: actorContext(c),
      credentialMode: body.credentialMode ?? (body.authType === "oauth" ? "per_member" : "shared"),
      oauthClient: body.oauthClient,
      pluginId: normalizeDenTypeId("plugin", params.pluginId),
      serverName: body.serverName,
    }) })
  } catch (error) {
    return routeErrorResponse(c, error)
  }
}

export function isAgentPluginMcpSecretSetup(input: { apiKey?: string | null; oauthClient?: unknown; sessionId?: string | null }) {
  return isAgentOAuthClientConnection(input) || (input.sessionId === "mcp_internal" && Boolean(input.apiKey?.trim()))
}

export function isAgentPluginMcpOAuthClientSetup(input: { apiKey?: string | null; oauthClient?: unknown; sessionId?: string | null }) {
  return isAgentPluginMcpSecretSetup(input)
}

export function registerPluginArchRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerGithubInstallRoutes(app)

  withPluginArchOrgContext(
    app,
    "get",
    pluginArchRoutePaths.configObjects,
    queryValidator(configObjectListQuerySchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "List config objects",
      description: "Lists current config object projections visible to the current organization member.",
      responses: {
        200: jsonResponse("Config objects returned successfully.", configObjectListResponseSchema),
        400: jsonResponse("The config object query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list config objects.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listConfigObjects({
        connectorInstanceId: query.connectorInstanceId,
        context: actorContext(c),
        cursor: query.cursor,
        includeDeleted: query.includeDeleted,
        limit: query.limit,
        pluginId: query.pluginId,
        q: query.q,
        sourceMode: query.sourceMode,
        status: query.status,
        type: query.type,
      }))
    },
  )

  withPluginArchOrgContext(
    app,
    "post",
    pluginArchRoutePaths.configObjects,
    jsonValidator(configObjectCreateSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Create a skill, agent, or other config object; optionally add it to an existing plugin",
      description: "Creates a config object and initial immutable version. Pass pluginIds to add the new component to existing plugins without creating a duplicate plugin; omit pluginIds for a private standalone object. Skills require complete SKILL.md in input.rawSourceText.",
      ...{ "x-mcp-search-aliases": ["add skill to existing plugin", "create skill in plugin", "add component to plugin"] },
      responses: {
        201: jsonResponse("Config object created successfully.", configObjectMutationResponseSchema),
        400: jsonResponse("The config object creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create config objects.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create config objects.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "config_object.create")
        const body = validJson<any>(c)
        const item = await createConfigObject({
          context,
          objectType: body.type,
          pluginIds: body.pluginIds,
          sourceMode: body.sourceMode,
          value: body.input,
        })
        return c.json({ ok: true, item }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    },
  )

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObject,
    paramValidator(configObjectParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Get config object",
      description: "Returns one config object detail when the caller can view it.",
      responses: {
        200: jsonResponse("Config object returned successfully.", configObjectDetailResponseSchema),
        400: jsonResponse("The config object path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view config objects.", unauthorizedSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ item: await getConfigObjectDetail(actorContext(c), params.configObjectId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.configObjectVersions,
    paramValidator(configObjectParamsSchema),
    jsonValidator(configObjectCreateVersionSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Update config object with new version",
      description: "Updates an existing config object, including a Cloud skill, by creating a new immutable version without creating a duplicate.",
      responses: {
        201: jsonResponse("Config object version created successfully.", configObjectMutationResponseSchema),
        400: jsonResponse("The config object version request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create config object versions.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this config object.", forbiddenSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c) as any
        return c.json({ ok: true, item: await createConfigObjectVersion({ configObjectId: params.configObjectId, context: actorContext(c), reason: body.reason, value: body.input }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObjectVersions,
    paramValidator(configObjectParamsSchema),
    queryValidator(configObjectVersionListQuerySchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "List config object versions",
      description: "Returns immutable versions for one config object.",
      responses: {
        200: jsonResponse("Config object versions returned successfully.", configObjectVersionListResponseSchema),
        400: jsonResponse("The version list request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view config object versions.", unauthorizedSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const query = validQuery<any>(c)
        return c.json(await listConfigObjectVersions({ configObjectId: params.configObjectId, context: actorContext(c), cursor: query.cursor, includeDeleted: query.includeDeleted, limit: query.limit }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  // Registered before :versionId so "latest" is not validated as a version id.
  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObjectLatestVersion,
    paramValidator(configObjectParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Get latest config object version",
      description: "Returns the latest config object version by created_at and id ordering.",
      responses: {
        200: jsonResponse("Latest config object version returned successfully.", configObjectVersionDetailResponseSchema),
        400: jsonResponse("The latest-version path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view config object versions.", unauthorizedSchema),
        404: jsonResponse("The config object version could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ item: await getLatestConfigObjectVersion({ configObjectId: params.configObjectId, context: actorContext(c) }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObjectVersion,
    paramValidator(configObjectVersionParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Get config object version",
      description: "Returns one immutable config object version.",
      responses: {
        200: jsonResponse("Config object version returned successfully.", configObjectVersionDetailResponseSchema),
        400: jsonResponse("The version path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view config object versions.", unauthorizedSchema),
        404: jsonResponse("The config object version could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ item: await getConfigObjectVersion({ configObjectId: params.configObjectId, context: actorContext(c), versionId: params.versionId }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  for (const [path, action] of [[pluginArchRoutePaths.configObjectArchive, "archive"], [pluginArchRoutePaths.configObjectDelete, "delete"], [pluginArchRoutePaths.configObjectRestore, "restore"]] as const) {
    withPluginArchOrgContext(app, "post", path,
      paramValidator(configObjectParamsSchema),
      describeRoute({
        tags: ["Config Objects"],
        summary: `${action} config object`,
        description: `${action} a config object without removing its history.`,
        responses: {
          200: jsonResponse("Config object lifecycle updated successfully.", configObjectMutationResponseSchema),
          400: jsonResponse("The lifecycle path parameters were invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in to manage config objects.", unauthorizedSchema),
          403: jsonResponse("The caller lacks permission to manage this config object.", forbiddenSchema),
          404: jsonResponse("The config object could not be found.", notFoundSchema),
        },
      }),
      async (c: OrgContext) => {
        try {
          const params = validParam<any>(c)
          return c.json({ ok: true, item: await setConfigObjectLifecycle({ action, configObjectId: params.configObjectId, context: actorContext(c) }) })
        } catch (error) {
          return routeErrorResponse(c, error)
        }
      })
  }

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObjectPlugins,
    paramValidator(configObjectParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "List config object plugins",
      description: "Lists plugins that currently include the config object.",
      responses: {
        200: jsonResponse("Config object plugins returned successfully.", pluginMembershipListResponseSchema),
        400: jsonResponse("The config object plugin path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view config object plugins.", unauthorizedSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listConfigObjectPlugins({ configObjectId: params.configObjectId, context: actorContext(c) }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.configObjectPlugins,
    paramValidator(configObjectParamsSchema),
    jsonValidator(configObjectPluginAttachSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Attach config object to plugin",
      description: "Adds a config object to a plugin when the caller can edit the target plugin.",
      responses: {
        201: jsonResponse("Plugin membership created successfully.", pluginMembershipMutationResponseSchema),
        400: jsonResponse("The plugin membership request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin membership.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit the target plugin.", forbiddenSchema),
        404: jsonResponse("The config object or plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await attachConfigObjectToPlugin({ configObjectId: params.configObjectId, context: actorContext(c), membershipSource: body.membershipSource, pluginId: body.pluginId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.configObjectPlugin,
    paramValidator(configObjectParamsSchema.extend(pluginParamsSchema.pick({ pluginId: true }).shape)),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Remove config object from plugin",
      description: "Removes one active plugin membership from a config object.",
      responses: {
        204: emptyResponse("Plugin membership removed successfully."),
        400: jsonResponse("The plugin membership path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin membership.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit the target plugin.", forbiddenSchema),
        404: jsonResponse("The plugin membership could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await removeConfigObjectFromPlugin({ configObjectId: params.configObjectId, context: actorContext(c), pluginId: params.pluginId })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.configObjectAccess,
    paramValidator(configObjectParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "List config object access grants",
      description: "Lists direct, team, and org-wide grants for one config object.",
      responses: {
        200: jsonResponse("Config object access grants returned successfully.", accessGrantListResponseSchema),
        400: jsonResponse("The access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage config object access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage config object access.", forbiddenSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listResourceAccess({ context: actorContext(c), resourceId: params.configObjectId, resourceKind: "config_object" }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.configObjectAccess,
    paramValidator(configObjectParamsSchema),
    jsonValidator(resourceAccessGrantWriteSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Grant config object access",
      description: "Creates or reactivates one access grant for a config object.",
      responses: {
        201: jsonResponse("Config object access grant created successfully.", accessGrantMutationResponseSchema),
        400: jsonResponse("The access grant request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage config object access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage config object access.", forbiddenSchema),
        404: jsonResponse("The config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createResourceAccessGrant({ context: actorContext(c), resourceId: params.configObjectId, resourceKind: "config_object", value: body }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.configObjectAccessGrant,
    paramValidator(configObjectAccessGrantParamsSchema),
    describeRoute({
      tags: ["Config Objects"],
      summary: "Revoke config object access",
      description: "Soft-revokes one config object access grant.",
      responses: {
        204: emptyResponse("Config object access revoked successfully."),
        400: jsonResponse("The access grant path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage config object access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage config object access.", forbiddenSchema),
        404: jsonResponse("The access grant could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await deleteResourceAccessGrant({ context: actorContext(c), grantId: params.grantId, resourceId: params.configObjectId, resourceKind: "config_object" })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.plugins,
    queryValidator(pluginListQuerySchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "List plugins",
      description: "Lists plugins visible to the current organization member.",
      responses: {
        200: jsonResponse("Plugins returned successfully.", pluginListResponseSchema),
        400: jsonResponse("The plugin query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list plugins.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listPlugins({ context: actorContext(c), cursor: query.cursor, includeAccess: query.includeAccess, includeTotal: query.includeTotal, includeFacets: query.includeFacets, limit: query.limit, q: query.q, name: query.name, status: query.status, teamId: query.teamId, memberId: query.memberId, ownerId: query.ownerId }))
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.plugins,
    jsonValidator(pluginCreateSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Create plugin",
      description: "Creates a plugin and can also create components, share org-wide, and publish to a marketplace in one request. An mcp component may carry the same connection setup as the Connections page (authentication, credential mode, API key, OAuth app), or instead reference an existing organization connection by connectionId, so its server is configured immediately. Connection setup is for owners and admins; other members may reference only a connection they added themselves.",
      responses: {
        201: jsonResponse("Plugin created successfully.", pluginMutationResponseSchema),
        400: jsonResponse("The plugin creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create plugins.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create plugins.", forbiddenSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        const body = validJson<PluginCreateBody>(c)
        await requirePluginArchCapability(context, "plugin.create")
        if (body.orgWide === true && !isPluginArchOrgAdmin(context)) {
          throw new PluginArchAuthorizationError(403, "forbidden", "Only organization owners and admins can create org-wide plugins.")
        }
        if ((body.components?.length ?? 0) > 0) {
          await requirePluginArchCapability(context, "config_object.create")
        }
        const sessionId = c.get("session")?.id
        if (body.components?.some((component) => component.connection && isAgentPluginMcpSecretSetup({
          apiKey: component.connection.apiKey,
          oauthClient: component.connection.oauthClient,
          sessionId,
        }))) {
          return c.json({ error: "invalid_request", message: "Plugin MCP credentials cannot be set from the agent. Add them in the OpenWork Cloud dashboard under Connections." }, 400)
        }
        return c.json({
          ok: true,
          item: await createPluginBundle({
            components: body.components?.map((component) => ({ connection: component.connection, connectionId: component.connectionId, type: component.type, value: component.input })),
            context,
            description: body.description,
            marketplaceId: body.marketplaceId,
            name: body.name,
            orgWide: body.orgWide,
            sourceRepositoryUrl: body.sourceRepositoryUrl,
          }),
        }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.plugin,
    paramValidator(pluginParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Get plugin",
      description: "Returns one plugin detail when the caller can view it.",
      responses: {
        200: jsonResponse("Plugin returned successfully.", pluginDetailResponseSchema),
        400: jsonResponse("The plugin path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view plugins.", unauthorizedSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ item: await getPluginDetail(actorContext(c), params.pluginId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "patch", pluginArchRoutePaths.plugin,
    paramValidator(pluginParamsSchema),
    jsonValidator(pluginUpdateSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Update plugin",
      description: "Updates plugin metadata.",
      responses: {
        200: jsonResponse("Plugin updated successfully.", pluginMutationResponseSchema),
        400: jsonResponse("The plugin update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update plugins.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this plugin.", forbiddenSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await updatePlugin({ context: actorContext(c), description: body.description, name: body.name, pluginId: params.pluginId }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  for (const [path, action] of [[pluginArchRoutePaths.pluginArchive, "archive"], [pluginArchRoutePaths.pluginRestore, "restore"]] as const) {
    withPluginArchOrgContext(app, "post", path,
      paramValidator(pluginParamsSchema),
      describeRoute({
        tags: ["Plugins"],
        summary: `${action} plugin`,
        description: `${action} a plugin without touching its historical memberships.`,
        responses: {
          200: jsonResponse("Plugin lifecycle updated successfully.", pluginMutationResponseSchema),
          400: jsonResponse("The plugin lifecycle path parameters were invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in to manage plugins.", unauthorizedSchema),
          403: jsonResponse("The caller lacks permission to manage this plugin.", forbiddenSchema),
          404: jsonResponse("The plugin could not be found.", notFoundSchema),
        },
      }),
      async (c: OrgContext) => {
        try {
          const params = validParam<any>(c)
          return c.json({ ok: true, item: await setPluginLifecycle({ action, context: actorContext(c), pluginId: params.pluginId }) })
        } catch (error) {
          return routeErrorResponse(c, error)
        }
      })
  }

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.pluginConfigObjects,
    paramValidator(pluginParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "List plugin config objects",
      description: "Lists plugin memberships and resolved config object projections.",
      responses: {
        200: jsonResponse("Plugin memberships returned successfully.", pluginMembershipListResponseSchema),
        400: jsonResponse("The plugin membership path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view plugin memberships.", unauthorizedSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listPluginMemberships({ context: actorContext(c), includeConfigObjects: true, onlyActive: false, pluginId: params.pluginId }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.pluginConfigObjects,
    paramValidator(pluginParamsSchema),
    jsonValidator(pluginMembershipWriteSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Add plugin config object",
      description: "Adds a config object to a plugin. Workflows require manager access because this can expand their audience through Plugin and Marketplace grants.",
      responses: {
        201: jsonResponse("Plugin membership created successfully.", pluginMembershipMutationResponseSchema),
        400: jsonResponse("The plugin membership request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin memberships.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this plugin.", forbiddenSchema),
        404: jsonResponse("The plugin or config object could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await addPluginMembership({ configObjectId: body.configObjectId, context: actorContext(c), membershipSource: body.membershipSource, pluginId: params.pluginId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.pluginConfigObject,
    paramValidator(pluginParamsSchema.extend(configObjectParamsSchema.pick({ configObjectId: true }).shape)),
    describeRoute({
      tags: ["Plugins"],
      summary: "Remove plugin config object",
      description: "Removes one config object from a plugin. Workflows require manager access because this revokes inherited Plugin or Marketplace access.",
      responses: {
        204: emptyResponse("Plugin membership removed successfully."),
        400: jsonResponse("The plugin membership path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin memberships.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this plugin.", forbiddenSchema),
        404: jsonResponse("The plugin membership could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await removePluginMembership({ configObjectId: params.configObjectId, context: actorContext(c), pluginId: params.pluginId })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.pluginResolved,
    paramValidator(pluginParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Get resolved plugin",
      description: "Lists active plugin memberships with the current config object projection for each item.",
      responses: {
        200: jsonResponse("Resolved plugin returned successfully.", pluginMembershipListResponseSchema),
        400: jsonResponse("The plugin path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view resolved plugins.", unauthorizedSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listPluginMemberships({
          context: actorContext(c),
          includeConfigObjects: true,
          legacyWorkflowObjectType: true,
          onlyActive: true,
          pluginId: params.pluginId,
        }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.pluginMcpConnections,
    paramValidator(pluginParamsSchema),
    jsonValidator(pluginMcpRequirementConfigureSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Configure plugin MCP requirement",
      description: "Admin-only privileged setup for one declared remote MCP server. The server name and URL are derived from the active plugin config object; the request never supplies a URL and does not start OAuth.",
      responses: {
        200: jsonResponse("Plugin MCP requirement configured successfully.", pluginMcpRequirementConfigureResponseSchema),
        400: jsonResponse("The plugin MCP requirement request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to configure plugin MCP requirements.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can configure plugin MCP requirements.", forbiddenSchema),
        404: jsonResponse("The plugin MCP requirement could not be found.", notFoundSchema),
      },
    }),
    configurePluginMcpConnectionResponse)

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.pluginGithubMcpImportPreview,
    jsonValidator(githubPluginMcpImportPreviewSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Preview GitHub plugin marketplace import",
      description: "Reads a public GitHub plugin URL and returns skills and remote MCP servers that can be imported into an organization marketplace.",
      responses: {
        200: jsonResponse("GitHub plugin MCP import preview returned successfully.", githubPluginMcpImportPreviewResponseSchema),
        400: jsonResponse("The GitHub plugin MCP import preview request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to preview plugin MCP imports.", unauthorizedSchema),
        404: jsonResponse("The GitHub plugin path could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const body = validJson<{
          githubUrl: string
        }>(c)
        return c.json({ ok: true, item: await previewGithubPluginMcpImport({ context: actorContext(c), githubUrl: body.githubUrl }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.pluginGithubMcpImport,
    jsonValidator(githubPluginMcpImportSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Create a plugin from GitHub",
      description: "Creates one plugin from selected skills and remote MCP servers in a public GitHub plugin URL, applies the requested access grants, and optionally publishes it into an organization marketplace. Declared and known-server authentication requirements take precedence over the request-wide auth fallback.",
      responses: {
        200: jsonResponse("GitHub plugin MCPs imported successfully.", githubPluginMcpImportResponseSchema),
        400: jsonResponse("The GitHub plugin MCP import request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to import plugin MCPs.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to import plugin MCPs.", forbiddenSchema),
        404: jsonResponse("The GitHub plugin path or marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "plugin.create")
        const body = validJson<z.infer<typeof githubPluginMcpImportSchema>>(c)
        return c.json({ ok: true, item: await importGithubPluginMcps({
          access: body.access,
          authType: body.authType,
          context,
          credentialMode: body.credentialMode,
          description: body.description,
          githubUrl: body.githubUrl,
          marketplaceId: body.marketplaceId,
          name: body.name,
          selectedSkillKeys: body.selectedSkillKeys,
          selectedServerKeys: body.selectedServerKeys,
          selectedServerNames: body.selectedServerNames,
        }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.pluginAccess,
    paramValidator(pluginParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "List plugin access grants",
      description: "Lists direct, team, and org-wide grants for a plugin.",
      responses: {
        200: jsonResponse("Plugin access grants returned successfully.", accessGrantListResponseSchema),
        400: jsonResponse("The plugin access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage plugin access.", forbiddenSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listResourceAccess({ context: actorContext(c), resourceId: params.pluginId, resourceKind: "plugin" }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.mePluginAccess,
    describeRoute({
      tags: ["Plugins"],
      summary: "List my effective plugin access",
      description: "Lists active plugins in the caller's organization library and every access edge that applies to the caller.",
      responses: {
        200: jsonResponse("Effective member plugin access returned successfully.", mePluginAccessListResponseSchema),
        401: jsonResponse("The caller must be signed in to view plugin access.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json(await listMeEffectivePluginAccess({ context: actorContext(c) }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.meLibrary,
    describeRoute({
      tags: ["Plugins"],
      summary: "List my library",
      description: "Lists the Workflows, Remote MCP Apps, plugins, and connections the caller can use, with every applicable access edge. Workflows and Remote MCP Apps remain config objects contained by their parent OpenWork Connect Plugin.",
      responses: {
        200: jsonResponse("Effective member library returned successfully.", meLibraryListResponseSchema),
        401: jsonResponse("The caller must be signed in to view their library.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        const [pluginItems, connections, workflowItems] = await Promise.all([
          listMeLibraryPluginItems({ context }),
          listMemberUsableConnectionFacts({ context }),
          listWorkflowLibraryItems({ context }),
        ])
        const connectionItems = await listMeLibraryConnectionItems({ connections, context })
        const items = [...pluginItems, ...connectionItems, ...workflowItems]
        items.sort((left, right) => {
          const byName = left.name.localeCompare(right.name)
          return byName !== 0 ? byName : left.id.localeCompare(right.id)
        })
        return c.json({ items })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.teamPluginAccess,
    paramValidator(teamParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "List effective team plugin access",
      description: "Lists plugins available to a team through direct grants, marketplace grants, and organization-wide grants.",
      responses: {
        200: jsonResponse("Effective team plugin access returned successfully.", teamPluginAccessListResponseSchema),
        400: jsonResponse("The team access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view team plugin access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to view this team's plugin access.", forbiddenSchema),
        404: jsonResponse("The team could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<z.infer<typeof teamParamsSchema>>(c)
        return c.json(await listTeamEffectivePluginAccess({
          context: actorContext(c),
          teamId: normalizeDenTypeId("team", params.teamId),
        }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.pluginAccess,
    paramValidator(pluginParamsSchema),
    jsonValidator(resourceAccessGrantWriteSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Grant plugin access",
      description: "Creates or reactivates one access grant for a plugin.",
      responses: {
        201: jsonResponse("Plugin access grant created successfully.", accessGrantMutationResponseSchema),
        400: jsonResponse("The plugin access request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage plugin access.", forbiddenSchema),
        404: jsonResponse("The plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ ok: true, item: await createResourceAccessGrant({ context: actorContext(c), resourceId: params.pluginId, resourceKind: "plugin", value: validJson<any>(c) }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.pluginAccessGrant,
    paramValidator(pluginAccessGrantParamsSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Revoke plugin access",
      description: "Soft-revokes one plugin access grant.",
      responses: {
        204: emptyResponse("Plugin access revoked successfully."),
        400: jsonResponse("The plugin access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage plugin access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage plugin access.", forbiddenSchema),
        404: jsonResponse("The access grant could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await deleteResourceAccessGrant({ context: actorContext(c), grantId: params.grantId, resourceId: params.pluginId, resourceKind: "plugin" })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", "/v1/marketplaces/by-key/:externalKey",
    paramValidator(externalKeyParamsSchema),
    describeRoute({ tags: ["Marketplaces"], summary: "Read marketplace by stable key",
      description: "Reads the marketplace identified by the stable externalKey assigned through declarative provisioning.",
      responses: { 200: jsonResponse("Marketplace configuration.", marketplaceDetailResponseSchema), 404: jsonResponse("Resource not found.", notFoundSchema) } }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        const { externalKey } = validParam<z.infer<typeof externalKeyParamsSchema>>(c)
        const row = await findMarketplaceByExternalKey(context, externalKey)
        if (!row) return c.json({ error: "marketplace_not_found" }, 404)
        return c.json({ item: await getMarketplaceDetail(context, row.id) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "put", "/v1/marketplaces/by-key/:externalKey",
    paramValidator(externalKeyParamsSchema),
    jsonValidator(marketplaceCreateSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Apply marketplace by stable key",
      description: "Creates or replaces marketplace metadata. Omitted description and logo are cleared. Memberships and access grants are managed separately. Archived marketplaces must be explicitly restored before applying.",
      responses: declarativeResponses(marketplaceMutationResponseSchema),
    }),
    async (c: OrgContext) => {
      try {
        const permission = ensureOrganizationAdmin(c, "Only organization admins can manage declarative resources.")
        if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
        if (c.req.header("If-Match") || c.req.header("If-None-Match")) return c.json({ error: "unsupported_precondition" }, 400)
        const context = actorContext(c)
        const { externalKey } = validParam<z.infer<typeof externalKeyParamsSchema>>(c)
        const body = validJson<z.infer<typeof marketplaceCreateSchema>>(c)
        const input = { context, name: body.name, description: body.description ?? null, logoUrl: body.logoUrl ?? null }
        const replace = async (row: NonNullable<Awaited<ReturnType<typeof findMarketplaceByExternalKey>>>) => {
          if (row.status !== "active") return c.json({ error: "marketplace_inactive", message: "Restore this marketplace before applying its configuration." }, 409)
          return c.json({ ok: true, item: await updateMarketplace({ ...input, marketplaceId: row.id }) })
        }
        const existing = await findMarketplaceByExternalKey(context, externalKey)
        if (existing) return replace(existing)
        await requirePluginArchCapability(context, "marketplace.create")
        try {
          return c.json({ ok: true, item: await createMarketplace({ ...input, externalKey }) }, 201)
        } catch (error) {
          if (!isDuplicateEntry(error)) throw error
          const winner = await findMarketplaceByExternalKey(context, externalKey)
          if (!winner) throw error
          return replace(winner)
        }
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", "/v1/marketplaces/by-key/:externalKey",
    paramValidator(externalKeyParamsSchema),
    describeRoute({ tags: ["Marketplaces"], summary: "Delete marketplace by stable key",
      description: "Deletes the marketplace identified by its stable externalKey. Idempotent: deleting a key that does not exist is reported as already removed.",
      responses: { 200: jsonResponse("Idempotent deletion result.", declarativeDeleteSchema) } }),
    async (c: OrgContext) => {
      try {
        const permission = ensureOrganizationAdmin(c, "Only organization admins can manage declarative resources.")
        if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
        const context = actorContext(c)
        const { externalKey } = validParam<z.infer<typeof externalKeyParamsSchema>>(c)
        const existing = await findMarketplaceByExternalKey(context, externalKey)
        if (!existing) return c.json({ ok: true, deleted: false })
        await setMarketplaceLifecycle({ context, marketplaceId: existing.id, action: "delete" })
        return c.json({ ok: true, deleted: true })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.marketplaces,
    queryValidator(marketplaceListQuerySchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "List marketplaces",
      description: "Lists marketplaces visible to the current organization member.",
      responses: {
        200: jsonResponse("Marketplaces returned successfully.", marketplaceListResponseSchema),
        400: jsonResponse("The marketplace query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list marketplaces.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listMarketplaces({ context: actorContext(c), cursor: query.cursor, limit: query.limit, q: query.q, status: query.status }))
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.marketplaces,
    jsonValidator(marketplaceCreateSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Create marketplace",
      description: "Creates a new private marketplace and grants the creator manager access.",
      responses: {
        201: jsonResponse("Marketplace created successfully.", marketplaceMutationResponseSchema),
        400: jsonResponse("The marketplace creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create marketplaces.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create marketplaces.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "marketplace.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createMarketplace({ context, description: body.description, logoUrl: body.logoUrl, name: body.name }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.marketplace,
    paramValidator(marketplaceParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Get marketplace",
      description: "Returns one marketplace detail when the caller can view it.",
      responses: {
        200: jsonResponse("Marketplace returned successfully.", marketplaceDetailResponseSchema),
        400: jsonResponse("The marketplace path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view marketplaces.", unauthorizedSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ item: await getMarketplaceDetail(actorContext(c), params.marketplaceId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "patch", pluginArchRoutePaths.marketplace,
    paramValidator(marketplaceParamsSchema),
    jsonValidator(marketplaceUpdateSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Update marketplace",
      description: "Updates marketplace metadata.",
      responses: {
        200: jsonResponse("Marketplace updated successfully.", marketplaceMutationResponseSchema),
        400: jsonResponse("The marketplace update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update marketplaces.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this marketplace.", forbiddenSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await updateMarketplace({ context: actorContext(c), description: body.description, logoUrl: body.logoUrl, marketplaceId: params.marketplaceId, name: body.name }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  for (const [path, action] of [
    [pluginArchRoutePaths.marketplaceArchive, "archive"],
    [pluginArchRoutePaths.marketplaceDelete, "delete"],
    [pluginArchRoutePaths.marketplaceRestore, "restore"],
  ] as const) {
    withPluginArchOrgContext(app, "post", path,
      paramValidator(marketplaceParamsSchema),
      describeRoute({
        tags: ["Marketplaces"],
        summary: `${action} marketplace`,
        description: action === "delete"
          ? "Permanently deletes a custom marketplace and its relationships."
          : `${action} a marketplace without deleting its plugins.`,
        responses: {
          200: jsonResponse("Marketplace lifecycle updated successfully.", marketplaceMutationResponseSchema),
          400: jsonResponse("The marketplace lifecycle path parameters were invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in to manage marketplaces.", unauthorizedSchema),
          403: jsonResponse("The caller lacks permission to manage this marketplace.", forbiddenSchema),
          404: jsonResponse("The marketplace could not be found.", notFoundSchema),
          ...(action === "delete" ? {
            409: jsonResponse("A built-in or connector-managed marketplace cannot be deleted.", marketplaceConflictSchema),
          } : {}),
        },
      }),
      async (c: OrgContext) => {
        try {
          const params = validParam<any>(c)
          return c.json({ ok: true, item: await setMarketplaceLifecycle({ action, context: actorContext(c), marketplaceId: params.marketplaceId }) })
        } catch (error) {
          return routeErrorResponse(c, error)
        }
      })
  }

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.marketplacePlugins,
    paramValidator(marketplaceParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "List marketplace plugins",
      description: "Lists marketplace memberships and resolved plugin projections.",
      responses: {
        200: jsonResponse("Marketplace memberships returned successfully.", marketplacePluginListResponseSchema),
        400: jsonResponse("The marketplace membership path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view marketplace memberships.", unauthorizedSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listMarketplaceMemberships({ context: actorContext(c), includePlugins: true, marketplaceId: params.marketplaceId, onlyActive: false }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.marketplaceResolved,
    paramValidator(marketplaceParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Get resolved marketplace plugin readiness",
      description: "Returns marketplace detail with plugins, derived source info, and each plugin's cloud readiness or required setup state.",
      responses: {
        200: jsonResponse("Marketplace resolved detail returned successfully.", marketplaceResolvedResponseSchema),
        400: jsonResponse("The marketplace path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view marketplaces.", unauthorizedSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ ok: true, item: await getMarketplaceResolved({ context: actorContext(c), marketplaceId: params.marketplaceId }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.marketplacePlugins,
    paramValidator(marketplaceParamsSchema),
    jsonValidator(marketplacePluginWriteSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Add marketplace plugin",
      description: "Adds a plugin to a marketplace.",
      responses: {
        201: jsonResponse("Marketplace membership created successfully.", marketplacePluginMutationResponseSchema),
        400: jsonResponse("The marketplace membership request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage marketplace memberships.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this marketplace.", forbiddenSchema),
        404: jsonResponse("The marketplace or plugin could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await attachPluginToMarketplace({ context: actorContext(c), marketplaceId: params.marketplaceId, membershipSource: body.membershipSource, pluginId: body.pluginId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.marketplacePlugin,
    paramValidator(marketplacePluginParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Remove marketplace plugin",
      description: "Removes one plugin from a marketplace.",
      responses: {
        204: emptyResponse("Marketplace membership removed successfully."),
        400: jsonResponse("The marketplace membership path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage marketplace memberships.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this marketplace.", forbiddenSchema),
        404: jsonResponse("The marketplace membership could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await removePluginFromMarketplace({ context: actorContext(c), marketplaceId: params.marketplaceId, pluginId: params.pluginId })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.marketplaceAccess,
    paramValidator(marketplaceParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "List marketplace access grants",
      description: "Lists direct, team, and org-wide grants for a marketplace.",
      responses: {
        200: jsonResponse("Marketplace access grants returned successfully.", accessGrantListResponseSchema),
        400: jsonResponse("The marketplace access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage marketplace access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage marketplace access.", forbiddenSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listResourceAccess({ context: actorContext(c), resourceId: params.marketplaceId, resourceKind: "marketplace" }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.marketplaceAccess,
    paramValidator(marketplaceParamsSchema),
    jsonValidator(resourceAccessGrantWriteSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Grant marketplace access",
      description: "Creates or reactivates one access grant for a marketplace.",
      responses: {
        201: jsonResponse("Marketplace access grant created successfully.", accessGrantMutationResponseSchema),
        400: jsonResponse("The marketplace access request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage marketplace access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage marketplace access.", forbiddenSchema),
        404: jsonResponse("The marketplace could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ ok: true, item: await createResourceAccessGrant({ context: actorContext(c), resourceId: params.marketplaceId, resourceKind: "marketplace", value: validJson<any>(c) }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.marketplaceAccessGrant,
    paramValidator(marketplaceAccessGrantParamsSchema),
    describeRoute({
      tags: ["Marketplaces"],
      summary: "Revoke marketplace access",
      description: "Soft-revokes one marketplace access grant.",
      responses: {
        204: emptyResponse("Marketplace access revoked successfully."),
        400: jsonResponse("The marketplace access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage marketplace access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage marketplace access.", forbiddenSchema),
        404: jsonResponse("The access grant could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await deleteResourceAccessGrant({ context: actorContext(c), grantId: params.grantId, resourceId: params.marketplaceId, resourceKind: "marketplace" })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  registerGithubSyncRoutes(app)
}
