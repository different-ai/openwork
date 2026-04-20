import { z } from "zod";
import { identifierSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const fileSessionIdParamsSchema = workspaceIdParamsSchema.extend({
  fileSessionId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2FileSessionIdParams" });

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const workspaceActivationDataSchema = z.object({
  activeWorkspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceActivationData" });

export const engineReloadDataSchema = z.object({
  reloadedAt: z.number().int().nonnegative(),
}).meta({ ref: "OpenWorkServerV2EngineReloadData" });

export const workspaceDeleteDataSchema = z.object({
  deleted: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceDeleteData" });

export const workspaceDisposeDataSchema = z.object({
  disposed: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceDisposeData" });

export const workspaceCreateLocalRequestSchema = z.object({
  folderPath: z.string().min(1),
  name: z.string().min(1),
  preset: z.string().min(1).optional(),
}).meta({ ref: "OpenWorkServerV2WorkspaceCreateLocalRequest" });

export const reloadEventSchema = z.object({
  id: identifierSchema,
  reason: z.enum(["agents", "commands", "config", "mcp", "plugins", "skills"]),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  trigger: z.object({
    action: z.enum(["added", "removed", "updated"]).optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    type: z.enum(["agent", "command", "config", "mcp", "plugin", "skill"]),
  }).optional(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2ReloadEvent" });

export const reloadEventsDataSchema = z.object({
  cursor: z.number().int().nonnegative(),
  items: z.array(reloadEventSchema),
}).meta({ ref: "OpenWorkServerV2ReloadEventsData" });

export const fileSessionCreateRequestSchema = z.object({
  ttlSeconds: z.number().positive().optional(),
  write: z.boolean().optional(),
}).meta({ ref: "OpenWorkServerV2FileSessionCreateRequest" });

export const fileSessionDataSchema = z.object({
  canWrite: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  id: identifierSchema,
  ttlMs: z.number().int().nonnegative(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2FileSessionData" });

export const fileCatalogSnapshotSchema = z.object({
  cursor: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  items: z.array(z.object({
    kind: z.enum(["dir", "file"]),
    mtimeMs: z.number(),
    path: z.string(),
    revision: z.string(),
    size: z.number().int().nonnegative(),
  })),
  nextAfter: z.string().optional(),
  sessionId: identifierSchema,
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2FileCatalogSnapshot" });

export const fileBatchReadRequestSchema = z.object({
  paths: z.array(z.string()).min(1),
}).meta({ ref: "OpenWorkServerV2FileBatchReadRequest" });

export const fileBatchReadResponseSchema = successResponseSchema(
  "OpenWorkServerV2FileBatchReadResponse",
  z.object({ items: z.array(jsonRecordSchema) }),
);

export const fileBatchWriteRequestSchema = z.object({
  writes: z.array(jsonRecordSchema).min(1),
}).meta({ ref: "OpenWorkServerV2FileBatchWriteRequest" });

export const fileOperationsRequestSchema = z.object({
  operations: z.array(jsonRecordSchema).min(1),
}).meta({ ref: "OpenWorkServerV2FileOperationsRequest" });

export const fileMutationResultSchema = successResponseSchema(
  "OpenWorkServerV2FileMutationResult",
  z.object({
    cursor: z.number().int().nonnegative(),
    items: z.array(jsonRecordSchema),
  }),
);

export const simpleContentQuerySchema = z.object({
  path: z.string().min(1),
}).meta({ ref: "OpenWorkServerV2SimpleContentQuery" });

export const simpleContentWriteRequestSchema = z.object({
  baseUpdatedAt: z.number().nullable().optional(),
  content: z.string(),
  force: z.boolean().optional(),
  path: z.string().min(1),
}).meta({ ref: "OpenWorkServerV2SimpleContentWriteRequest" });

export const simpleContentDataSchema = z.object({
  bytes: z.number().int().nonnegative(),
  content: z.string(),
  path: z.string(),
  revision: z.string().optional(),
  updatedAt: z.number(),
}).meta({ ref: "OpenWorkServerV2SimpleContentData" });

export const binaryItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).meta({ ref: "OpenWorkServerV2BinaryItem" });

export const binaryListResponseSchema = successResponseSchema(
  "OpenWorkServerV2BinaryListResponse",
  z.object({ items: z.array(binaryItemSchema) }),
);

export const binaryUploadDataSchema = z.object({
  bytes: z.number().int().nonnegative(),
  path: z.string(),
}).meta({ ref: "OpenWorkServerV2BinaryUploadData" });

export const workspaceActivationResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceActivationResponse",
  workspaceActivationDataSchema,
);

export const engineReloadResponseSchema = successResponseSchema(
  "OpenWorkServerV2EngineReloadResponse",
  engineReloadDataSchema,
);

export const workspaceDeleteResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceDeleteResponse",
  workspaceDeleteDataSchema,
);

export const workspaceDisposeResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceDisposeResponse",
  workspaceDisposeDataSchema,
);

export const reloadEventsResponseSchema = successResponseSchema(
  "OpenWorkServerV2ReloadEventsResponse",
  reloadEventsDataSchema,
);

export const fileSessionResponseSchema = successResponseSchema(
  "OpenWorkServerV2FileSessionResponse",
  fileSessionDataSchema,
);

export const fileCatalogSnapshotResponseSchema = successResponseSchema(
  "OpenWorkServerV2FileCatalogSnapshotResponse",
  fileCatalogSnapshotSchema,
);

export const simpleContentResponseSchema = successResponseSchema(
  "OpenWorkServerV2SimpleContentResponse",
  simpleContentDataSchema,
);

export const binaryUploadResponseSchema = successResponseSchema(
  "OpenWorkServerV2BinaryUploadResponse",
  binaryUploadDataSchema,
);

export { fileSessionIdParamsSchema };
