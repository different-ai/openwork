import type { Context, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { queryValidator, jsonValidator, paramValidator, requireUserMiddleware, resolveMemberTeamsMiddleware, resolveOrganizationContextMiddleware } from "../../../middleware/index.js"
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
  connectorAccountCreateSchema,
  connectorAccountDetailResponseSchema,
  connectorAccountDisconnectSchema,
  connectorAccountListQuerySchema,
  connectorAccountListResponseSchema,
  connectorAccountMutationResponseSchema,
  connectorAccountParamsSchema,
  connectorAccountRepositoryParamsSchema,
  connectorInstanceAccessGrantParamsSchema,
  connectorInstanceCreateSchema,
  connectorInstanceDetailResponseSchema,
  connectorInstanceListQuerySchema,
  connectorInstanceListResponseSchema,
  connectorInstanceMutationResponseSchema,
  connectorInstanceParamsSchema,
  connectorInstanceUpdateSchema,
  connectorMappingCreateSchema,
  connectorMappingListQuerySchema,
  connectorMappingListResponseSchema,
  connectorMappingMutationResponseSchema,
  connectorMappingParamsSchema,
  connectorMappingUpdateSchema,
  connectorSyncAsyncResponseSchema,
  connectorSyncEventDetailResponseSchema,
  connectorSyncEventListQuerySchema,
  connectorSyncEventListResponseSchema,
  connectorSyncEventParamsSchema,
  connectorTargetCreateSchema,
  connectorTargetDetailResponseSchema,
  connectorTargetListQuerySchema,
  connectorTargetListResponseSchema,
  connectorTargetMutationResponseSchema,
  connectorTargetParamsSchema,
  connectorTargetUpdateSchema,
  githubConnectorAccountCreateSchema,
  githubRepositoryListQuerySchema,
  githubRepositoryListResponseSchema,
  githubSetupResponseSchema,
  githubConnectorSetupSchema,
  githubValidateTargetResponseSchema,
  githubValidateTargetSchema,
  marketplaceAccessGrantParamsSchema,
  marketplaceCreateSchema,
  marketplaceDetailResponseSchema,
  marketplaceListQuerySchema,
  marketplaceListResponseSchema,
  marketplaceMutationResponseSchema,
  marketplaceParamsSchema,
  marketplacePluginListResponseSchema,
  marketplacePluginMutationResponseSchema,
  marketplacePluginParamsSchema,
  marketplacePluginWriteSchema,
  marketplaceUpdateSchema,
  pluginAccessGrantParamsSchema,
  pluginCreateSchema,
  pluginDetailResponseSchema,
  pluginListQuerySchema,
  pluginListResponseSchema,
  pluginMembershipListResponseSchema,
  pluginMembershipMutationResponseSchema,
  pluginMembershipWriteSchema,
  pluginMutationResponseSchema,
  pluginParamsSchema,
  pluginUpdateSchema,
  resourceAccessGrantWriteSchema,
} from "./schemas.js"
import { requirePluginArchCapability, type PluginArchActorContext, PluginArchAuthorizationError } from "./access.js"
import { pluginArchRoutePaths } from "./contracts.js"
import {
  PluginArchRouteFailure,
  addPluginMembership,
  attachConfigObjectToPlugin,
  createConfigObject,
  createConfigObjectVersion,
  createConnectorAccount,
  createConnectorInstance,
  createConnectorMapping,
  createGithubConnectorAccount,
  createMarketplace,
  createPlugin,
  createResourceAccessGrant,
  createConnectorTarget,
  deleteConnectorMapping,
  deleteResourceAccessGrant,
  disconnectConnectorAccount,
  getConfigObjectDetail,
  getConfigObjectVersion,
  getConnectorAccountDetail,
  getConnectorInstanceDetail,
  getConnectorSyncEventDetail,
  getConnectorTargetDetail,
  getLatestConfigObjectVersion,
  getMarketplaceDetail,
  getPluginDetail,
  githubSetup,
  listConfigObjectPlugins,
  listConfigObjectVersions,
  listConfigObjects,
  listConnectorAccounts,
  listConnectorInstances,
  listConnectorMappings,
  listConnectorSyncEvents,
  listConnectorTargets,
  listGithubRepositories,
  listMarketplaceMemberships,
  listMarketplaces,
  listPluginMemberships,
  listPlugins,
  listResourceAccess,
  attachPluginToMarketplace,
  queueConnectorTargetResync,
  removeConfigObjectFromPlugin,
  removePluginFromMarketplace,
  removePluginMembership,
  retryConnectorSyncEvent,
  setConfigObjectLifecycle,
  setConnectorInstanceLifecycle,
  setMarketplaceLifecycle,
  setPluginLifecycle,
  updateConnectorInstance,
  updateConnectorMapping,
  updateConnectorTarget,
  updateMarketplace,
  updatePlugin,
  validateGithubTarget,
} from "./store.js"

