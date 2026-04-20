import { z } from "zod";
import { identifierSchema, isoTimestampSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const managedKindSchema = z.enum(["mcps", "plugins", "providerConfigs", "skills"]);

export const managedItemSchema = z.object({
  auth: jsonObjectSchema.nullable(),
  cloudItemId: z.string().nullable(),
  config: jsonObjectSchema,
  createdAt: isoTimestampSchema,
  displayName: z.string(),
  id: identifierSchema,
  key: z.string().nullable(),
  metadata: jsonObjectSchema.nullable(),
  source: z.enum(["cloud_synced", "discovered", "imported", "openwork_managed"]),
  updatedAt: isoTimestampSchema,
  workspaceIds: z.array(identifierSchema),
}).meta({ ref: "OpenWorkServerV2ManagedItem" });

export const managedItemWriteSchema = z.object({
  auth: jsonObjectSchema.nullable().optional(),
  cloudItemId: z.string().nullable().optional(),
  config: jsonObjectSchema.optional(),
  displayName: z.string(),
  key: z.string().nullable().optional(),
  metadata: jsonObjectSchema.nullable().optional(),
  source: z.enum(["cloud_synced", "discovered", "imported", "openwork_managed"]).optional(),
  workspaceIds: z.array(identifierSchema).optional(),
}).meta({ ref: "OpenWorkServerV2ManagedItemWrite" });

export const managedAssignmentWriteSchema = z.object({
  workspaceIds: z.array(identifierSchema),
}).meta({ ref: "OpenWorkServerV2ManagedAssignmentWrite" });

export const managedItemListResponseSchema = successResponseSchema(
  "OpenWorkServerV2ManagedItemListResponse",
  z.object({ items: z.array(managedItemSchema) }),
);
export const managedItemResponseSchema = successResponseSchema("OpenWorkServerV2ManagedItemResponse", managedItemSchema);
export const managedDeleteResponseSchema = successResponseSchema(
  "OpenWorkServerV2ManagedDeleteResponse",
  z.object({ deleted: z.boolean(), id: identifierSchema }),
);

export const workspaceMcpItemSchema = z.object({
  config: jsonObjectSchema,
  disabledByTools: z.boolean().optional(),
  name: z.string(),
  source: z.enum(["config.global", "config.project", "config.remote"]),
}).meta({ ref: "OpenWorkServerV2WorkspaceMcpItem" });
export const workspaceMcpListResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceMcpListResponse",
  z.object({ items: z.array(workspaceMcpItemSchema) }),
);
export const workspaceMcpWriteSchema = z.object({
  config: jsonObjectSchema,
  name: z.string(),
}).meta({ ref: "OpenWorkServerV2WorkspaceMcpWrite" });

export const workspacePluginItemSchema = z.object({
  path: z.string().optional(),
  scope: z.enum(["global", "project"]),
  source: z.enum(["config", "dir.project", "dir.global"]),
  spec: z.string(),
}).meta({ ref: "OpenWorkServerV2WorkspacePluginItem" });
export const workspacePluginListResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspacePluginListResponse",
  z.object({ items: z.array(workspacePluginItemSchema), loadOrder: z.array(z.string()) }),
);
export const workspacePluginWriteSchema = z.object({ spec: z.string() }).meta({ ref: "OpenWorkServerV2WorkspacePluginWrite" });

