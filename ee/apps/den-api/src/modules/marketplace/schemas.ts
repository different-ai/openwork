import {
  accessRoleValues,
  configObjectCreatedViaValues,
  configObjectSourceModeValues,
  configObjectStatusValues,
  configObjectTypeValues,
  marketplaceStatusValues,
  membershipSourceValues,
  pluginStatusValues,
} from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { denTypeIdSchema } from "../../openapi.js"
import { keysetCursorQuerySchema } from "../../list-pagination.js"
import { idParamSchema } from "../../routes/org/shared.js"

const cursorSchema = z.string().trim().min(1).max(255)
export const jsonObjectSchema = z.object({}).passthrough()
// MEDIUMTEXT allows ~12.58 MB of encrypted plaintext; 1 MiB stays safely below storage
// while still ~40x the largest real skill document, yielding a clean 400 instead of a 500.
const configObjectInputMaxPayloadBytes = 1_048_576
const rawSourceTextSchema = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= configObjectInputMaxPayloadBytes,
  { message: `rawSourceText must be at most ${configObjectInputMaxPayloadBytes} bytes (1 MiB) after UTF-8 encoding.` },
)
export const nullableStringSchema = z.string().trim().min(1).nullable()
export const nullableTimestampSchema = z.string().datetime({ offset: true }).nullable()
const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true")

export const configObjectIdSchema = denTypeIdSchema("configObject")
export const configObjectVersionIdSchema = denTypeIdSchema("configObjectVersion")
export const configObjectAccessGrantIdSchema = denTypeIdSchema("configObjectAccessGrant")
export const pluginIdSchema = denTypeIdSchema("plugin")
export const pluginConfigObjectIdSchema = denTypeIdSchema("pluginConfigObject")
export const pluginAccessGrantIdSchema = denTypeIdSchema("pluginAccessGrant")
export const marketplaceIdSchema = denTypeIdSchema("marketplace")
export const marketplacePluginIdSchema = denTypeIdSchema("marketplacePlugin")
export const marketplaceAccessGrantIdSchema = denTypeIdSchema("marketplaceAccessGrant")
export const pluginMcpRequirementBindingIdSchema = denTypeIdSchema("pluginMcpRequirementBinding")
export const connectorAccountIdSchema = denTypeIdSchema("connectorAccount")
export const connectorInstanceIdSchema = denTypeIdSchema("connectorInstance")
export const connectorInstanceAccessGrantIdSchema = denTypeIdSchema("connectorInstanceAccessGrant")

export const connectorMappingIdSchema = denTypeIdSchema("connectorMapping")
export const connectorSyncEventIdSchema = denTypeIdSchema("connectorSyncEvent")

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

export const extensionSourceFormatSchema = z.enum([
  "agent-plugin",
  "openwork-builtin",
  "openwork-extension-manifest",
  "claude-plugin",
  "opencode-plugin",
  "mcp-directory",
  "manual",
])

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
  cursor: keysetCursorQuerySchema.optional(),
  status: pluginStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional().describe("Case-insensitive substring of the plugin name."),
  teamId: teamIdSchema.optional().describe("Plugins effectively accessible to this team, including organization and collection access."),
  memberId: memberIdSchema.optional().describe("Plugins effectively accessible to this member, including team, organization and collection access."),
  includeAccess: queryBooleanSchema.optional().describe("When true, each plugin the caller manages includes its active access grants."),
  includeTotal: queryBooleanSchema.optional().describe("When true, returns the total matching plugins before the cursor."),
  ownerId: memberIdSchema.optional().describe("Plugins created by this organization member."),
  includeFacets: queryBooleanSchema.optional().describe("Include team and owner counts across all matching pages. Each facet ignores its own current selection."),
}).refine((query) => !query.teamId || !query.memberId, { message: "Choose a team or a member, not both." })

export const marketplaceListQuerySchema = pluginArchPaginationQuerySchema.extend({
  status: marketplaceStatusSchema.optional(),
  q: z.string().trim().min(1).max(255).optional(),
})

