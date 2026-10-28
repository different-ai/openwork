const SLACK_MCP_DISABLED = "App is not enabled for Slack MCP server access."
const SLACK_APPS_URL = "https://api.slack.com/apps"

/** Provider text is evidence only: never use it as member copy or an arbitrary link. */
export function slackMcpAccessGuidance(input: {
  phase: string
  httpStatus?: number
  outbound?: { origin: string }
  providerResponseExcerpt?: string
}): { message: string; settingsUrl: string } | undefined {
  if (
    input.phase !== "MCP_INITIALIZE"
    || input.httpStatus !== 400
    || input.outbound?.origin !== "https://mcp.slack.com"
  ) return undefined
  try {
    const body: unknown = JSON.parse(input.providerResponseExcerpt ?? "")
    if (
      typeof body !== "object" || body === null
      || !("error_code" in body) || body.error_code !== -32600
      || !("error_message" in body) || typeof body.error_message !== "string"
      || !body.error_message.startsWith(SLACK_MCP_DISABLED)
    ) return undefined
    const providerUrl = body.error_message.slice(SLACK_MCP_DISABLED.length).trim().replace(/^Please enable it here: /, "")
    return {
      message: "MCP access is disabled for this Slack app. Ask the person who manages the Slack app to enable Agents > MCP, then try connecting again.",
      settingsUrl: safeSlackMcpSettingsUrl(providerUrl) ?? SLACK_APPS_URL,
    }
  } catch {
    return undefined
  }
}

/** Exact HTTPS destinations only: no credentials, query strings, fragments or arbitrary provider URLs. */
export function safeSlackMcpSettingsUrl(value: string | undefined): string | undefined {
  return value === SLACK_APPS_URL || (value && value === value.trim() && /^https:\/\/api\.slack\.com\/apps\/A[A-Z0-9]{5,31}\/app-assistant$/.test(value))
    ? value
    : undefined
}
