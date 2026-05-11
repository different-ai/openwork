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

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [];

export type ExtensionKind = "mcp" | "plugin" | "skill";

export type McpDirectoryInfo = {
  id?: string;
  name: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
  /** Extension category for UI grouping. Defaults to "mcp". */
  kind?: ExtensionKind;
  /** Simple Icons slug for brand icon (e.g. "notion", "stripe", "figma"). */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    get name() { return t("mcp.quick_connect_notion_title"); },
    get description() { return t("mcp.quick_connect_notion_desc"); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "notion",
  },
  {
    get name() { return t("mcp.quick_connect_linear_title"); },
    get description() { return t("mcp.quick_connect_linear_desc"); },
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "linear",
  },
  {
    get name() { return t("mcp.quick_connect_sentry_title"); },
    get description() { return t("mcp.quick_connect_sentry_desc"); },
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "sentry",
  },
  {
    get name() { return t("mcp.quick_connect_stripe_title"); },
    get description() { return t("mcp.quick_connect_stripe_desc"); },
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "stripe",
  },
  {
    get name() { return t("mcp.quick_connect_context7_title"); },
    get description() { return t("mcp.quick_connect_context7_desc"); },
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
    kind: "mcp",
    iconSlug: "semanticscholar",
  },
  {
    get name() { return t("mcp.quick_connect_openwork_cloud_title"); },
    get description() { return t("mcp.quick_connect_openwork_cloud_desc"); },
    command: ["npx", "-y", "openwork-ui-mcp"],
    type: "local",
    oauth: false,
    kind: "mcp",
    iconSrc: "/openwork-mark.svg",
  },
  {
    get name() { return t("mcp.quick_connect_openwork_ui_title"); },
    get description() { return t("mcp.quick_connect_openwork_ui_desc"); },
    command: ["npx", "-y", "openwork-ui-mcp"],
    type: "local",
    oauth: false,
    kind: "mcp",
    iconSrc: "/openwork-mark.svg",
  },
];