export const configObjectParamsSchema = idParamSchema("configObjectId", "configObject")
export const configObjectVersionParamsSchema = configObjectParamsSchema.extend(idParamSchema("versionId", "configObjectVersion").shape)
export const configObjectAccessGrantParamsSchema = configObjectParamsSchema.extend(idParamSchema("grantId", "configObjectAccessGrant").shape)
export const pluginParamsSchema = idParamSchema("pluginId", "plugin")
export const pluginAccessGrantParamsSchema = pluginParamsSchema.extend(idParamSchema("grantId", "pluginAccessGrant").shape)
export const marketplaceParamsSchema = idParamSchema("marketplaceId", "marketplace")
export const marketplacePluginParamsSchema = marketplaceParamsSchema.extend(idParamSchema("pluginId", "plugin").shape)
export const marketplaceAccessGrantParamsSchema = marketplaceParamsSchema.extend(idParamSchema("grantId", "marketplaceAccessGrant").shape)
export const teamParamsSchema = idParamSchema("teamId", "team")

export const configObjectInputSchema = z.object({
  rawSourceText: rawSourceTextSchema.optional(),
  normalizedPayloadJson: jsonObjectSchema.refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= configObjectInputMaxPayloadBytes,
    { message: `normalizedPayloadJson must stringify to at most ${configObjectInputMaxPayloadBytes} bytes (1 MiB) after UTF-8 encoding.` },
  ).optional(),
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

/**
 * The same connector setup an admin fills in on the Connections page. It
 * configures the connection for a plugin-declared MCP server, either inline
 * while creating the plugin or later through the configure route.
 */
export const pluginMcpConnectionSetupSchema = z.object({
  authType: z.enum(["oauth", "apikey", "none"]).optional().default("oauth"),
  credentialMode: z.enum(["shared", "per_member"]).optional(),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(4096).optional(),
  }).optional(),
})

export const pluginCreateComponentSchema = z.object({
  type: configObjectTypeSchema,
  input: configObjectInputSchema.optional(),
  connection: pluginMcpConnectionSetupSchema.optional(),
  connectionId: z.string().trim().min(1).max(160).optional(),
}).superRefine((value, ctx) => {
  if (value.connection && value.type !== "mcp") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "connection is only allowed on mcp components.",
      path: ["connection"],
    })
  }
  if (value.connectionId && value.type !== "mcp") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "connectionId is only allowed on mcp components.",
      path: ["connectionId"],
    })
  }
  if (value.connection && value.connectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either connection or connectionId, not both.",
      path: ["connectionId"],
    })
  }
  if (!value.input && !value.connectionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "input is required unless connectionId is provided.",
      path: ["input"],
    })
  }
})

export const pluginCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema.optional(),
  sourceRepositoryUrl: z.string().trim().min(1).max(1024).optional(),
  components: z.array(pluginCreateComponentSchema).max(100).optional(),
  orgWide: z.boolean().optional(),
  marketplaceId: marketplaceIdSchema.optional(),
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

export const marketplaceLogoUrlSchema = z.string().trim().min(1).max(1024).refine(
  (value) => (value.startsWith("/") ? !value.startsWith("//") : /^https:\/\//i.test(value)),
  { message: "Logo URL must be an https:// URL or a root-relative path." },
)

export const marketplaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema.optional(),
  logoUrl: marketplaceLogoUrlSchema.nullable().optional(),
})

