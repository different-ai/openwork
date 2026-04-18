import {
  accessRoleValues,
  configObjectCreatedViaValues,
  configObjectSourceModeValues,
  configObjectStatusValues,
  configObjectTypeValues,
  connectorAccountStatusValues,
  connectorInstanceStatusValues,
  connectorMappingKindValues,
  connectorSyncEventTypeValues,
  connectorSyncStatusValues,
  connectorTargetKindValues,
  connectorTypeValues,
  marketplaceStatusValues,
  membershipSourceValues,
  pluginStatusValues,
} from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { denTypeIdSchema } from "../../../openapi.js"
import { idParamSchema, orgIdParamSchema } from "../shared.js"

const cursorSchema = z.string().trim().min(1).max(255)
const jsonObjectSchema = z.object({}).passthrough()
const rawSourceTextSchema = z.string().trim().min(1)
const nullableStringSchema = z.string().trim().min(1).nullable()
const nullableTimestampSchema = z.string().datetime({ offset: true }).nullable()
const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true")

export const githubWebhookEventValues = ["push", "installation", "installation_repositories", "repository"] as const

export const configObjectIdSchema = denTypeIdSchema("configObject")
export const configObjectVersionIdSchema = denTypeIdSchema("configObjectVersion")
export const configObjectAccessGrantIdSchema = denTypeIdSchema("configObjectAccessGrant")
export const pluginIdSchema = denTypeIdSchema("plugin")
export const pluginConfigObjectIdSchema = denTypeIdSchema("pluginConfigObject")
export const pluginAccessGrantIdSchema = denTypeIdSchema("pluginAccessGrant")
export const marketplaceIdSchema = denTypeIdSchema("marketplace")
export const marketplacePluginIdSchema = denTypeIdSchema("marketplacePlugin")
export const marketplaceAccessGrantIdSchema = denTypeIdSchema("marketplaceAccessGrant")
export const connectorAccountIdSchema = denTypeIdSchema("connectorAccount")
export const connectorInstanceIdSchema = denTypeIdSchema("connectorInstance")
export const connectorInstanceAccessGrantIdSchema = denTypeIdSchema("connectorInstanceAccessGrant")
export const connectorTargetIdSchema = denTypeIdSchema("connectorTarget")
export const connectorMappingIdSchema = denTypeIdSchema("connectorMapping")
export const connectorSyncEventIdSchema = denTypeIdSchema("connectorSyncEvent")
export const connectorSourceBindingIdSchema = denTypeIdSchema("connectorSourceBinding")
export const connectorSourceTombstoneIdSchema = denTypeIdSchema("connectorSourceTombstone")
export const memberIdSchema = denTypeIdSchema("member")
export const teamIdSchema = denTypeIdSchema("team")

export const configObjectTypeSchema = z.enum(configObjectTypeValues)
export const configObjectSourceModeSchema = z.enum(configObjectSourceModeValues)
export const configObjectCreatedViaSchema = z.enum(configObjectCreatedViaValues)
export const configObjectStatusSchema = z.enum(configObjectStatusValues)
export const pluginStatusSchema = z.enum(pluginStatusValues)
export const marketplaceStatusSchema = z.enum(marketplaceStatusValues)
export const membershipSourceSchema = z.enum(membershipSourceValues)
export const accessRoleSchema = z.enum(accessRoleValues)
export const connectorTypeSchema = z.enum(connectorTypeValues)
export const connectorAccountStatusSchema = z.enum(connectorAccountStatusValues)
export const connectorInstanceStatusSchema = z.enum(connectorInstanceStatusValues)
export const connectorTargetKindSchema = z.enum(connectorTargetKindValues)
export const connectorMappingKindSchema = z.enum(connectorMappingKindValues)
export const connectorSyncStatusSchema = z.enum(connectorSyncStatusValues)
export const connectorSyncEventTypeSchema = z.enum(connectorSyncEventTypeValues)
export const githubWebhookEventSchema = z.enum(githubWebhookEventValues)

