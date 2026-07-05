/**
 * Predefined "quick add" External MCP Connections — the same real servers
 * (and URLs) the desktop app already offers as one-click Quick Connect
 * entries (apps/app/src/app/constants.ts MCP_QUICK_CONNECT), surfaced here
 * so an org admin can add them once, org-wide, in Den, instead of every
 * device connecting to them separately.
 */
export type ExternalMcpPreset = {
  presetId: string
  displayName: string
  description: string
  url: string
  authType: "oauth" | "apikey" | "none"
  requiresOAuthClient?: boolean
}

export const EXTERNAL_MCP_PRESETS: ExternalMcpPreset[] = [
  {
    presetId: "notion",
    displayName: "Notion",
    description: "Pages, databases, and project docs in sync.",
    url: "https://mcp.notion.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "linear",
    displayName: "Linear",
    description: "Plan sprints and ship tickets faster.",
    url: "https://mcp.linear.app/mcp",
    authType: "oauth",
  },
  {
    presetId: "stripe",
    displayName: "Stripe",
    description: "Inspect payments, invoices, and subscriptions.",
    url: "https://mcp.stripe.com",
    authType: "oauth",
  },
  {
    presetId: "sentry",
    displayName: "Sentry",
    description: "Track releases and resolve production errors.",
    url: "https://mcp.sentry.dev/mcp",
    authType: "oauth",
  },
  {
    presetId: "slack",
    displayName: "Slack",
    description: "Channels, DMs, and search. Slack has no automatic app registration — paste your Slack app's OAuth client once; each person then connects their own account.",
    url: "https://mcp.slack.com/mcp",
    authType: "oauth",
    requiresOAuthClient: true,
  },
  {
    presetId: "context7",
    displayName: "Context7",
    description: "Search product docs with richer context.",
    url: "https://mcp.context7.com/mcp",
    authType: "none",
  },
]
