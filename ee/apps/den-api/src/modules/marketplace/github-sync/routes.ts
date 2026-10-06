import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { queryValidator, jsonValidator, paramValidator } from "../../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../../openapi.js"
import type { OrgRouteVariables } from "../../../routes/org/shared.js"
import {
  connectorAccountCreateSchema,
  connectorAccountDetailResponseSchema,
  connectorAccountDisconnectResponseSchema,
  connectorAccountDisconnectSchema,
  connectorAccountListQuerySchema,
  connectorAccountListResponseSchema,
  connectorAccountMutationResponseSchema,
  connectorAccountParamsSchema,
  connectorAccountRepositoryParamsSchema,
  connectorInstanceAccessGrantParamsSchema,
  connectorInstanceAutoImportSchema,
  connectorInstanceConfigurationResponseSchema,
  connectorInstanceCreateSchema,
  connectorInstanceDetailResponseSchema,
  connectorInstanceListQuerySchema,
  connectorInstanceListResponseSchema,
  connectorInstanceMutationResponseSchema,
  connectorInstanceParamsSchema,
  connectorInstanceRemoveResponseSchema,
  connectorInstanceSyncNowResponseSchema,
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
  githubConnectorDiscoveryResponseSchema,
  githubConnectorSetupSchema,
  githubDiscoveryApplyResponseSchema,
  githubDiscoveryApplySchema,
  githubDiscoveryTreeQuerySchema,
  githubDiscoveryTreeResponseSchema,
  githubInstallCompleteResponseSchema,
  githubInstallCompleteSchema,
  githubInstallStartResponseSchema,
  githubInstallStartSchema,
  githubRepositoryListQuerySchema,
  githubRepositoryListResponseSchema,
  githubSetupResponseSchema,
  githubValidateTargetResponseSchema,
  githubValidateTargetSchema,
} from "./schemas.js"
import { accessGrantListResponseSchema, accessGrantMutationResponseSchema, resourceAccessGrantWriteSchema } from "../schemas.js"
import { requirePluginArchCapability } from "../../../routes/org/plugin-system/access.js"
import {
  applyGithubConnectorDiscovery,
  completeGithubConnectorInstall,
  createConnectorAccount,
  createConnectorInstance,
  createConnectorMapping,
  createConnectorTarget,
  createGithubConnectorAccount,
  deleteConnectorMapping,
  disconnectConnectorAccount,
  getConnectorAccountDetail,
  getConnectorInstanceConfiguration,
  getConnectorInstanceDetail,
  getConnectorSyncEventDetail,
  getConnectorTargetDetail,
  getGithubConnectorDiscovery,
  getGithubConnectorDiscoveryTree,
  githubSetup,
  listConnectorAccounts,
  listConnectorInstances,
  listConnectorMappings,
  listConnectorSyncEvents,
  listConnectorTargets,
  listGithubRepositories,
  queueConnectorTargetResync,
  removeConnectorInstance,
  retryConnectorSyncEvent,
  setConnectorInstanceAutoImport,
  setConnectorInstanceLifecycle,
  startGithubConnectorInstall,
  syncConnectorInstanceNow,
  updateConnectorInstance,
  updateConnectorMapping,
  updateConnectorTarget,
  validateGithubTarget,
} from "./store/index.js"
// TODO(W0-P03 PR 4): import from the marketplace store modules once they leave the old store.
import { createResourceAccessGrant, deleteResourceAccessGrant, listResourceAccess } from "../../../routes/org/plugin-system/store.js"
import {
  actorContext,
  type OrgContext,
  routeErrorResponse,
  validJson,
  validParam,
  validQuery,
  withPluginArchOrgContext,
} from "../routes/shared.js"
import { githubSyncRoutePaths } from "./contracts.js"