export const pluginArchPaginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const configObjectListQuerySchema = pluginArchPaginationQuerySchema.extend({
  type: configObjectTypeSchema.optional(),
  status: configObjectStatusSchema.optional(),
  sourceMode: configObjectSourceModeSchema.optional(),
  pluginId: pluginIdSchema.optional(),
  connectorInstanceId: connectorInstanceIdSchema.optional(),
  includeDeleted: queryBooleanSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const configObjectVersionListQuerySchema = pluginArchPaginationQuerySchema.extend({
  includeDeleted: queryBooleanSchema.optional(),
})

export const pluginListQuerySchema = pluginArchPaginationQuerySchema.extend({
  status: pluginStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const marketplaceListQuerySchema = pluginArchPaginationQuerySchema.extend({
  status: marketplaceStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const connectorAccountListQuerySchema = pluginArchPaginationQuerySchema.extend({
  connectorType: connectorTypeSchema.optional(),
  status: connectorAccountStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const connectorInstanceListQuerySchema = pluginArchPaginationQuerySchema.extend({
  connectorAccountId: connectorAccountIdSchema.optional(),
  connectorType: connectorTypeSchema.optional(),
  pluginId: pluginIdSchema.optional(),
  status: connectorInstanceStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const connectorTargetListQuerySchema = pluginArchPaginationQuerySchema.extend({
  targetKind: connectorTargetKindSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const connectorMappingListQuerySchema = pluginArchPaginationQuerySchema.extend({
  mappingKind: connectorMappingKindSchema.optional(),
  objectType: configObjectTypeSchema.optional(),
  pluginId: pluginIdSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const connectorSyncEventListQuerySchema = pluginArchPaginationQuerySchema.extend({
  connectorInstanceId: connectorInstanceIdSchema.optional(),
  connectorTargetId: connectorTargetIdSchema.optional(),
  eventType: connectorSyncEventTypeSchema.optional(),
  status: connectorSyncStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const githubRepositoryListQuerySchema = pluginArchPaginationQuerySchema.extend({
  q: z.string().trim().min(1).max(255).optional(),
})

export const configObjectParamsSchema = orgIdParamSchema.extend(idParamSchema("configObjectId", "configObject").shape)
export const configObjectVersionParamsSchema = configObjectParamsSchema.extend(idParamSchema("versionId", "configObjectVersion").shape)
export const configObjectAccessGrantParamsSchema = configObjectParamsSchema.extend(idParamSchema("grantId", "configObjectAccessGrant").shape)
export const pluginParamsSchema = orgIdParamSchema.extend(idParamSchema("pluginId", "plugin").shape)
export const pluginConfigObjectParamsSchema = pluginParamsSchema.extend(idParamSchema("configObjectId", "configObject").shape)
export const pluginAccessGrantParamsSchema = pluginParamsSchema.extend(idParamSchema("grantId", "pluginAccessGrant").shape)
export const marketplaceParamsSchema = orgIdParamSchema.extend(idParamSchema("marketplaceId", "marketplace").shape)
export const marketplacePluginParamsSchema = marketplaceParamsSchema.extend(idParamSchema("pluginId", "plugin").shape)
export const marketplaceAccessGrantParamsSchema = marketplaceParamsSchema.extend(idParamSchema("grantId", "marketplaceAccessGrant").shape)
export const connectorAccountParamsSchema = orgIdParamSchema.extend(idParamSchema("connectorAccountId", "connectorAccount").shape)
export const connectorInstanceParamsSchema = orgIdParamSchema.extend(idParamSchema("connectorInstanceId", "connectorInstance").shape)
export const connectorInstanceAccessGrantParamsSchema = connectorInstanceParamsSchema.extend(idParamSchema("grantId", "connectorInstanceAccessGrant").shape)
export const connectorTargetParamsSchema = orgIdParamSchema.extend(idParamSchema("connectorTargetId", "connectorTarget").shape)
export const connectorMappingParamsSchema = orgIdParamSchema.extend(idParamSchema("connectorMappingId", "connectorMapping").shape)
export const connectorSyncEventParamsSchema = orgIdParamSchema.extend(idParamSchema("connectorSyncEventId", "connectorSyncEvent").shape)

export const connectorAccountRepositoryParamsSchema = connectorAccountParamsSchema

export const configObjectInputSchema = z.object({
  rawSourceText: rawSourceTextSchema.optional(),
  normalizedPayloadJson: jsonObjectSchema.optional(),
  parserMode: z.string().trim().min(1).max(100).optional(),
  schemaVersion: z.string().trim().min(1).max(100).optional(),
  metadata: jsonObjectSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.rawSourceText && !value.normalizedPayloadJson) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either rawSourceText or normalizedPayloadJson.",
      path: ["rawSourceText"],
    })
  }
})

export const configObjectCreateSchema = z.object({
  type: configObjectTypeSchema,
  sourceMode: configObjectSourceModeSchema,
  pluginIds: z.array(pluginIdSchema).max(100).optional(),
  input: configObjectInputSchema,
})

export const configObjectCreateVersionSchema = z.object({
  input: configObjectInputSchema,
  reason: z.string().trim().min(1).max(255).optional(),
})

export const configObjectPluginAttachSchema = z.object({
  pluginId: pluginIdSchema,
  membershipSource: membershipSourceSchema.optional(),
})

export const resourceAccessGrantWriteSchema = z.object({
  orgMembershipId: memberIdSchema.optional(),
  teamId: teamIdSchema.optional(),
  orgWide: z.boolean().optional().default(false),
  role: accessRoleSchema,
}).superRefine((value, ctx) => {
  const count = Number(Boolean(value.orgMembershipId)) + Number(Boolean(value.teamId)) + Number(Boolean(value.orgWide))
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of orgMembershipId, teamId, or orgWide=true.",
      path: ["orgMembershipId"],
    })
  }
})

export const pluginCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema.optional(),
})

export const pluginUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableStringSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.description === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["name"],
    })
  }
})

export const marketplaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema.optional(),
})