export const marketplaceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableStringSchema.optional(),
  logoUrl: marketplaceLogoUrlSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.description === undefined && value.logoUrl === undefined) {
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

export const pluginMcpRequirementConfigureSchema = pluginMcpConnectionSetupSchema.extend({
  configObjectId: configObjectIdSchema,
  serverName: z.string().trim().min(1).max(255),
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

export const teamPluginAccessSchema = z.object({
  plugin: z.object({
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(255),
    componentCount: z.number().int().nonnegative(),
  }),
  edge: z.enum(["direct_team", "via_catalog", "org_wide"]),
  marketplace: z.object({
    id: marketplaceIdSchema,
    name: z.string().trim().min(1).max(255),
  }).nullable(),
  role: accessRoleSchema,
  grantedBy: z.object({
    orgMembershipId: memberIdSchema,
    name: z.string().trim().min(1).max(255),
  }).nullable(),
  grantedAt: z.string().datetime({ offset: true }),
  grantId: pluginAccessGrantIdSchema.nullable(),
}).meta({ ref: "PluginArchTeamPluginAccess" })

const effectiveAccessEdgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mine") }),
  z.object({
    kind: z.literal("person"),
    sharedBy: z.object({
      orgMembershipId: memberIdSchema,
      name: z.string().trim().min(1).max(255),
    }).nullable(),
    grantedAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    kind: z.literal("team"),
    team: z.object({
      id: teamIdSchema,
      name: z.string().trim().min(1).max(255),
    }),
  }),
  z.object({ kind: z.literal("org_wide") }),
  z.object({
    kind: z.literal("catalog"),
    marketplace: z.object({
      id: marketplaceIdSchema,
      name: z.string().trim().min(1).max(255),
    }),
  }),
])

export const mePluginAccessSchema = z.object({
  plugin: z.object({
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(255),
    description: nullableStringSchema,
    componentCount: z.number().int().nonnegative(),
    sourceRepositoryUrl: z.string().trim().min(1).max(1024).nullable(),
  }),
  edges: z.array(effectiveAccessEdgeSchema),
  role: accessRoleSchema,
}).meta({ ref: "PluginArchMePluginAccess" })

export const libraryItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plugin"),
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(255),
    description: nullableStringSchema,
    componentCount: z.number().int().nonnegative(),
    componentKinds: z.array(z.string()),
    sourceRepositoryUrl: z.string().trim().min(1).max(1024).nullable(),
    edges: z.array(effectiveAccessEdgeSchema),
    role: accessRoleSchema,
  }),
  z.object({
    type: z.literal("app"),
    id: configObjectIdSchema,
    pluginId: pluginIdSchema,
    name: z.string().trim().min(1).max(255),
    description: nullableStringSchema,
    sourceUrl: z.string().url().max(2048),
    status: z.enum(["active", "retired"]),
    activeVersionId: configObjectVersionIdSchema.nullable(),
    state: z.literal("ready"),
    edges: z.array(effectiveAccessEdgeSchema),
    role: accessRoleSchema,
  }),
  z.object({
    type: z.literal("connection"),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(255),
    url: z.string(),
    description: nullableStringSchema,
    transport: z.enum(["mcp", "native"]),
    provider: z.string().trim().min(1).nullable(),
    state: z.enum(["connected", "needs_signin", "needs_admin_setup", "available"]),
    connectedAt: nullableTimestampSchema,
    edges: z.array(effectiveAccessEdgeSchema),
  }),
  z.object({
    type: z.literal("workflow"),
    id: configObjectIdSchema,
    plugin: z.object({ id: pluginIdSchema, name: z.string().trim().min(1).max(255) }).nullable(),
    name: z.string().trim().min(1).max(255),
    description: nullableStringSchema,
    role: accessRoleSchema,
    edges: z.array(effectiveAccessEdgeSchema),
    state: z.enum(["ready", "needs_signin", "needs_admin_setup"]),
    resultState: z.enum(["never_run", "fresh", "stale", "needs_attention"]),
    latestSuccessfulAt: nullableTimestampSchema,
    viewState: z.enum(["default", "custom_active", "build_failed", "retired"]),
    activeViewTitle: nullableStringSchema,
    automationCount: z.number().int().nonnegative(),
    source: z.object({
      kind: z.enum(["created", "installed_template"]),
      templateName: z.string().trim().min(1).max(255).optional(),
      templateVersion: z.string().trim().min(1).max(100).optional(),
    }),
  }),
]).meta({ ref: "PluginArchLibraryItem" })

export const meLibraryListResponseSchema = z.object({
  items: z.array(libraryItemSchema),
}).meta({ ref: "PluginArchMeLibraryListResponse" })

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

export const extensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1).max(2048),
  source: z.object({
    format: extensionSourceFormatSchema,
    trusted: z.boolean(),
    origin: z.enum(["builtin", "den", "workspace", "local"]).optional(),
    reference: z.string().trim().min(1).max(512).optional(),
  }),
  resources: z.array(jsonObjectSchema),
  contributions: z.array(jsonObjectSchema).optional(),
  setup: jsonObjectSchema.optional(),
  lifecycle: jsonObjectSchema.optional(),
}).passthrough().meta({ ref: "OpenWorkExtensionManifest" })