export function registerGithubInstallRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  withPluginArchOrgContext(
    app,
    "post",
    githubSyncRoutePaths.githubInstallStart,
    jsonValidator(githubInstallStartSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Start GitHub install",
      description: "Builds a GitHub App install redirect URL for the current organization.",
      responses: {
        200: jsonResponse("GitHub install redirect returned successfully.", githubInstallStartResponseSchema),
        400: jsonResponse("The GitHub install request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to connect GitHub.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to connect GitHub.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_account.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await startGithubConnectorInstall({ context, returnPath: body.returnPath }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    },
  )

  withPluginArchOrgContext(
    app,
    "post",
    githubSyncRoutePaths.githubInstallComplete,
    jsonValidator(githubInstallCompleteSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Complete GitHub install",
      description: "Completes a GitHub App installation for the current organization and returns visible repositories.",
      responses: {
        200: jsonResponse("GitHub installation completed successfully.", githubInstallCompleteResponseSchema),
        400: jsonResponse("The GitHub install completion request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to complete GitHub connection.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to complete GitHub connection.", forbiddenSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        await requirePluginArchCapability(context, "connector_account.create")
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await completeGithubConnectorInstall({ context, installationId: body.installationId, state: body.state }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    },
  )
}

export function registerGithubSyncRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorAccounts,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorAccounts,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorAccount,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorAccountDisconnect,
    paramValidator(connectorAccountParamsSchema),
    jsonValidator(connectorAccountDisconnectSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Disconnect connector account",
      description: "Disconnects a connector account and cleans up all associated connector-managed records.",
      responses: {
        200: jsonResponse("Connector account disconnected and cleaned up successfully.", connectorAccountDisconnectResponseSchema),
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstances,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstances,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstance,
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

  withPluginArchOrgContext(app, "patch", githubSyncRoutePaths.connectorInstance,
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

  for (const [path, action] of [[githubSyncRoutePaths.connectorInstanceArchive, "archive"], [githubSyncRoutePaths.connectorInstanceDisable, "disable"], [githubSyncRoutePaths.connectorInstanceEnable, "enable"]] as const) {
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstanceConfiguration,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Get connector instance configuration",
      description: "Returns the currently configured plugins and import stats for a connector instance.",
      responses: {
        200: jsonResponse("Connector instance configuration returned successfully.", connectorInstanceConfigurationResponseSchema),
        400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to inspect connector instances.", unauthorizedSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ ok: true, item: await getConnectorInstanceConfiguration({ connectorInstanceId: validParam<any>(c).connectorInstanceId, context: actorContext(c) }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstanceRemove,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Remove connector instance",
      description: "Removes a connector instance and deletes the plugins, mappings, config objects, and bindings associated with it.",
      responses: {
        200: jsonResponse("Connector instance removed and cleaned up successfully.", connectorInstanceRemoveResponseSchema),
        400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to remove connector instances.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to remove this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        return c.json({ ok: true, item: await removeConnectorInstance({ connectorInstanceId: validParam<any>(c).connectorInstanceId, context }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstanceAutoImport,
    paramValidator(connectorInstanceParamsSchema),
    jsonValidator(connectorInstanceAutoImportSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Set connector instance auto-import",
      description: "Enables or disables auto-import of new plugins on future push webhooks for a connector instance.",
      responses: {
        200: jsonResponse("Connector instance auto-import updated successfully.", connectorInstanceConfigurationResponseSchema),
        400: jsonResponse("The auto-import request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to configure connector instances.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to configure this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const context = actorContext(c)
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        return c.json({ ok: true, item: await setConnectorInstanceAutoImport({ autoImportNewPlugins: Boolean(body.autoImportNewPlugins), connectorInstanceId: params.connectorInstanceId, context }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstanceSyncNow,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["Connectors"],
      summary: "Sync connector instance now",
      description: "Queues sync work for each connector target without sync work already queued or running.",
      responses: {
        200: jsonResponse("Connector instance sync queued successfully.", connectorInstanceSyncNowResponseSchema),
        400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to sync connector instances.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const item = await syncConnectorInstanceNow({
          connectorInstanceId: normalizeDenTypeId(
            "connectorInstance",
            validParam<z.infer<typeof connectorInstanceParamsSchema>>(c).connectorInstanceId,
          ),
          context: actorContext(c),
        })
        return c.json({ ok: true, item }, 200)
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstanceDiscovery,
    paramValidator(connectorInstanceParamsSchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Get GitHub connector discovery",
      description: "Analyzes a GitHub connector target and returns discovered plugin candidates.",
      responses: {
        200: jsonResponse("GitHub connector discovery returned successfully.", githubConnectorDiscoveryResponseSchema),
        400: jsonResponse("The connector instance path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to inspect GitHub discovery.", unauthorizedSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        return c.json({ ok: true, item: await getGithubConnectorDiscovery({ connectorInstanceId: validParam<any>(c).connectorInstanceId, context: actorContext(c) }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstanceDiscoveryTree,
    paramValidator(connectorInstanceParamsSchema),
    queryValidator(githubDiscoveryTreeQuerySchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "List GitHub discovery tree entries",
      description: "Pages through the normalized GitHub repository tree used during discovery.",
      responses: {
        200: jsonResponse("GitHub discovery tree returned successfully.", githubDiscoveryTreeResponseSchema),
        400: jsonResponse("The discovery tree request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to inspect GitHub discovery tree entries.", unauthorizedSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const query = validQuery<any>(c)
        return c.json(await getGithubConnectorDiscoveryTree({ connectorInstanceId: params.connectorInstanceId, context: actorContext(c), cursor: query.cursor, limit: query.limit, prefix: query.prefix }))
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstanceDiscoveryApply,
    paramValidator(connectorInstanceParamsSchema),
    jsonValidator(githubDiscoveryApplySchema),
    describeRoute({
      tags: ["GitHub"],
      summary: "Apply GitHub discovery selection",
      description: "Creates OpenWork plugins and connector mappings from selected discovery candidates.",
      responses: {
        200: jsonResponse("GitHub discovery selection applied successfully.", githubDiscoveryApplyResponseSchema),
        400: jsonResponse("The discovery apply request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to apply discovery selections.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permission to edit this connector instance.", forbiddenSchema),
        404: jsonResponse("The connector instance could not be found.", notFoundSchema),
      },
    }),
    async (c: OrgContext) => {
      try {
        const params = validParam<any>(c)
        const body = validJson<any>(c)
        const context = actorContext(c)
        if (Array.isArray(body.selectedKeys) && body.selectedKeys.length > 0) {
          await requirePluginArchCapability(context, "plugin.create")
        }
        return c.json({ ok: true, item: await applyGithubConnectorDiscovery({ autoImportNewPlugins: Boolean(body.autoImportNewPlugins), connectorInstanceId: params.connectorInstanceId, context, selectedKeys: body.selectedKeys }) })
      } catch (error) {
        return routeErrorResponse(c, error)
      }
    })

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorInstanceAccess,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorInstanceAccess,
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

  withPluginArchOrgContext(app, "delete", githubSyncRoutePaths.connectorInstanceAccessGrant,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorTargets,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorTargets,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorTarget,
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

  withPluginArchOrgContext(app, "patch", githubSyncRoutePaths.connectorTarget,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorTargetResync,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorTargetMappings,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorTargetMappings,
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

  withPluginArchOrgContext(app, "patch", githubSyncRoutePaths.connectorMapping,
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

  withPluginArchOrgContext(app, "delete", githubSyncRoutePaths.connectorMapping,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorSyncEvents,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.connectorSyncEvent,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.connectorSyncEventRetry,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.githubAccounts,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.githubSetup,
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

  withPluginArchOrgContext(app, "get", githubSyncRoutePaths.githubAccountRepositories,
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

  withPluginArchOrgContext(app, "post", githubSyncRoutePaths.githubValidateTarget,
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
      return c.json({ ok: true, item: await validateGithubTarget({ branch: body.branch, installationId: body.installationId, ref: body.ref, repositoryFullName: body.repositoryFullName, repositoryId: body.repositoryId }) })
    })
}
