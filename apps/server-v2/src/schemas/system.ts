import { z } from "zod";
import { identifierSchema, isoTimestampSchema, successResponseSchema } from "./common.js";

export const routeNamespacesSchema = z.object({
  root: z.literal("/"),
  openapi: z.literal("/openapi.json"),
  system: z.literal("/system"),
  workspaces: z.literal("/workspaces"),
  workspaceResource: z.string().startsWith("/workspaces/"),
}).meta({ ref: "OpenWorkServerV2RouteNamespaces" });

export const contractMetadataSchema = z.object({
  source: z.literal("hono-openapi"),
  openapiPath: z.literal("/openapi.json"),
  sdkPackage: z.literal("@openwork/server-sdk"),
}).meta({ ref: "OpenWorkServerV2ContractMetadata" });

export const databaseStatusSchema = z.object({
  configured: z.literal(false),
  kind: z.literal("none"),
  phaseOwner: z.literal(2),
  status: z.literal("pending"),
  summary: z.string(),
}).meta({ ref: "OpenWorkServerV2DatabaseStatus" });

export const rootInfoDataSchema = z.object({
  service: z.literal("openwork-server-v2"),
  packageName: z.literal("openwork-server-v2"),
  version: z.string(),
  environment: z.string(),
  routes: routeNamespacesSchema,
  contract: contractMetadataSchema,
}).meta({ ref: "OpenWorkServerV2RootInfoData" });

export const healthDataSchema = z.object({
  service: z.literal("openwork-server-v2"),
  status: z.literal("ok"),
  startedAt: isoTimestampSchema,
  uptimeMs: z.number().int().nonnegative(),
  database: databaseStatusSchema,
}).meta({ ref: "OpenWorkServerV2HealthData" });

export const runtimeInfoSchema = z.object({
  environment: z.string(),
  hostname: z.string(),
  pid: z.number().int().nonnegative(),
  platform: z.string(),
  runtime: z.literal("bun"),
  runtimeVersion: z.string().nullable(),
}).meta({ ref: "OpenWorkServerV2RuntimeInfo" });

export const metadataDataSchema = z.object({
  foundation: z.object({
    phase: z.literal(1),
    middlewareOrder: z.array(identifierSchema).min(1),
    routeNamespaces: routeNamespacesSchema,
    database: databaseStatusSchema,
  }).meta({ ref: "OpenWorkServerV2FoundationInfo" }),
  requestContext: z.object({
    actorKind: z.literal("anonymous"),
    requestIdHeader: z.literal("X-Request-Id"),
  }).meta({ ref: "OpenWorkServerV2RequestContextInfo" }),
  runtime: runtimeInfoSchema,
  contract: contractMetadataSchema,
}).meta({ ref: "OpenWorkServerV2MetadataData" });

export const rootInfoResponseSchema = successResponseSchema("OpenWorkServerV2RootInfoResponse", rootInfoDataSchema);
export const healthResponseSchema = successResponseSchema("OpenWorkServerV2HealthResponse", healthDataSchema);
export const metadataResponseSchema = successResponseSchema("OpenWorkServerV2MetadataResponse", metadataDataSchema);

export const openApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }).passthrough(),
  paths: z.record(z.string(), z.unknown()),
  components: z.object({}).passthrough().optional(),
}).passthrough().meta({ ref: "OpenWorkServerV2OpenApiDocument" });