export const pluginExtensionSchema = z.object({
  id: pluginIdSchema,
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  sourceFormat: extensionSourceFormatSchema,
  manifest: extensionManifestSchema.nullable(),
}).meta({ ref: "PluginArchExtensionProjection" })

export const pluginSchema = z.object({
  id: pluginIdSchema,
  organizationId: denTypeIdSchema("organization"),
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  sourceRepositoryUrl: z.string().trim().min(1).max(1024).nullable(),
  sourceFormat: extensionSourceFormatSchema.nullable(),
  sourceSchemaVersion: z.string().trim().min(1).max(100).nullable(),
  status: pluginStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
  memberCount: z.number().int().nonnegative().optional(),
  marketplaces: z.array(z.object({
    id: marketplaceIdSchema,
    name: z.string().trim().min(1).max(255),
  })).optional(),
  extension: pluginExtensionSchema.nullable().optional(),
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
  externalKey: z.string().nullable(),
  id: marketplaceIdSchema,
  organizationId: denTypeIdSchema("organization"),
  name: z.string().trim().min(1).max(255),
  description: nullableStringSchema,
  logoUrl: nullableStringSchema,
  status: marketplaceStatusSchema,
  createdByOrgMembershipId: memberIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: nullableTimestampSchema,
  pluginCount: z.number().int().nonnegative().optional(),
}).meta({ ref: "PluginArchMarketplace" })

const pluginCloudReadinessSchema = z.object({
  state: z.enum(["ready", "needs_signin", "needs_admin_setup", "desktop_only", "not_synced"]),
  hasInstructional: z.boolean(),
  connections: z.array(z.object({
    authType: z.enum(["oauth", "apikey", "none"]).optional(),
    authTypeMismatch: z.boolean().optional(),
    configObjectId: configObjectIdSchema,
    id: z.string().nullable(),
    name: z.string(),
    serverName: z.string(),
    url: z.string(),
    credentialMode: z.enum(["shared", "per_member"]).optional(),
    connectedForMe: z.boolean().optional(),
    oauthClientConfigured: z.boolean().optional(),
    oauthClientRequired: z.boolean().optional(),
    requiredAuthType: z.enum(["oauth", "apikey", "none"]).optional(),
  })),
}).meta({ ref: "PluginArchPluginCloudReadiness" })

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
export const pluginListItemSchema = pluginSchema.extend({
  access: z.array(accessGrantSchema).optional().describe("Active access grants. Present only when includeAccess is true and the caller manages the plugin."),
}).meta({ ref: "PluginArchPluginListItem" })
export const pluginListResponseSchema = pluginArchListResponseSchema("PluginArchPluginListResponse", pluginListItemSchema).extend({
  total: z.number().int().nonnegative().optional(),
  teamCounts: z.array(z.object({ id: teamIdSchema, count: z.number().int().nonnegative() })).optional(),
  ownerCounts: z.array(z.object({ id: memberIdSchema.nullable(), count: z.number().int().nonnegative() })).optional(),
})
export const pluginDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchPluginDetailResponse", pluginSchema)
export const pluginMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchPluginMutationResponse", pluginSchema)
export const pluginMembershipListResponseSchema = pluginArchListResponseSchema("PluginArchPluginMembershipListResponse", pluginMembershipSchema)
export const pluginMembershipDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchPluginMembershipDetailResponse", pluginMembershipSchema)
export const pluginMembershipMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchPluginMembershipMutationResponse", pluginMembershipSchema)
export const marketplaceListResponseSchema = pluginArchListResponseSchema("PluginArchMarketplaceListResponse", marketplaceSchema)
export const marketplaceDetailResponseSchema = pluginArchDetailResponseSchema("PluginArchMarketplaceDetailResponse", marketplaceSchema)
export const marketplaceMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchMarketplaceMutationResponse", marketplaceSchema)