export const marketplaceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableStringSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.description === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["name"],
    })
  }
})

export const pluginMembershipWriteSchema = z.object({
  configObjectId: configObjectIdSchema,
  membershipSource: membershipSourceSchema.optional(),
})

export const marketplacePluginWriteSchema = z.object({
  pluginId: pluginIdSchema,
  membershipSource: membershipSourceSchema.optional(),
})

export const connectorAccountCreateSchema = z.object({
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255),
  externalAccountRef: z.string().trim().min(1).max(255).nullable().optional(),
  displayName: z.string().trim().min(1).max(255),
  metadata: jsonObjectSchema.optional(),
})

export const connectorAccountDisconnectSchema = z.object({
  reason: z.string().trim().min(1).max(255).optional(),
}).optional()

export const connectorInstanceCreateSchema = z.object({
  connectorAccountId: connectorAccountIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable().optional(),
  name: z.string().trim().min(1).max(255),
  config: jsonObjectSchema.optional(),
})

export const connectorInstanceUpdateSchema = z.object({
  remoteId: z.string().trim().min(1).max(255).nullable().optional(),
  name: z.string().trim().min(1).max(255).optional(),
  status: connectorInstanceStatusSchema.optional(),
  config: jsonObjectSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.remoteId === undefined && value.name === undefined && value.status === undefined && value.config === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["name"],
    })
  }
})

export const connectorTargetCreateSchema = z.object({
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255),
  targetKind: connectorTargetKindSchema,
  externalTargetRef: z.string().trim().min(1).max(255).nullable().optional(),
  config: jsonObjectSchema,
})

export const connectorTargetUpdateSchema = z.object({
  remoteId: z.string().trim().min(1).max(255).optional(),
  externalTargetRef: z.string().trim().min(1).max(255).nullable().optional(),
  config: jsonObjectSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.remoteId === undefined && value.externalTargetRef === undefined && value.config === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["remoteId"],
    })
  }
})

export const connectorMappingCreateSchema = z.object({
  mappingKind: connectorMappingKindSchema,
  selector: z.string().trim().min(1).max(255),
  objectType: configObjectTypeSchema,
  pluginId: pluginIdSchema.nullable().optional(),
  autoAddToPlugin: z.boolean().default(false),
  config: jsonObjectSchema.optional(),
})

export const connectorMappingUpdateSchema = z.object({
  selector: z.string().trim().min(1).max(255).optional(),
  objectType: configObjectTypeSchema.optional(),
  pluginId: pluginIdSchema.nullable().optional(),
  autoAddToPlugin: z.boolean().optional(),
  config: jsonObjectSchema.optional(),
}).superRefine((value, ctx) => {
  if (
    value.selector === undefined
    && value.objectType === undefined
    && value.pluginId === undefined
    && value.autoAddToPlugin === undefined
    && value.config === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
      path: ["selector"],
    })
  }
})

