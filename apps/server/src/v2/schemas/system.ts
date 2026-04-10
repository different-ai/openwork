import { z } from "zod";

export const v2HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("openwork-server-v2"),
}).meta({ ref: "OpenWorkServerV2HealthResponse" });

export const openApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }).passthrough(),
  paths: z.record(z.string(), z.unknown()),
  components: z.object({}).passthrough().optional(),
}).passthrough().meta({ ref: "OpenWorkServerV2OpenApiDocument" });