export const marketplaceResolvedResponseSchema = pluginArchMutationResponseSchema(
  "PluginArchMarketplaceResolvedResponse",
  z.object({
    marketplace: marketplaceSchema.extend({
      canDelete: z.boolean(),
    }),
    plugins: z.array(pluginSchema.extend({
      componentCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
      cloudReadiness: pluginCloudReadinessSchema.optional(),
    })),
    source: z.object({
      connectorAccountId: connectorAccountIdSchema,
      connectorInstanceId: connectorInstanceIdSchema,
      accountLogin: z.string().trim().min(1).nullable(),
      repositoryFullName: z.string().trim().min(1),
      branch: z.string().trim().min(1).nullable(),
    }).nullable(),
  }),
)

export const pluginMcpRequirementConfigureResponseSchema = pluginArchMutationResponseSchema(
  "PluginArchPluginMcpRequirementConfigureResponse",
  z.object({
    binding: z.object({
      id: pluginMcpRequirementBindingIdSchema,
      configObjectId: configObjectIdSchema,
      externalMcpConnectionId: z.string(),
      pluginId: pluginIdSchema,
      serverName: z.string(),
    }),
    connection: z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      authType: z.enum(["oauth", "apikey", "none"]),
      credentialMode: z.enum(["shared", "per_member"]),
      connected: z.boolean(),
      connectedAt: nullableTimestampSchema,
    }),
    links: z.object({
      yourConnections: z.string(),
    }),
  }),
)
export const marketplacePluginListResponseSchema = pluginArchListResponseSchema("PluginArchMarketplacePluginListResponse", marketplacePluginSchema)
export const marketplacePluginMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchMarketplacePluginMutationResponse", marketplacePluginSchema)
export const accessGrantListResponseSchema = pluginArchListResponseSchema("PluginArchAccessGrantListResponse", accessGrantSchema)
export const accessGrantMutationResponseSchema = pluginArchMutationResponseSchema("PluginArchAccessGrantMutationResponse", accessGrantSchema)
export const teamPluginAccessListResponseSchema = pluginArchListResponseSchema("PluginArchTeamPluginAccessListResponse", teamPluginAccessSchema).omit({ nextCursor: true })
export const mePluginAccessListResponseSchema = pluginArchListResponseSchema("PluginArchMePluginAccessListResponse", mePluginAccessSchema).omit({ nextCursor: true })

export const githubPluginMcpImportAccessSchema = z.object({
  orgWide: z.boolean().optional().default(true),
  memberIds: z.array(memberIdSchema).max(200).optional().default([]),
  teamIds: z.array(teamIdSchema).max(200).optional().default([]),
}).superRefine((value, ctx) => {
  if (!value.orgWide && value.memberIds.length === 0 && value.teamIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide orgWide=true or at least one member/team grant.",
      path: ["orgWide"],
    })
  }
})

export const githubPluginMcpImportPreviewSchema = z.object({
  githubUrl: z.string().trim().url().max(2048),
})

export const githubPluginMcpImportSchema = githubPluginMcpImportPreviewSchema.extend({
  access: githubPluginMcpImportAccessSchema.optional(),
  authType: z.enum(["oauth", "none"]).optional().default("oauth"),
  credentialMode: z.enum(["shared", "per_member"]).optional().default("per_member"),
  description: z.string().trim().max(65535).nullable().optional(),
  marketplaceId: marketplaceIdSchema.optional(),
  name: z.string().trim().min(1).max(255).optional(),
  selectedSkillKeys: z.array(z.string().trim().min(1).max(1024)).max(200).optional(),
  selectedServerKeys: z.array(z.string().trim().min(1).max(1024)).max(200).optional(),
  selectedServerNames: z.array(z.string().trim().min(1).max(255)).max(200).optional(),
})

const githubPluginMcpImportSkippedReasonSchema = z.enum(["headers_unsupported", "invalid_config", "invalid_url", "local_unsupported", "missing_url", "native_connector", "unsupported_auth"])

const githubPluginMcpImportMappingSchema = z.object({
  displayName: z.string(),
  kind: z.enum(["native", "preset"]),
  providerId: z.string(),
}).nullable().describe("The provider OpenWork already knows for this declared connector: a native connector (Google Workspace, Microsoft 365) or a connection preset.")

