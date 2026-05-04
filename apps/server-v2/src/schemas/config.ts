import { z } from "zod";
import { identifierSchema, successResponseSchema, workspaceIdParamsSchema } from "./common.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const workspaceConfigSnapshotSchema = z.object({
  effective: z.object({
    opencode: jsonRecordSchema,
    openwork: jsonRecordSchema,
  }),
  materialized: z.object({
    compatibilityOpencodePath: z.string().nullable(),
    compatibilityOpenworkPath: z.string().nullable(),
    configDir: z.string().nullable(),
    configOpencodePath: z.string().nullable(),
    configOpenworkPath: z.string().nullable(),
  }),
  stored: z.object({
    opencode: jsonRecordSchema,
    openwork: jsonRecordSchema,
  }),
  updatedAt: z.string(),
  workspaceId: identifierSchema,
}).meta({ ref: "OpenWorkServerV2WorkspaceConfigSnapshot" });

export const workspaceConfigPatchRequestSchema = z.object({
  opencode: jsonRecordSchema.optional(),
  openwork: jsonRecordSchema.optional(),
}).meta({ ref: "OpenWorkServerV2WorkspaceConfigPatchRequest" });

export const rawOpencodeConfigQuerySchema = z.object({
  scope: z.enum(["global", "project"]).optional(),
}).meta({ ref: "OpenWorkServerV2RawOpencodeConfigQuery" });

export const rawOpencodeConfigWriteRequestSchema = z.object({
  content: z.string(),
  scope: z.enum(["global", "project"]).optional(),
}).meta({ ref: "OpenWorkServerV2RawOpencodeConfigWriteRequest" });

export const rawOpencodeConfigDataSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
  path: z.string().nullable(),
  updatedAt: z.string(),
}).meta({ ref: "OpenWorkServerV2RawOpencodeConfigData" });

export const workspaceConfigResponseSchema = successResponseSchema(
  "OpenWorkServerV2WorkspaceConfigResponse",
  workspaceConfigSnapshotSchema,
);

export const rawOpencodeConfigResponseSchema = successResponseSchema(
  "OpenWorkServerV2RawOpencodeConfigResponse",
  rawOpencodeConfigDataSchema,
);

export const rawOpencodeConfigParamsSchema = workspaceIdParamsSchema.meta({ ref: "OpenWorkServerV2RawOpencodeConfigParams" });