export const githubConnectorSetupSchema = z.object({
  installationId: z.number().int().positive(),
  connectorAccountId: connectorAccountIdSchema.optional(),
  connectorInstanceName: z.string().trim().min(1).max(255),
  repositoryId: z.number().int().positive(),
  repositoryFullName: z.string().trim().min(1).max(255),
  branch: z.string().trim().min(1).max(255),
  ref: z.string().trim().min(1).max(255),
  mappings: z.array(connectorMappingCreateSchema).max(100).default([]),
})

export const githubConnectorAccountCreateSchema = z.object({
  installationId: z.number().int().positive(),
  accountLogin: z.string().trim().min(1).max(255),
  accountType: z.enum(["Organization", "User"]),
  displayName: z.string().trim().min(1).max(255),
})

export const githubValidateTargetSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  repositoryFullName: z.string().trim().min(1).max(255),
  branch: z.string().trim().min(1).max(255),
  ref: z.string().trim().min(1).max(255),
})

export const accessGrantSchema = z.object({
  id: z.union([configObjectAccessGrantIdSchema, pluginAccessGrantIdSchema, marketplaceAccessGrantIdSchema, connectorInstanceAccessGrantIdSchema]),
  orgMembershipId: memberIdSchema.nullable(),
  teamId: teamIdSchema.nullable(),
  orgWide: z.boolean(),
  role: accessRoleSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  removedAt: nullableTimestampSchema,
}).meta({ ref: "PluginArchAccessGrant" })

export const configObjectVersionSchema = z.object({
  id: configObjectVersionIdSchema,
  configObjectId: configObjectIdSchema,
  schemaVersion: z.string().trim().min(1).max(100).nullable(),
  normalizedPayloadJson: jsonObjectSchema.nullable(),
  rawSourceText: z.string().nullable(),
  createdVia: configObjectCreatedViaSchema,
  createdByOrgMembershipId: memberIdSchema.nullable(),
  connectorSyncEventId: connectorSyncEventIdSchema.nullable(),
  sourceRevisionRef: z.string().trim().min(1).max(255).nullable(),
  isDeletedVersion: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
}).meta({ ref: "PluginArchConfigObjectVersion" })

export const configObjectSchema = z.object({
  id: configObjectIdSchema,
  organizationId: denTypeIdSchema("organization"),
  objectType: configObjectTypeSchema,
  sourceMode: configObjectSourceModeSchema,
  title: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  searchText: z.string().trim().min(1).max(65535).nullable(),
  currentFileName: z.string().trim().min(1).max(255).nullable(),
  currentFileExtension: z.string().trim().min(1).max(32).nullable(),
  currentRelativePath: z.string().trim().min(1).max(255).nullable(),
  status: configObjectStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  connectorInstanceId: connectorInstanceIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
  latestVersion: configObjectVersionSchema.nullable(),
}).meta({ ref: "PluginArchConfigObject" })

export const pluginMembershipSchema = z.object({
  id: pluginConfigObjectIdSchema,
  pluginId: pluginIdSchema,
  configObjectId: configObjectIdSchema,
  membershipSource: membershipSourceSchema,
  connectorMappingId: connectorMappingIdSchema.nullable(),
  createdByOrgMembershipId: memberIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  removedAt: nullableTimestampSchema,
  configObject: configObjectSchema.optional(),
}).meta({ ref: "PluginArchPluginMembership" })

export const pluginSchema = z.object({
  id: pluginIdSchema,
  organizationId: denTypeIdSchema("organization"),
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  status: pluginStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
  memberCount: z.number().int().nonnegative().optional(),
}).meta({ ref: "PluginArchPlugin" })

export const marketplacePluginSchema = z.object({
  id: marketplacePluginIdSchema,
  marketplaceId: marketplaceIdSchema,
  pluginId: pluginIdSchema,
  membershipSource: membershipSourceSchema,
  createdByOrgMembershipId: memberIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  removedAt: nullableTimestampSchema,
  plugin: pluginSchema.optional(),
}).meta({ ref: "PluginArchMarketplacePluginMembership" })