const githubPluginMcpImportReuseSchema = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
}).nullable().describe("The organization's existing connection this server uses instead of a new one. Only reported to organization admins.")

const githubPluginMcpImportServerSchema = z.object({
  authType: z.literal("oauth").nullable(),
  connectionId: z.string().nullable(),
  mapsTo: githubPluginMcpImportMappingSchema,
  name: z.string(),
  pluginKey: z.string(),
  pluginName: z.string(),
  reuse: githubPluginMcpImportReuseSchema,
  serverKey: z.string(),
  skippedReason: githubPluginMcpImportSkippedReasonSchema.nullable(),
  sourceSchemaVersion: z.string().nullable(),
  sourcePath: z.string(),
  supported: z.boolean(),
  url: z.string().nullable(),
}).meta({ ref: "GithubPluginMcpImportServer" })

const githubPluginMcpImportPlanSchema = z.object({
  branch: z.string(),
  classification: z.enum(["agent_plugin_repo", "claude_marketplace_repo", "claude_multi_plugin_repo", "claude_single_plugin_repo", "folder_inferred_repo", "unsupported"]),
  marketplace: z.object({
    description: z.string().nullable(),
    name: z.string().nullable(),
    owner: z.string().nullable(),
    version: z.string().nullable(),
  }).nullable(),
  plugins: z.array(z.object({
    description: z.string().nullable(),
    key: z.string(),
    mcpCount: z.number().int().nonnegative(),
    name: z.string(),
    skillCount: z.number().int().nonnegative(),
  })),
  repositoryFullName: z.string(),
  rootPath: z.string(),
  servers: z.array(githubPluginMcpImportServerSchema),
  skills: z.array(z.object({
    description: z.string().nullable(),
    name: z.string(),
    pluginKey: z.string(),
    pluginName: z.string(),
    skillKey: z.string(),
    skippedReason: z.enum(["invalid_skill"]).nullable(),
    sourceSchemaVersion: z.string().nullable(),
    sourcePath: z.string(),
    supported: z.boolean(),
  })),
  sourceSchemaVersion: z.string().nullable(),
  sourceRevisionRef: z.string(),
  warnings: z.array(z.string()),
}).meta({ ref: "GithubPluginMcpImportPlan" })

export const githubPluginMcpImportPreviewResponseSchema = pluginArchMutationResponseSchema(
  "GithubPluginMcpImportPreviewResponse",
  githubPluginMcpImportPlanSchema,
)

export const githubPluginMcpImportResponseSchema = pluginArchMutationResponseSchema(
  "GithubPluginMcpImportResponse",
  z.object({
    imported: z.array(z.object({
      connectionId: z.string(),
      connectionName: z.string(),
      existingConnection: z.boolean().describe("True when the server uses a connection the organization already had."),
      name: z.string(),
      url: z.string(),
    })),
    importedSkills: z.array(z.object({
      configObjectId: configObjectIdSchema,
      name: z.string(),
      sourcePath: z.string(),
    })),
    marketplaceId: marketplaceIdSchema.nullable(),
    mode: z.enum(["created", "updated"]),
    plugin: pluginSchema,
    removed: z.array(z.object({
      configObjectId: configObjectIdSchema,
      name: z.string(),
      objectType: z.enum(["mcp", "skill"]),
      sourcePath: z.string(),
    })).describe("Skills and MCP servers imported earlier that were deleted upstream; they are removed from the plugin and archived, not deleted."),
    skipped: z.array(z.object({
      mapsTo: githubPluginMcpImportMappingSchema,
      name: z.string(),
      reason: githubPluginMcpImportSkippedReasonSchema,
      reuse: githubPluginMcpImportReuseSchema,
    })),
    skippedSkills: z.array(z.object({
      name: z.string(),
      reason: z.enum(["invalid_skill"]),
      sourcePath: z.string(),
    })),
    unchanged: z.array(z.object({
      name: z.string(),
      objectType: z.enum(["mcp", "skill"]),
    })),
    updatedSkills: z.array(z.object({
      configObjectId: configObjectIdSchema,
      name: z.string(),
      sourcePath: z.string(),
    })),
  }),
)
