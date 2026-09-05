import { z } from "zod"

const idSchema = z.string().trim().min(1).max(160)

export const pluginFlowAppSchemaVersion = "1" as const

/**
 * Data contract for the first-party plugin-flow MCP App: a confirmation card
 * for library sharing flows that previously ended as plain JSON text —
 * attaching a plugin to a marketplace, granting plugin access, and granting
 * marketplace access.
 */
export const pluginFlowPayloadSchema = z.object({
  schemaVersion: z.literal(pluginFlowAppSchemaVersion),
  mode: z.enum([
    "marketplace_plugin_added",
    "plugin_access_granted",
    "marketplace_access_granted",
  ]),
  pluginId: idSchema.nullable(),
  marketplaceId: idSchema.nullable(),
  recipient: z.object({
    kind: z.enum(["member", "team", "org_wide"]),
    id: idSchema.nullable(),
    role: z.string().trim().min(1).max(60).nullable(),
  }).nullable(),
})

export type PluginFlowPayload = z.infer<typeof pluginFlowPayloadSchema>
