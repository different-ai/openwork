import { pluginFlowPayloadSchema, type PluginFlowPayload } from "@openwork/types/plugin-flow-app"
import { mountMcpApp } from "./shared/bridge"
import { AppHeader, CardBody, CardFooter, CheckIcon, KeyValueGrid, ShareIcon } from "./shared/ui"
import "./shared/theme.css"

const MODE_PRESENTATION: Record<PluginFlowPayload["mode"], {
  title: string
  subtitle: string
  footnote: string
}> = {
  marketplace_plugin_added: {
    title: "Plugin added to marketplace",
    subtitle: "The plugin is now listed for everyone with marketplace access.",
    footnote: "Members with access can install it from the marketplace.",
  },
  plugin_access_granted: {
    title: "Plugin shared",
    subtitle: "Access was granted successfully.",
    footnote: "The recipient can use this plugin's skills in chat immediately.",
  },
  marketplace_access_granted: {
    title: "Marketplace access granted",
    subtitle: "The member can now browse this marketplace.",
    footnote: "They can install plugins from it right away.",
  },
}

const RECIPIENT_LABEL: Record<NonNullable<PluginFlowPayload["recipient"]>["kind"], string> = {
  member: "Member",
  team: "Team",
  org_wide: "Entire organization",
}

mountMcpApp({
  name: "OpenWork Plugin Flow",
  waitingLabel: "Finishing up...",
  schema: pluginFlowPayloadSchema,
  render: (payload) => {
    const presentation = MODE_PRESENTATION[payload.mode]
    const items: Array<{ label: string; value: string; mono?: boolean }> = []
    if (payload.pluginId) items.push({ label: "Plugin", value: payload.pluginId, mono: true })
    if (payload.marketplaceId) items.push({ label: "Marketplace", value: payload.marketplaceId, mono: true })
    if (payload.recipient) {
      items.push({
        label: RECIPIENT_LABEL[payload.recipient.kind],
        value: payload.recipient.id ?? "org-wide",
        mono: payload.recipient.id !== null,
      })
      if (payload.recipient.role) items.push({ label: "Role", value: payload.recipient.role })
    }
    return (
      <main className="card">
        <AppHeader
          tone={payload.mode === "marketplace_plugin_added" ? "info" : "success"}
          icon={payload.mode === "marketplace_plugin_added" ? <ShareIcon /> : <CheckIcon />}
          title={presentation.title}
          subtitle={presentation.subtitle}
          badge={{ tone: "success", label: "Done" }}
        />
        <CardBody>
          <KeyValueGrid items={items} />
        </CardBody>
        <CardFooter footnote={presentation.footnote} />
      </main>
    )
  },
})