export const marketplaceSchema = z.object({
  id: marketplaceIdSchema,
  organizationId: denTypeIdSchema("organization"),
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  status: marketplaceStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
  pluginCount: z.number().int().nonnegative().optional(),
}).meta({ ref: "PluginArchMarketplace" })

export const connectorAccountSchema = z.object({
  id: connectorAccountIdSchema,
  organizationId: denTypeIdSchema("organization"),
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255),
  externalAccountRef: z.string().trim().min(1).max(255).nullable(),
  displayName: z.string().trim().min(1).max(255),
  status: connectorAccountStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  metadata: jsonObjectSchema.optional(),
}).meta({ ref: "PluginArchConnectorAccount" })

export const connectorInstanceSchema = z.object({
  id: connectorInstanceIdSchema,
  organizationId: denTypeIdSchema("organization"),
  connectorAccountId: connectorAccountIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable(),
  name: z.string().trim().min(1).max(255),
  status: connectorInstanceStatusSchema,
  instanceConfigJson: jsonObjectSchema.nullable(),
  lastSyncedAt: nullableTimestampSchema,
  lastSyncStatus: connectorSyncStatusSchema.nullable(),
  lastSyncCursor: z.string().trim().min(1).max(255).nullable(),
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).meta({ ref: "PluginArchConnectorInstance" })

export const connectorTargetSchema = z.object({
  id: connectorTargetIdSchema,
  connectorInstanceId: connectorInstanceIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255),
  targetKind: connectorTargetKindSchema,
  externalTargetRef: z.string().trim().min(1).max(255).nullable(),
  targetConfigJson: jsonObjectSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).meta({ ref: "PluginArchConnectorTarget" })

export const connectorMappingSchema = z.object({
  id: connectorMappingIdSchema,
  connectorInstanceId: connectorInstanceIdSchema,
  connectorTargetId: connectorTargetIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable(),
  mappingKind: connectorMappingKindSchema,
  selector: z.string().trim().min(1).max(255),
  objectType: configObjectTypeSchema,
  pluginId: pluginIdSchema.nullable(),
  autoAddToPlugin: z.boolean(),
  mappingConfigJson: jsonObjectSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).meta({ ref: "PluginArchConnectorMapping" })

export const connectorSyncSummarySchema = z.object({
  createdCount: z.number().int().nonnegative().optional(),
  updatedCount: z.number().int().nonnegative().optional(),
  deletedCount: z.number().int().nonnegative().optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  failures: z.array(jsonObjectSchema).optional(),
}).passthrough().meta({ ref: "PluginArchConnectorSyncSummary" })

export const connectorSyncEventSchema = z.object({
  id: connectorSyncEventIdSchema,
  connectorInstanceId: connectorInstanceIdSchema,
  connectorTargetId: connectorTargetIdSchema.nullable(),
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable(),
  eventType: connectorSyncEventTypeSchema,
  externalEventRef: z.string().trim().min(1).max(255).nullable(),
  sourceRevisionRef: z.string().trim().min(1).max(255).nullable(),
  status: connectorSyncStatusSchema,
  summaryJson: connectorSyncSummarySchema.nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: nullableTimestampSchema,
}).meta({ ref: "PluginArchConnectorSyncEvent" })

export const connectorSourceBindingSchema = z.object({
  id: connectorSourceBindingIdSchema,
  configObjectId: configObjectIdSchema,
  connectorInstanceId: connectorInstanceIdSchema,
  connectorTargetId: connectorTargetIdSchema,
  connectorMappingId: connectorMappingIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable(),
  externalLocator: z.string().trim().min(1).max(255),
  externalStableRef: z.string().trim().min(1).max(255).nullable(),
  lastSeenSourceRevisionRef: z.string().trim().min(1).max(255).nullable(),
  status: configObjectStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
}).meta({ ref: "PluginArchConnectorSourceBinding" })

export const connectorSourceTombstoneSchema = z.object({
  id: connectorSourceTombstoneIdSchema,
  connectorInstanceId: connectorInstanceIdSchema,
  connectorTargetId: connectorTargetIdSchema,
  connectorMappingId: connectorMappingIdSchema,
  connectorType: connectorTypeSchema,
  remoteId: z.string().trim().min(1).max(255).nullable(),
  externalLocator: z.string().trim().min(1).max(255),
  formerConfigObjectId: configObjectIdSchema,
  deletedInSyncEventId: connectorSyncEventIdSchema,
  deletedSourceRevisionRef: z.string().trim().min(1).max(255).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).meta({ ref: "PluginArchConnectorSourceTombstone" })

export const githubWebhookHeadersSchema = z.object({
  xHubSignature256: z.string().trim().min(1),
  xGithubEvent: githubWebhookEventSchema,
  xGithubDelivery: z.string().trim().min(1),
}).meta({ ref: "PluginArchGithubWebhookHeaders" })

export const githubWebhookPayloadSchema = z.object({
  after: z.string().trim().min(1).optional(),
  installation: z.object({
    id: z.number().int().positive(),
  }).passthrough().optional(),
  ref: z.string().trim().min(1).optional(),
  repository: z.object({
    full_name: z.string().trim().min(1),
    id: z.number().int().positive(),
  }).passthrough().optional(),
}).passthrough().meta({ ref: "PluginArchGithubWebhookPayload" })

export const githubWebhookEnvelopeSchema = z.object({
  deliveryId: z.string().trim().min(1),
  event: githubWebhookEventSchema,
  installationId: z.number().int().positive().optional(),
  repositoryId: z.number().int().positive().optional(),
  repositoryFullName: z.string().trim().min(1).optional(),
  ref: z.string().trim().min(1).optional(),
  headSha: z.string().trim().min(1).optional(),
  payload: githubWebhookPayloadSchema,
}).meta({ ref: "PluginArchGithubWebhookEnvelope" })

export const githubConnectorSyncJobSchema = z.object({
  connectorType: z.literal("github"),
  connectorInstanceId: connectorInstanceIdSchema,
  connectorTargetId: connectorTargetIdSchema,
  connectorSyncEventId: connectorSyncEventIdSchema,
  deliveryId: z.string().trim().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  repositoryFullName: z.string().trim().min(1),
  ref: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
}).meta({ ref: "PluginArchGithubConnectorSyncJob" })

export const githubWebhookRawBodySchema = z.string().min(1).meta({ ref: "PluginArchGithubWebhookRawBody" })

export const githubWebhookAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  accepted: z.literal(true),
  event: githubWebhookEventSchema,
  deliveryId: z.string().trim().min(1),
  queued: z.boolean(),
}).meta({ ref: "PluginArchGithubWebhookAcceptedResponse" })

export const githubWebhookIgnoredResponseSchema = z.object({
  ok: z.literal(true),
  accepted: z.literal(false),
  reason: z.string().trim().min(1),
}).meta({ ref: "PluginArchGithubWebhookIgnoredResponse" })

export const githubWebhookUnauthorizedResponseSchema = z.object({
  ok: z.literal(false),
  error: z.literal("invalid signature"),
}).meta({ ref: "PluginArchGithubWebhookUnauthorizedResponse" })

export function pluginArchListResponseSchema<TSchema extends z.ZodTypeAny>(ref: string, itemSchema: TSchema) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: cursorSchema.nullable(),
  }).meta({ ref })
}