export const scheduledJobRunSchema = z.object({
  agent: z.string().optional(),
  arguments: z.string().optional(),
  attachUrl: z.string().optional(),
  command: z.string().optional(),
  continue: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  model: z.string().optional(),
  port: z.number().int().optional(),
  prompt: z.string().optional(),
  runFormat: z.string().optional(),
  session: z.string().optional(),
  share: z.boolean().optional(),
  timeoutSeconds: z.number().int().optional(),
  title: z.string().optional(),
  variant: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2ScheduledJobRun" });

export const scheduledJobSchema = z.object({
  attachUrl: z.string().optional(),
  createdAt: isoTimestampSchema,
  invocation: z.object({ args: z.array(z.string()), command: z.string() }).optional(),
  lastRunAt: isoTimestampSchema.optional(),
  lastRunError: z.string().optional(),
  lastRunExitCode: z.number().int().optional(),
  lastRunSource: z.string().optional(),
  lastRunStatus: z.string().optional(),
  name: z.string(),
  prompt: z.string().optional(),
  run: scheduledJobRunSchema.optional(),
  schedule: z.string(),
  scopeId: z.string().optional(),
  slug: z.string(),
  source: z.string().optional(),
  timeoutSeconds: z.number().int().optional(),
  updatedAt: isoTimestampSchema.optional(),
  workdir: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2ScheduledJob" });

export const scheduledJobListResponseSchema = successResponseSchema(
  "OpenWorkServerV2ScheduledJobListResponse",
  z.object({ items: z.array(scheduledJobSchema) }),
);

export const scheduledJobDeleteResponseSchema = successResponseSchema(
  "OpenWorkServerV2ScheduledJobDeleteResponse",
  z.object({ job: scheduledJobSchema }),
);

export const workspaceSkillItemSchema = z.object({
  description: z.string(),
  name: z.string(),
  path: z.string(),
  scope: z.enum(["global", "project"]),
  trigger: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2WorkspaceSkillItem" });
export const workspaceSkillContentSchema = z.object({
  content: z.string(),
  item: workspaceSkillItemSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceSkillContent" });
export const workspaceSkillListResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceSkillListResponse",
  z.object({ items: z.array(workspaceSkillItemSchema) }),
);
export const workspaceSkillResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceSkillResponse", workspaceSkillContentSchema);
export const workspaceSkillWriteSchema = z.object({
  content: z.string(),
  description: z.string().optional(),
  name: z.string(),
  trigger: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2WorkspaceSkillWrite" });
export const workspaceSkillDeleteResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceSkillDeleteResponse",
  z.object({ path: z.string() }),
);

export const hubRepoSchema = z.object({
  owner: z.string().optional(),
  ref: z.string().optional(),
  repo: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2HubRepo" });
export const hubSkillItemSchema = z.object({
  description: z.string(),
  name: z.string(),
  source: z.object({ owner: z.string(), path: z.string(), ref: z.string(), repo: z.string() }),
  trigger: z.string().optional(),
}).meta({ ref: "OpenWorkServerV2HubSkillItem" });
export const hubSkillListResponseSchema = successResponseSchema(
  "OpenWorkServerV2HubSkillListResponse",
  z.object({ items: z.array(hubSkillItemSchema) }),
);
export const hubSkillInstallWriteSchema = z.object({
  overwrite: z.boolean().optional(),
  repo: hubRepoSchema.optional(),
}).meta({ ref: "OpenWorkServerV2HubSkillInstallWrite" });
export const hubSkillInstallResponseSchema = successResponseSchema(
  "OpenWorkServerV2HubSkillInstallResponse",
  z.object({
    action: z.enum(["added", "updated"]),
    name: z.string(),
    path: z.string(),
    skipped: z.number().int().nonnegative(),
    written: z.number().int().nonnegative(),
  }),
);

export const cloudSigninSchema = z.object({
  auth: jsonObjectSchema.nullable(),
  cloudBaseUrl: z.string(),
  createdAt: isoTimestampSchema,
  id: identifierSchema,
  lastValidatedAt: isoTimestampSchema.nullable(),
  metadata: jsonObjectSchema.nullable(),
  orgId: z.string().nullable(),
  serverId: identifierSchema,
  updatedAt: isoTimestampSchema,
  userId: z.string().nullable(),
}).meta({ ref: "OpenWorkServerV2CloudSignin" });
export const cloudSigninWriteSchema = z.object({
  auth: jsonObjectSchema.nullable().optional(),
  cloudBaseUrl: z.string(),
  metadata: jsonObjectSchema.nullable().optional(),
  orgId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
}).meta({ ref: "OpenWorkServerV2CloudSigninWrite" });
export const cloudSigninResponseSchema = successResponseSchema("OpenWorkServerV2CloudSigninResponse", cloudSigninSchema.nullable());
export const cloudSigninValidationResponseSchema = successResponseSchema(
  "OpenWorkServerV2CloudSigninValidationResponse",
  z.object({ lastValidatedAt: isoTimestampSchema.nullable(), ok: z.boolean(), record: cloudSigninSchema }),
);

export const workspaceShareSchema = z.object({
  accessKey: z.string().nullable(),
  audit: jsonObjectSchema.nullable(),
  createdAt: isoTimestampSchema,
  id: identifierSchema,
  lastUsedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
  status: z.enum(["active", "disabled", "revoked"]),
  updatedAt: isoTimestampSchema,
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceShare" });
export const workspaceShareResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceShareResponse", workspaceShareSchema.nullable());

export const workspaceExportWarningSchema = z.object({
  detail: z.string(),
  id: z.string(),
  label: z.string(),
}).meta({ ref: "OpenWorkServerV2WorkspaceExportWarning" });
export const workspaceExportDataSchema = z.object({
  commands: z.array(z.object({ description: z.string().optional(), name: z.string(), template: z.string() })),
  exportedAt: z.number().int().nonnegative(),
  files: z.array(z.object({ content: z.string(), path: z.string() })).optional(),
  openwork: jsonObjectSchema,
  opencode: jsonObjectSchema,
  skills: z.array(z.object({ content: z.string(), description: z.string().optional(), name: z.string(), trigger: z.string().optional() })),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceExportData" });
export const workspaceExportResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceExportResponse", workspaceExportDataSchema);
export const workspaceImportWriteSchema = z.record(z.string(), z.unknown()).meta({ ref: "OpenWorkServerV2WorkspaceImportWrite" });
export const workspaceImportResponseSchema = successResponseSchema("OpenWorkServerV2WorkspaceImportResponse", z.object({ ok: z.boolean() }));

export const sharedBundlePublishWriteSchema = z.object({
  bundleType: z.string(),
  name: z.string().optional(),
  payload: z.unknown(),
  timeoutMs: z.number().int().positive().optional(),
}).meta({ ref: "OpenWorkServerV2SharedBundlePublishWrite" });
export const sharedBundleFetchWriteSchema = z.object({
  bundleUrl: z.string(),
  timeoutMs: z.number().int().positive().optional(),
}).meta({ ref: "OpenWorkServerV2SharedBundleFetchWrite" });
export const sharedBundlePublishResponseSchema = successResponseSchema(
  "OpenWorkServerV2SharedBundlePublishResponse",
  z.object({ url: z.string() }),
);
export const sharedBundleFetchResponseSchema = successResponseSchema(
  "OpenWorkServerV2SharedBundleFetchResponse",
  z.record(z.string(), z.unknown()),
);

export const routerIdentityItemSchema = z.object({
  access: z.enum(["private", "public"]).optional(),
  enabled: z.boolean(),
  id: z.string(),
  pairingRequired: z.boolean().optional(),
  running: z.boolean(),
}).meta({ ref: "OpenWorkServerV2RouterIdentityItem" });
export const routerHealthSnapshotSchema = z.object({
  config: z.object({ groupsEnabled: z.boolean() }),
  channels: z.object({ slack: z.boolean(), telegram: z.boolean(), whatsapp: z.boolean() }),
  ok: z.boolean(),
  opencode: z.object({ healthy: z.boolean(), url: z.string(), version: z.string().optional() }),
}).meta({ ref: "OpenWorkServerV2RouterHealthSnapshot" });
export const routerIdentityListResponseSchema = successResponseSchema(
  "OpenWorkServerV2RouterIdentityListResponse",
  z.object({ items: z.array(routerIdentityItemSchema), ok: z.boolean() }),
);
export const routerTelegramInfoResponseSchema = successResponseSchema(
  "OpenWorkServerV2RouterTelegramInfoResponse",
  z.object({
    bot: z.object({ id: z.number().int(), name: z.string().optional(), username: z.string().optional() }).nullable(),
    configured: z.boolean(),
    enabled: z.boolean(),
    ok: z.boolean(),
  }),
);
export const routerHealthResponseSchemaCompat = successResponseSchema("OpenWorkServerV2RouterHealthCompatResponse", routerHealthSnapshotSchema);
export const routerTelegramWriteSchema = z.object({ access: z.enum(["private", "public"]).optional(), enabled: z.boolean().optional(), id: z.string().optional(), token: z.string() }).meta({ ref: "OpenWorkServerV2RouterTelegramWrite" });
export const routerSlackWriteSchema = z.object({ appToken: z.string(), botToken: z.string(), enabled: z.boolean().optional(), id: z.string().optional() }).meta({ ref: "OpenWorkServerV2RouterSlackWrite" });
export const routerBindingWriteSchema = z.object({ channel: z.enum(["slack", "telegram"]), directory: z.string().optional(), identityId: z.string().optional(), peerId: z.string() }).meta({ ref: "OpenWorkServerV2RouterBindingWrite" });
export const routerBindingListResponseSchema = successResponseSchema(
  "OpenWorkServerV2RouterBindingListResponse",
  z.object({
    items: z.array(z.object({ channel: z.string(), directory: z.string(), identityId: z.string(), peerId: z.string(), updatedAt: z.number().int().optional() })),
    ok: z.boolean(),
  }),
);
export const routerSendWriteSchema = z.object({ autoBind: z.boolean().optional(), channel: z.enum(["slack", "telegram"]), directory: z.string().optional(), identityId: z.string().optional(), peerId: z.string().optional(), text: z.string() }).meta({ ref: "OpenWorkServerV2RouterSendWrite" });
export const routerMutationResponseSchema = successResponseSchema(
  "OpenWorkServerV2RouterMutationResponse",
  z.record(z.string(), z.unknown()),
);

export const managedItemIdParamsSchema = z.object({ itemId: identifierSchema }).meta({ ref: "OpenWorkServerV2ManagedItemIdParams" });
export const workspaceNamedItemParamsSchema = workspaceIdParamsSchema.extend({ name: z.string() }).meta({ ref: "OpenWorkServerV2WorkspaceNamedItemParams" });
export const workspaceIdentityParamsSchema = workspaceIdParamsSchema.extend({ identityId: identifierSchema }).meta({ ref: "OpenWorkServerV2WorkspaceIdentityParams" });
