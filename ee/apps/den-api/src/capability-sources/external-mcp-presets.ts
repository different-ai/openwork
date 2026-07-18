/**
 * [INPUT]: 依赖供应商公开的官方 MCP URL、认证方式与 OpenWork Desktop Quick Connect 目录
 * [OUTPUT]: 对外提供组织级 External MCP 一键连接预设和认证元数据
 * [POS]: capability-sources 的组织级已知远程 MCP 真相源，驱动智能添加与插件导入认证策略
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
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
    description: "Channels, DMs, and search. Slack has no automatic app registration — paste your Slack app's OAuth client once; each person then connects their own account.",
    url: "https://mcp.slack.com/mcp",
    authType: "oauth",
    requiresOAuthClient: true,
  },
  {
    presetId: "exa",
    displayName: "Exa",
    description: "AI web search, code search, and research for your agents. Paste your org's Exa API key from dashboard.exa.ai.",
    url: "https://mcp.exa.ai/mcp",
    authType: "apikey",
  },
  {
    presetId: "apollo",
    displayName: "Apollo",
    description: "Search and enrich prospects or manage GTM workflows through your Apollo account. Apollo plan, permissions, and credits apply.",
    url: "https://mcp.apollo.io/mcp",
    authType: "oauth",
  },
  {
    presetId: "fullenrich",
    displayName: "FullEnrich",
    description: "Search, enrich, and export waterfall-verified contacts. Paid actions consume your FullEnrich credits after confirmation.",
    url: "https://mcp.fullenrich.com/mcp",
    authType: "oauth",
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
    description: "Search product docs with richer context.",
    url: "https://mcp.context7.com/mcp",
    authType: "none",
  },
]
