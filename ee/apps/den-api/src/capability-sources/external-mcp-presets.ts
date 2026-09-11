/**
 * Predefined "quick add" External MCP Connections — the same real servers
 * (and URLs) the desktop app already offers as one-click Quick Connect
 * entries (apps/app/src/app/constants.ts MCP_QUICK_CONNECT), surfaced here
 * so an org admin can add them once, org-wide, in Den, instead of every
 * device connecting to them separately.
 */
import { z } from "zod"

export type ExternalMcpPreset = {
  presetId: string
  displayName: string
  description: string
  url: string
  // Setup default, not an exclusive requirement when supportedAuthTypes lists alternatives.
  authType: "oauth" | "apikey" | "none"
  supportedAuthTypes?: readonly ("oauth" | "apikey" | "none")[]
  requiresOAuthClient?: boolean
  authorizationServerIssuer?: string
  defaultOAuthScopes?: readonly string[]
}

export const externalMcpPresetResponseSchema = z.object({
  presetId: z.string(),
  displayName: z.string(),
  description: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  supportedAuthTypes: z.array(z.enum(["oauth", "apikey", "none"])).optional(),
  requiresOAuthClient: z.boolean().optional(),
  authorizationServerIssuer: z.string().url().optional(),
  defaultOAuthScopes: z.array(z.string()).optional(),
}).meta({ ref: "ExternalMcpPresetResponse" })

export const externalMcpPresetListResponseSchema = z.object({
  presets: z.array(externalMcpPresetResponseSchema),
}).meta({ ref: "ExternalMcpPresetListResponse" })

export const EXTERNAL_MCP_PRESETS: ExternalMcpPreset[] = [
  {
    presetId: "github",
    displayName: "GitHub",
    description: "PRs, issues, code, and CI. Use a registered GitHub OAuth app for individual accounts, or a personal access token for a shared connection. Automatic app registration is not supported.",
    url: "https://api.githubcopilot.com/mcp/",
    authType: "oauth",
    supportedAuthTypes: ["oauth", "apikey"],
    requiresOAuthClient: true,
  },
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
    presetId: "granola",
    displayName: "Granola",
    description: "Search your meeting notes and transcripts.",
    url: "https://mcp.granola.ai/mcp",
    authType: "oauth",
  },
  {
    presetId: "polar",
    displayName: "Polar",
    description: "Products, subscriptions, orders, and customer billing.",
    url: "https://mcp.polar.sh/mcp/polar-mcp",
    authType: "oauth",
  },
  {
    presetId: "slack",
    displayName: "Slack",
    description: "Channels, DMs, and search. Requires an eligible internal or Slack Marketplace-published app; not every Slack app can use MCP. An admin configures its OAuth client once, then each person connects their own account. Automatic app registration is not supported.",
    url: "https://mcp.slack.com/mcp",
    authType: "oauth",
    requiresOAuthClient: true,
    authorizationServerIssuer: "https://mcp.slack.com",
    defaultOAuthScopes: [
      "search:read.public",
      "search:read.private",
      "search:read.im",
      "search:read.mpim",
      "search:read.files",
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "users:read",
    ],
  },
  {
    presetId: "exa",
    displayName: "Exa",
    description: "Web search, code context, and research. This connection uses your org's Exa API key from dashboard.exa.ai; provider usage limits and billing apply.",
    url: "https://mcp.exa.ai/mcp",
    authType: "apikey",
  },
  {
    presetId: "render",
    displayName: "Render",
    description: "Deploy and manage services, databases, and logs. Paste your org's Render API key from dashboard.render.com.",
    url: "https://mcp.render.com/mcp",
    authType: "apikey",
  },
  {
    presetId: "context7",
    displayName: "Context7",
    description: "Up-to-date library documentation and code examples. Connect without an API key using Context7's rate-limited anonymous access.",
    url: "https://mcp.context7.com/mcp",
    authType: "none",
  },
]
