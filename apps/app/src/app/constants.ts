import type { ModelRef, SuggestedPlugin } from "./types";
import { t, td } from "../i18n";

export const MODEL_PREF_KEY = "openwork.defaultModel";
export const SESSION_MODEL_PREF_KEY = "openwork.sessionModels";
export const THINKING_PREF_KEY = "openwork.showThinking";
export const VARIANT_PREF_KEY = "openwork.modelVariant";
export const LANGUAGE_PREF_KEY = "openwork.language";
export const HIDE_TITLEBAR_PREF_KEY = "openwork.hideTitlebar";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    get description() { return td("plugins.scheduler_desc", "Run scheduled jobs with the OpenCode scheduler plugin."); },
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
];

export type McpDirectoryInfo = {
  id?: string;
  name: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
};

export const CHROME_DEVTOOLS_MCP_ID = "chrome-devtools";
export const CHROME_DEVTOOLS_MCP_COMMAND = ["npx", "-y", "chrome-devtools-mcp@latest"] as const;

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    get name() { return td("mcp.quick_connect_notion_title", "Notion"); },
    get description() { return td("mcp.quick_connect_notion_desc", "Pages, databases, and project docs in sync."); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return td("mcp.quick_connect_linear_title", "Linear"); },
    get description() { return td("mcp.quick_connect_linear_desc", "Plan sprints and ship tickets faster."); },
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return td("mcp.quick_connect_sentry_title", "Sentry"); },
    get description() { return td("mcp.quick_connect_sentry_desc", "Track releases and resolve production errors."); },
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return td("mcp.quick_connect_stripe_title", "Stripe"); },
    get description() { return td("mcp.quick_connect_stripe_desc", "Inspect payments, invoices, and subscriptions."); },
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return td("mcp.quick_connect_context7_title", "Context7"); },
    get description() { return td("mcp.quick_connect_context7_desc", "Search product docs with richer context."); },
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
  },
  {
    id: CHROME_DEVTOOLS_MCP_ID,
    get name() { return td("mcp.quick_connect_chrome_title", "Control Chrome"); },
    get description() { return td("mcp.quick_connect_chrome_desc", "Drive Chrome tabs with browser automation."); },
    type: "local",
    command: [...CHROME_DEVTOOLS_MCP_COMMAND],
    oauth: false,
  },
];