export function pluginArchDetailResponseSchema<TSchema extends z.ZodTypeAny>(ref: string, itemSchema: TSchema) {
  return z.object({
    item: itemSchema,
  }).meta({ ref })
}

export function pluginArchMutationResponseSchema<TSchema extends z.ZodTypeAny>(ref: string, itemSchema: TSchema) {
  return z.object({
    ok: z.literal(true),
    item: itemSchema,
  }).meta({ ref })
}

export function pluginArchAsyncResponseSchema<TSchema extends z.ZodTypeAny>(ref: string, jobSchema: TSchema) {
  return z.object({
    ok: z.literal(true),
    queued: z.literal(true),
    job: jobSchema,
  }).meta({ ref })
}

export const configObjectListResponseSchema = pluginArchListResponseSchema("PluginArchConfigObjectListResponse", configObjectSchema)
export const configObjectDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConfigObjectDetailResponse", configObjectSchema)
export const configObjectMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchConfigObjectMutationResponse", configObjectSchema)
export const configObjectVersionListResponseSchema = pluginArchListResponseSchema("PluginArchConfigObjectVersionListResponse", configObjectVersionSchema)
export const configObjectVersionDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConfigObjectVersionDetailResponse", configObjectVersionSchema)
export const pluginListResponseSchema = pluginArchListResponseSchema("PluginArchPluginListResponse", pluginSchema)
export const pluginDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchPluginDetailResponse", pluginSchema)
export const pluginMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchPluginMutationResponse", pluginSchema)
export const pluginMembershipListResponseSchema = pluginArchListResponseSchema("PluginArchPluginMembershipListResponse", pluginMembershipSchema)
export const pluginMembershipDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchPluginMembershipDetailResponse", pluginMembershipSchema)
export const pluginMembershipMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchPluginMembershipMutationResponse", pluginMembershipSchema)
export const marketplaceListResponseSchema = pluginArchListResponseSchema("PluginArchMarketplaceListResponse", marketplaceSchema)
export const marketplaceDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchMarketplaceDetailResponse", marketplaceSchema)
export const marketplaceMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchMarketplaceMutationResponse", marketplaceSchema)
export const marketplacePluginListResponseSchema = pluginArchListResponseSchema("PluginArchMarketplacePluginListResponse", marketplacePluginSchema)
export const marketplacePluginMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchMarketplacePluginMutationResponse", marketplacePluginSchema)
export const accessGrantListResponseSchema = pluginArchListResponseSchema("PluginArchAccessGrantListResponse", accessGrantSchema)
export const accessGrantMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchAccessGrantMutationResponse", accessGrantSchema)
export const connectorAccountListResponseSchema = pluginArchListResponseSchema("PluginArchConnectorAccountListResponse", connectorAccountSchema)
export const connectorAccountDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConnectorAccountDetailResponse", connectorAccountSchema)
export const connectorAccountMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchConnectorAccountMutationResponse", connectorAccountSchema)
export const connectorInstanceListResponseSchema = pluginArchListResponseSchema("PluginArchConnectorInstanceListResponse", connectorInstanceSchema)
export const connectorInstanceDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConnectorInstanceDetailResponse", connectorInstanceSchema)
export const connectorInstanceMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchConnectorInstanceMutationResponse", connectorInstanceSchema)
export const connectorTargetListResponseSchema = pluginArchListResponseSchema("PluginArchConnectorTargetListResponse", connectorTargetSchema)
export const connectorTargetDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConnectorTargetDetailResponse", connectorTargetSchema)
export const connectorTargetMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchConnectorTargetMutationResponse", connectorTargetSchema)
export const connectorMappingListResponseSchema = pluginArchListResponseSchema("PluginArchConnectorMappingListResponse", connectorMappingSchema)
export const connectorMappingMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchConnectorMappingMutationResponse", connectorMappingSchema)
export const connectorSyncEventListResponseSchema = pluginArchListResponseSchema("PluginArchConnectorSyncEventListResponse", connectorSyncEventSchema)
export const connectorSyncEventDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchConnectorSyncEventDetailResponse", connectorSyncEventSchema)
export const connectorSyncAsyncResponseSchema = pluginArchAsyncResponseSchema(
  "PluginArchConnectorSyncAsyncResponse",
  z.object({ id: connectorSyncEventIdSchema }),
)
export const githubRepositorySchema = z.object({
  id: z.number().int().positive(),
  fullName: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1).nullable(),
  private: z.boolean(),
}).meta({ ref: "PluginArchGithubRepository" })
export const githubRepositoryListResponseSchema = pluginArchListResponseSchema("PluginArchGithubRepositoryListResponse", githubRepositorySchema)
export const githubSetupResponseSchema = pluginArchMutationResponseSchema(
  "PluginArchGithubSetupResponse",
  z.object({
    connectorAccount: connectorAccountSchema,
    connectorInstance: connectorInstanceSchema,
    connectorTarget: connectorTargetSchema,
  }),
)
export const githubValidateTargetResponseSchema = pluginArchMutationResponseSchema(
  "PluginArchGithubValidateTargetResponse",
  z.object({
    branchExists: z.boolean(),
    defaultBranch: z.string().trim().min(1).nullable(),
    repositoryAccessible: z.boolean(),
  }),
)