type OrgContext = Context<{ Variables: OrgRouteVariables }>

function validRequestPart<T>(c: OrgContext, target: "json" | "param" | "query") {
  return (c.req as unknown as { valid: (part: typeof target) => unknown }).valid(target) as T
}

function validJson<T>(c: OrgContext) {
  return validRequestPart<T>(c, "json")
}

function validParam<T>(c: OrgContext) {
  return validRequestPart<T>(c, "param")
}

function validQuery<T>(c: OrgContext) {
  return validRequestPart<T>(c, "query")
}

function actorContext(c: OrgContext): PluginArchActorContext {
  const organizationContext = c.get("organizationContext")
  if (!organizationContext) {
    throw new PluginArchRouteFailure(404, "organization_not_found", "Organization context not found.")
  }

  return {
    memberTeams: c.get("memberTeams") ?? [],
    organizationContext,
  }
}

function routeErrorResponse(c: OrgContext, error: unknown) {
  if (error instanceof PluginArchAuthorizationError) {
    const authorizationError = error as PluginArchAuthorizationError
    return c.json({ error: authorizationError.error, message: authorizationError.message }, 403)
  }
  if (error instanceof PluginArchRouteFailure) {
    const failure = error as PluginArchRouteFailure
    return c.json({ error: failure.error, message: failure.message }, failure.status)
  }
  throw error
}

function withPluginArchOrgContext(app: Hono<any>, method: "delete" | "get" | "patch" | "post", path: string, ...handlers: unknown[]) {
  const routeHandler = handlers.pop() as unknown
  const routeMiddlewares = handlers as unknown[]
  const routeApp = app as unknown as Record<string, (...args: unknown[]) => unknown>
  routeApp[method](path, requireUserMiddleware, ...routeMiddlewares, resolveOrganizationContextMiddleware, resolveMemberTeamsMiddleware, routeHandler)
}

