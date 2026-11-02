/**
 * Predefined "quick add" External MCP Connections — the same real servers
 * (and URLs) the desktop app already offers as one-click Quick Connect
 * entries (apps/app/src/app/constants.ts MCP_QUICK_CONNECT), surfaced here
 * so an org admin can add them once, org-wide, in Den, instead of every
 * device connecting to them separately.
 */
import { mcpRegistrationStatusSchema, type McpRegistrationStatus } from "@openwork/types/den/mcp-registration"
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
  defaultOAuthClientId?: string
  authorizationServerIssuer?: string
  defaultOAuthScopes?: readonly string[]
  /** Extra scopes the provider offers that are requested only after an admin explicitly chooses them. */
  optionalOAuthScopes?: readonly string[]
  /** What OpenWork last learned about signing in to this provider; absent until it has been checked. */
  registrationStatus?: McpRegistrationStatus
  /** Response only: the redirect URL an admin registers in the provider's OAuth app. */
  oauthCallbackUrl?: string
}

export const externalMcpPresetResponseSchema = z.object({
  presetId: z.string(),
  displayName: z.string(),
  description: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  supportedAuthTypes: z.array(z.enum(["oauth", "apikey", "none"])).optional(),
  requiresOAuthClient: z.boolean().optional(),
  defaultOAuthClientId: z.string().min(1).optional(),
  authorizationServerIssuer: z.string().url().optional(),
  defaultOAuthScopes: z.array(z.string()).optional(),
  optionalOAuthScopes: z.array(z.string()).optional().describe("Extra scopes the provider offers. Never requested by default; setup requests them only after an admin explicitly chooses them."),
  registrationStatus: mcpRegistrationStatusSchema.optional(),
  oauthCallbackUrl: z.string().url().optional().describe("For presets that need a pre-registered OAuth app: the exact redirect URL to register in it. Absent when this deployment has no public API URL."),
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
    // The rest of the user scopes Slack's MCP server offers. Never requested by
    // default: guided Slack setup asks the admin to choose them explicitly
    // ("Read and act"), and that choice is saved as the connection's scopes.
    optionalOAuthScopes: [
      "canvases:read",
      "canvases:write",
      "channels:read",
      "channels:write",
      "emoji:read",
      "files:read",
      "files:write",
      "groups:read",
      "groups:write",
      "im:read",
      "im:write",
      "lists:read",
      "lists:write",
      "mpim:read",
      "mpim:write",
      "reactions:read",
      "reactions:write",
      "search:read.users",
      "users:read.email",
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
    description: "Deploy and manage services, databases, and logs. Sign in with your Render account.",
    url: "https://mcp.render.com/mcp",
    authType: "oauth",
    supportedAuthTypes: ["oauth", "apikey"],
    defaultOAuthClientId: "openwork",
    authorizationServerIssuer: "https://api.render.com",
  },
  {
    presetId: "context7",
    displayName: "Context7",
    description: "Up-to-date library documentation and code examples. Connect without an API key using Context7's rate-limited anonymous access.",
    url: "https://mcp.context7.com/mcp",
    authType: "none",
  },
]

/**
 * Additional reviewed official MCP server presets. Each URL and its OAuth
 * protected-resource metadata were verified by probing the public
 * `/.well-known/oauth-protected-resource` endpoint; advertisement is not a
 * successful connection. OAuth presets reuse the existing CIMD/DCR pipeline
 * (`packages/enterprise-mcp-client`); no new auth path is added.
 */
export const EXTERNAL_MCP_PRESETS_EXPANDED: readonly ExternalMcpPreset[] = [
  {
    presetId: "airtable",
    displayName: "Airtable",
    description: "Read and update Airtable bases, tables, and records. Sign in with your Airtable account.",
    url: "https://mcp.airtable.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "amplitude",
    displayName: "Amplitude",
    description: "Inspect Amplitude analytics, events, and product insights. Sign in with your Amplitude account.",
    url: "https://mcp.amplitude.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "cal",
    displayName: "Cal.com",
    description: "Manage Cal.com scheduling, event types, and bookings. Sign in with your Cal.com account.",
    url: "https://mcp.cal.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "canva",
    displayName: "Canva",
    description: "Search and create Canva designs, folders, and assets. Sign in with your Canva account.",
    url: "https://mcp.canva.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "figma",
    displayName: "Figma",
    description: "Read Figma files, designs, and dev mode details. Sign in with your Figma account.",
    url: "https://mcp.figma.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "fireflies",
    displayName: "Fireflies",
    description: "Search your Fireflies meeting notes and transcripts. Sign in with your Fireflies account.",
    url: "https://api.fireflies.ai/mcp",
    authType: "oauth",
  },
  {
    presetId: "huggingface",
    displayName: "Hugging Face",
    description: "Browse Hugging Face models, datasets, and Spaces. Sign in with your Hugging Face account.",
    url: "https://huggingface.co/mcp",
    authType: "oauth",
  },
  {
    presetId: "honeycomb",
    displayName: "Honeycomb",
    description: "Query Honeycomb traces, events, and SLOs. Sign in with your Honeycomb account.",
    url: "https://mcp.honeycomb.io/mcp",
    authType: "oauth",
  },
  {
    presetId: "klaviyo",
    displayName: "Klaviyo",
    description: "Inspect Klaviyo campaigns, flows, and contact data. Sign in with your Klaviyo account.",
    url: "https://mcp.klaviyo.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "lucid",
    displayName: "Lucid",
    description: "Open and update Lucidchart and Lucidspark documents. Sign in with your Lucid account.",
    url: "https://mcp.lucid.app/mcp",
    authType: "oauth",
  },
  {
    presetId: "monday",
    displayName: "monday.com",
    description: "Manage monday.com boards, items, and workspaces. Sign in with your monday.com account.",
    url: "https://mcp.monday.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "mural",
    displayName: "Mural",
    description: "Read and update Mural canvases, rooms, and workspaces. Sign in with your Mural account.",
    url: "https://mcp-canvas.mural.co/mcp",
    authType: "oauth",
  },
  {
    presetId: "posthog",
    displayName: "PostHog",
    description: "Inspect PostHog events, persons, and insights. Sign in with your PostHog account.",
    url: "https://mcp.posthog.com/mcp",
    authType: "oauth",
  },
  {
    presetId: "semgrep",
    displayName: "Semgrep",
    description: "Run Semgrep security scans and review findings. Sign in with your Semgrep account.",
    url: "https://mcp.semgrep.ai/mcp",
    authType: "oauth",
  },
  {
    presetId: "tavily",
    displayName: "Tavily",
    description: "Web search and research for agents. Uses your Tavily API key from app.tavily.com; provider rate limits and billing apply.",
    url: "https://mcp.tavily.com/mcp",
    authType: "apikey",
  },
  {
    presetId: "vercel",
    displayName: "Vercel",
    description: "Manage Vercel projects, deployments, and logs. Sign in with your Vercel account.",
    url: "https://mcp.vercel.com",
    authType: "oauth",
  },
]

/**
 * Every known preset (core + expanded), used by `external-mcp-auth-policy`
 * so every connection to an expanded-preset server keeps its preset auth behavior.
 */
export const ALL_EXTERNAL_MCP_PRESETS: readonly ExternalMcpPreset[] = [
  ...EXTERNAL_MCP_PRESETS,
  ...EXTERNAL_MCP_PRESETS_EXPANDED,
]

/**
 * One preset as the catalog returns it. Presets that need a pre-registered
 * OAuth app carry the redirect URL the admin registers in it, so setup can
 * show it (and prefill a provider app manifest) before any connection exists.
 */
export function externalMcpPresetForResponse(
  preset: ExternalMcpPreset,
  extra: { registrationStatus?: McpRegistrationStatus; oauthCallbackUrl?: string | null },
): ExternalMcpPreset {
  return {
    ...preset,
    ...(extra.registrationStatus && extra.registrationStatus !== "unknown" ? { registrationStatus: extra.registrationStatus } : {}),
    ...(preset.requiresOAuthClient && extra.oauthCallbackUrl ? { oauthCallbackUrl: extra.oauthCallbackUrl } : {}),
  }
}

/** Presets shown in the connector catalog and the add-connection preset list. */
export function externalMcpPresetsForCatalog(): ExternalMcpPreset[] {
  return [...ALL_EXTERNAL_MCP_PRESETS]
}
