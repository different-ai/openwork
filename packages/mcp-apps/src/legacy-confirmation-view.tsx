import { z } from "zod"
import { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"
import { pluginFlowPayloadSchema } from "@openwork/types/plugin-flow-app"

export const legacyConfirmationSchema = z.union([skillCreatedPayloadSchema, pluginFlowPayloadSchema])

export function LegacyConfirmationView({ payload }: { payload: z.infer<typeof legacyConfirmationSchema> }) {
  if ("skillId" in payload) {
    return <p className="confirmation" role="status">{`Skill ${payload.mode === "updated" ? "updated" : "created"}: ${payload.name}\n${payload.description}`}</p>
  }
  const labels = {
    marketplace_plugin_added: "Plugin added to marketplace",
    plugin_access_granted: "Plugin access granted",
    marketplace_access_granted: "Marketplace access granted",
  }
  const lines = [
    labels[payload.mode],
    payload.pluginId ? `Plugin: ${payload.pluginId}` : null,
    payload.marketplaceId ? `Marketplace: ${payload.marketplaceId}` : null,
    payload.recipient ? `Recipient: ${payload.recipient.kind}${payload.recipient.id ? ` ${payload.recipient.id}` : ""}` : null,
    payload.recipient?.role ? `Role: ${payload.recipient.role}` : null,
  ]
  return <p className="confirmation" role="status">{lines.filter(line => line !== null).join("\n")}</p>
}