export function registerPluginArchRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
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
      summary: "Create config object",
      description: "Creates a new private config object and initial immutable version.",
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
      summary: "Create config object version",
      description: "Creates a new immutable config object version.",
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
      return c.json(await listPlugins({ context: actorContext(c), cursor: query.cursor, limit: query.limit, q: query.q, status: query.status }))
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.plugins,
    jsonValidator(pluginCreateSchema),
    describeRoute({
      tags: ["Plugins"],
      summary: "Create plugin",
      description: "Creates a new private plugin and grants the creator manager access.",
      responses: {
        201: jsonResponse("Plugin created successfully.", pluginMutationResponseSchema),
        400: jsonResponse("The plugin creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create plugins.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create plugins.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "plugin.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createPlugin({ context, description: body.description, name: body.name }) }, 201)
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
      description: "Adds a config object to a plugin.",
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
      description: "Removes one config object from a plugin.",
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
        return c.json(await listPluginMemberships({ context: actorContext(c), includeConfigObjects: true, onlyActive: true, pluginId: params.pluginId }))
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
        return c.json({ ok: true, item: await createMarketplace({ context, description: body.description, name: body.name }) }, 201)
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
        return c.json({ ok: true, item: await updateMarketplace({ context: actorContext(c), description: body.description, marketplaceId: params.marketplaceId, name: body.name }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  for (const [path, action] of [[pluginArchRoutePaths.marketplaceArchive, "archive"], [pluginArchRoutePaths.marketplaceRestore, "restore"]] as const) {
    withPluginArchOrgContext(app, "post", path,
      paramValidator(marketplaceParamsSchema),
      describeRoute({
        tags: ["Marketplaces"],
        summary: `${action} marketplace`,
        description: `${action} a marketplace without touching membership history.`,
        responses: {
          200: jsonResponse("Marketplace lifecycle updated successfully.", marketplaceMutationResponseSchema),
          400: jsonResponse("The marketplace lifecycle path parameters were invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in to manage marketplaces.", unauthorizedSchema),
          403: jsonResponse("The caller lacks permission to manage this marketplace.", forbiddenSchema),
          404: jsonResponse("The marketplace could not be found.", notFoundSchema),
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

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorAccounts,
    queryValidator(connectorAccountListQuerySchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector accounts",
      description: "Lists connector accounts for the organization.",
      responses: {
        200: jsonResponse("Connector accounts returned successfully.", connectorAccountListResponseSchema),
        400: jsonResponse("The connector account query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list connector accounts.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listConnectorAccounts({ connectorType: query.connectorType, context: actorContext(c), cursor: query.cursor, limit: query.limit, q: query.q, status: query.status }))
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorAccounts,
    jsonValidator(connectorAccountCreateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Create connector account",
      description: "Creates a connector account such as a GitHub App installation binding.",
      responses: {
        201: jsonResponse("Connector account created successfully.", connectorAccountMutationResponseSchema),
        400: jsonResponse("The connector account creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create connector accounts.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create connector accounts.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_account.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createConnectorAccount({ connectorType: body.connectorType, context, displayName: body.displayName, externalAccountRef: body.externalAccountRef, metadata: body.metadata, remoteId: body.remoteId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorAccount,
    paramValidator(connectorAccountParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Get connector account",
      description: "Returns one connector account detail.",
      responses: {
        200: jsonResponse("Connector account returned successfully.", connectorAccountDetailResponseSchema),
        400: jsonResponse("The connector account path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view connector accounts.", unauthorizedSchema),
        404: jsonResponse("The connector account could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ item: await getConnectorAccountDetail(actorContext(c), validParam<any>(c).connectorAccountId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorAccountDisconnect,
    paramValidator(connectorAccountParamsSchema),
    jsonValidator(connectorAccountDisconnectSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Disconnect connector account",
      description: "Marks a connector account as disconnected.",
      responses: {
        200: jsonResponse("Connector account disconnected successfully.", connectorAccountMutationResponseSchema),
        400: jsonResponse("The connector account disconnect request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage connector accounts.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage connector accounts.", forbiddenSchema),
        404: jsonResponse("The connector account could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_account.create")
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await disconnectConnectorAccount({ connectorAccountId: params.connectorAccountId, context, reason: body?.reason }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorInstances,
    queryValidator(connectorInstanceListQuerySchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector instances",
      description: "Lists connector instances visible to the current member.",
      responses: {
        200: jsonResponse("Connector instances returned successfully.", connectorInstanceListResponseSchema),
        400: jsonResponse("The connector instance query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list connector instances.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listConnectorInstances({ connectorAccountId: query.connectorAccountId, context: actorContext(c), cursor: query.cursor, limit: query.limit, pluginId: query.pluginId, q: query.q, status: query.status }))
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorInstances,
    jsonValidator(connectorInstanceCreateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Create connector instance",
      description: "Creates a new connector instance.",
      responses: {
        201: jsonResponse("Connector instance created successfully.", connectorInstanceMutationResponseSchema),
        400: jsonResponse("The connector instance creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create connector instances.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create connector instances.", forbiddenSchema),
        404: jsonResponse("The connector account could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_instance.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createConnectorInstance({ connectorAccountId: body.connectorAccountId, connectorType: body.connectorType, config: body.config, context, name: body.name, remoteId: body.remoteId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorInstance,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Get connector instance",
      description: "Returns one connector instance detail.",
      responses: {
        200: jsonResponse("Connector instance returned successfully.", connectorInstanceDetailResponseSchema),
        400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view connector instances.", unauthorizedSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ item: await getConnectorInstanceDetail(actorContext(c), validParam<any>(c).connectorInstanceId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "patch", pluginArchRoutePaths.connectorInstance,
    paramValidator(connectorInstanceParamsSchema),
    jsonValidator(connectorInstanceUpdateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Update connector instance",
      description: "Updates one connector instance.",
      responses: {
        200: jsonResponse("Connector instance updated successfully.", connectorInstanceMutationResponseSchema),
        400: jsonResponse("The connector instance update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update connector instances.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await updateConnectorInstance({ connectorInstanceId: params.connectorInstanceId, config: body.config, context: actorContext(c), name: body.name, remoteId: body.remoteId, status: body.status }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  for (const [path, action] of [[pluginArchRoutePaths.connectorInstanceArchive, "archive"], [pluginArchRoutePaths.connectorInstanceDisable, "disable"], [pluginArchRoutePaths.connectorInstanceEnable, "enable"]] as const) {
    withPluginArchOrgContext(app, "post", path,
      paramValidator(connectorInstanceParamsSchema),
      describeRoute({
        tags: ["Connectors"],
        summary: `${action} connector instance`,
        description: `${action} a connector instance.`,
        responses: {
          200: jsonResponse("Connector instance updated successfully.", connectorInstanceMutationResponseSchema),
          400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in to manage connector instances.", unauthorizedSchema),
          403: jsonResponse("The caller lacks permission to manage this connector instance.", forbiddenSchema),
          404: jsonResponse("The connector instance could not be found.", notFoundSchema),
        },
      }),
      async (c: OrgContext) => {
        try {
          const params = validParam<any>(c)
          return c.json({ ok: true, item: await setConnectorInstanceLifecycle({ action, connectorInstanceId: params.connectorInstanceId, context: actorContext(c) }) })
        } catch (error) {
          return routeErrorResponse(c, error)
        }
      })
  }

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorInstanceAccess,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector instance access grants",
      description: "Lists direct, team, and org-wide grants for a connector instance.",
      responses: {
        200: jsonResponse("Connector instance access grants returned successfully.", accessGrantListResponseSchema),
        400: jsonResponse("The connector instance access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage connector instance access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage connector instance access.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json(await listResourceAccess({ context: actorContext(c), resourceId: params.connectorInstanceId, resourceKind: "connector_instance" }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorInstanceAccess,
    paramValidator(connectorInstanceParamsSchema),
    jsonValidator(resourceAccessGrantWriteSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Grant connector instance access",
      description: "Creates or reactivates one access grant for a connector instance.",
      responses: {
        201: jsonResponse("Connector instance access grant created successfully.", accessGrantMutationResponseSchema),
        400: jsonResponse("The connector instance access request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage connector instance access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage connector instance access.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        return c.json({ ok: true, item: await createResourceAccessGrant({ context: actorContext(c), resourceId: params.connectorInstanceId, resourceKind: "connector_instance", value: validJson<any>(c) }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.connectorInstanceAccessGrant,
    paramValidator(connectorInstanceAccessGrantParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Revoke connector instance access",
      description: "Soft-revokes one connector instance access grant.",
      responses: {
        204: emptyResponse("Connector instance access revoked successfully."),
        400: jsonResponse("The connector instance access path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to manage connector instance access.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to manage connector instance access.", forbiddenSchema),
        404: jsonResponse("The access grant could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        await deleteResourceAccessGrant({ context: actorContext(c), grantId: params.grantId, resourceId: params.connectorInstanceId, resourceKind: "connector_instance" })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorTargets,
    paramValidator(connectorInstanceParamsSchema),
    queryValidator(connectorTargetListQuerySchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector targets",
      description: "Lists connector targets for one connector instance.",
      responses: {
        200: jsonResponse("Connector targets returned successfully.", connectorTargetListResponseSchema),
        400: jsonResponse("The connector target query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list connector targets.", unauthorizedSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const query = validQuery<any>(c)
        return c.json(await listConnectorTargets({ connectorInstanceId: params.connectorInstanceId, context: actorContext(c), cursor: query.cursor, limit: query.limit, q: query.q, targetKind: query.targetKind }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorTargets,
    paramValidator(connectorInstanceParamsSchema),
    jsonValidator(connectorTargetCreateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Create connector target",
      description: "Creates a connector target under a connector instance.",
      responses: {
        201: jsonResponse("Connector target created successfully.", connectorTargetMutationResponseSchema),
        400: jsonResponse("The connector target creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create connector targets.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createConnectorTarget({ config: body.config, connectorInstanceId: params.connectorInstanceId, connectorType: body.connectorType, context: actorContext(c), externalTargetRef: body.externalTargetRef, remoteId: body.remoteId, targetKind: body.targetKind }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorTarget,
    paramValidator(connectorTargetParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Get connector target",
      description: "Returns one connector target detail.",
      responses: {
        200: jsonResponse("Connector target returned successfully.", connectorTargetDetailResponseSchema),
        400: jsonResponse("The connector target path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view connector targets.", unauthorizedSchema),
        404: jsonResponse("The connector target could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ item: await getConnectorTargetDetail(actorContext(c), validParam<any>(c).connectorTargetId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "patch", pluginArchRoutePaths.connectorTarget,
    paramValidator(connectorTargetParamsSchema),
    jsonValidator(connectorTargetUpdateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Update connector target",
      description: "Updates one connector target.",
      responses: {
        200: jsonResponse("Connector target updated successfully.", connectorTargetMutationResponseSchema),
        400: jsonResponse("The connector target update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update connector targets.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector target could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await updateConnectorTarget({ config: body.config, connectorTargetId: params.connectorTargetId, context: actorContext(c), externalTargetRef: body.externalTargetRef, remoteId: body.remoteId }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorTargetResync,
    paramValidator(connectorTargetParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Resync connector target",
      description: "Queues a manual resync for a connector target.",
      responses: {
        202: jsonResponse("Connector target resync queued successfully.", connectorSyncAsyncResponseSchema),
        400: jsonResponse("The connector target path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to resync connector targets.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector target could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const job = await queueConnectorTargetResync({ connectorTargetId: validParam<any>(c).connectorTargetId, context: actorContext(c) })
        return c.json({ ok: true, queued: true, job }, 202)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorTargetMappings,
    paramValidator(connectorTargetParamsSchema),
    queryValidator(connectorMappingListQuerySchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector mappings",
      description: "Lists mappings under a connector target.",
      responses: {
        200: jsonResponse("Connector mappings returned successfully.", connectorMappingListResponseSchema),
        400: jsonResponse("The connector mapping query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list connector mappings.", unauthorizedSchema),
        404: jsonResponse("The connector target could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const query = validQuery<any>(c)
        return c.json(await listConnectorMappings({ connectorTargetId: params.connectorTargetId, context: actorContext(c), cursor: query.cursor, limit: query.limit, mappingKind: query.mappingKind, objectType: query.objectType, pluginId: query.pluginId, q: query.q }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorTargetMappings,
    paramValidator(connectorTargetParamsSchema),
    jsonValidator(connectorMappingCreateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Create connector mapping",
      description: "Creates a connector mapping.",
      responses: {
        201: jsonResponse("Connector mapping created successfully.", connectorMappingMutationResponseSchema),
        400: jsonResponse("The connector mapping creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create connector mappings.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance or target plugin.", forbiddenSchema),
        404: jsonResponse("The connector target could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createConnectorMapping({ autoAddToPlugin: body.autoAddToPlugin, config: body.config, connectorTargetId: params.connectorTargetId, context: actorContext(c), mappingKind: body.mappingKind, objectType: body.objectType, pluginId: body.pluginId, selector: body.selector }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "patch", pluginArchRoutePaths.connectorMapping,
    paramValidator(connectorMappingParamsSchema),
    jsonValidator(connectorMappingUpdateSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Update connector mapping",
      description: "Updates one connector mapping.",
      responses: {
        200: jsonResponse("Connector mapping updated successfully.", connectorMappingMutationResponseSchema),
        400: jsonResponse("The connector mapping update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update connector mappings.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance or target plugin.", forbiddenSchema),
        404: jsonResponse("The connector mapping could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await updateConnectorMapping({ autoAddToPlugin: body.autoAddToPlugin, config: body.config, connectorMappingId: params.connectorMappingId, context: actorContext(c), objectType: body.objectType, pluginId: body.pluginId, selector: body.selector }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "delete", pluginArchRoutePaths.connectorMapping,
    paramValidator(connectorMappingParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Delete connector mapping",
      description: "Deletes one connector mapping.",
      responses: {
        204: emptyResponse("Connector mapping deleted successfully."),
        400: jsonResponse("The connector mapping path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete connector mappings.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector mapping could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        await deleteConnectorMapping({ connectorMappingId: validParam<any>(c).connectorMappingId, context: actorContext(c) })
        return c.body(null, 204)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorSyncEvents,
    queryValidator(connectorSyncEventListQuerySchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "List connector sync events",
      description: "Lists connector sync events visible to the current member.",
      responses: {
        200: jsonResponse("Connector sync events returned successfully.", connectorSyncEventListResponseSchema),
        400: jsonResponse("The connector sync event query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list connector sync events.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const query = validQuery<any>(c)
      return c.json(await listConnectorSyncEvents({ connectorInstanceId: query.connectorInstanceId, connectorTargetId: query.connectorTargetId, context: actorContext(c), cursor: query.cursor, eventType: query.eventType, limit: query.limit, q: query.q, status: query.status }))
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.connectorSyncEvent,
    paramValidator(connectorSyncEventParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Get connector sync event",
      description: "Returns one connector sync event detail.",
      responses: {
        200: jsonResponse("Connector sync event returned successfully.", connectorSyncEventDetailResponseSchema),
        400: jsonResponse("The connector sync event path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to view connector sync events.", unauthorizedSchema),
        404: jsonResponse("The connector sync event could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ item: await getConnectorSyncEventDetail(actorContext(c), validParam<any>(c).connectorSyncEventId) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.connectorSyncEventRetry,
    paramValidator(connectorSyncEventParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Retry connector sync event",
      description: "Re-queues one connector sync event.",
      responses: {
        202: jsonResponse("Connector sync event retried successfully.", connectorSyncAsyncResponseSchema),
        400: jsonResponse("The connector sync event path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to retry connector sync events.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector sync event could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const job = await retryConnectorSyncEvent({ connectorSyncEventId: validParam<any>(c).connectorSyncEventId, context: actorContext(c) })
        return c.json({ ok: true, queued: true, job }, 202)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.githubAccounts,
    jsonValidator(githubConnectorAccountCreateSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Create GitHub connector account",
      description: "Persists one GitHub App installation as a connector account.",
      responses: {
        201: jsonResponse("GitHub connector account created successfully.", connectorAccountMutationResponseSchema),
        400: jsonResponse("The GitHub account creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create GitHub connector accounts.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to create GitHub connector accounts.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_account.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await createGithubConnectorAccount({ accountLogin: body.accountLogin, accountType: body.accountType, context, displayName: body.displayName, installationId: body.installationId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.githubSetup,
    jsonValidator(githubConnectorSetupSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Setup GitHub connector",
      description: "Creates a GitHub connector account, instance, target, and initial mappings in one flow.",
      responses: {
        201: jsonResponse("GitHub connector setup created successfully.", githubSetupResponseSchema),
        400: jsonResponse("The GitHub setup request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to setup GitHub connectors.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to setup GitHub connectors.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_instance.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await githubSetup({ branch: body.branch, connectorAccountId: body.connectorAccountId, connectorInstanceName: body.connectorInstanceName, context, installationId: body.installationId, mappings: body.mappings, ref: body.ref, repositoryFullName: body.repositoryFullName, repositoryId: body.repositoryId }) }, 201)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", pluginArchRoutePaths.githubAccountRepositories,
    paramValidator(connectorAccountRepositoryParamsSchema),
    queryValidator(githubRepositoryListQuerySchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "List GitHub repositories",
      description: "Lists repositories visible to one GitHub connector account.",
      responses: {
        200: jsonResponse("GitHub repositories returned successfully.", githubRepositoryListResponseSchema),
        400: jsonResponse("The GitHub repository query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list GitHub repositories.", unauthorizedSchema),
        404: jsonResponse("The connector account could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const query = validQuery<any>(c)
        return c.json(await listGithubRepositories({ connectorAccountId: params.connectorAccountId, context: actorContext(c), cursor: query.cursor, limit: query.limit, q: query.q }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", pluginArchRoutePaths.githubValidateTarget,
    jsonValidator(githubValidateTargetSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Validate GitHub target",
      description: "Validates one repository-branch target before persisting it.",
      responses: {
        200: jsonResponse("GitHub target validated successfully.", githubValidateTargetResponseSchema),
        400: jsonResponse("The GitHub target validation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to validate GitHub targets.", unauthorizedSchema),
      },
    }),
    async (c: OrgContext) => {
      const body = validJson<any>(c)
      return c.json({ ok: true, item: await validateGithubTarget({ branch: body.branch, ref: body.ref, repositoryFullName: body.repositoryFullName }) })
    })
}
