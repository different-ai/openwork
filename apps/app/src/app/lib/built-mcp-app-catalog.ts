import { z } from "zod";
import {
  mcpAppIdSchema,
  parseMcpAppResourceUri,
} from "@openwork/types/mcp-app";

const entrySchema = z
  .object({
    connectionId: mcpAppIdSchema,
    serverName: z.string(),
    toolName: z.literal("open_app"),
    projectedToolName: z.string(),
    resourceUri: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    pluginId: z.string(),
    pluginName: z.string(),
    requiresApproval: z.boolean(),
  })
  .refine(
    (entry) =>
      parseMcpAppResourceUri(entry.resourceUri)?.appId === entry.connectionId,
  );

export const builtMcpAppCatalogSchema = z.object({
  apps: z.array(entrySchema),
});
export type BuiltMcpAppCatalogEntry = z.infer<typeof entrySchema>;
