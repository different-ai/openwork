import { automationsLink, yourConnectionsLink } from "../agent-links.js"
import { env } from "../env.js"
import { organizationFeatureEnabled } from "../features.js"
import { appLogger } from "../observability/logger.js"
import type { SlackComposeOptions } from "./rich-message.js"

export function slackRichEnabled(organizationId: string, userId?: string | null) {
  return organizationFeatureEnabled(organizationId, "slackRichMessages", userId ? { userId } : {})
}

function ownHosts() {
  return [env.betterAuthUrl, env.webUrl, env.apiPublicUrl].flatMap((value) => {
    if (!value) return []
    try {
      return [new URL(value).host]
    } catch {
      return []
    }
  })
}

export function openworkImageUrl(value: string, hosts: readonly string[] = ownHosts()): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && hosts.includes(url.host) ? url.toString() : null
  } catch {
    return null
  }
}

export function slackComposeDefaults(): Pick<SlackComposeOptions, "places" | "imageUrl"> {
  return {
    places: { automations: automationsLink(), connections: yourConnectionsLink() },
    imageUrl: (url) => openworkImageUrl(url),
  }
}

export function logSlackBlocksRejected(surface: string, code: string) {
  appLogger.warn("slack_rich_message_rejected", { surface, code })
}
