import type { ModelRef, SuggestedPlugin } from "./types";
import { t } from "../i18n";

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
    get description() { return t("plugins.scheduler_desc"); },
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
    get name() { return t("mcp.quick_connect_notion_title"); },
    get description() { return t("mcp.quick_connect_notion_desc"); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return t("mcp.quick_connect_linear_title"); },
    get description() { return t("mcp.quick_connect_linear_desc"); },
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return t("mcp.quick_connect_sentry_title"); },
    get description() { return t("mcp.quick_connect_sentry_desc"); },
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return t("mcp.quick_connect_stripe_title"); },
    get description() { return t("mcp.quick_connect_stripe_desc"); },
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
  },
  {
    get name() { return t("mcp.quick_connect_context7_title"); },
    get description() { return t("mcp.quick_connect_context7_desc"); },
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
  },
  {
    id: CHROME_DEVTOOLS_MCP_ID,
    get name() { return t("mcp.quick_connect_chrome_title"); },
    get description() { return t("mcp.quick_connect_chrome_desc"); },
    type: "local",
    command: [...CHROME_DEVTOOLS_MCP_COMMAND],
    oauth: false,
  },
];
