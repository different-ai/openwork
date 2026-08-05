import type { ModelRef, SuggestedPlugin } from "./types";
import { t } from "../i18n";
import { getDenMcpUrl } from "./lib/den";
import {
  BUILT_IN_MICX_EXTENSION_MANIFESTS,
  extensionContribution,
  extensionResource,
  isTrustedBuiltInExtension,
  type MicxExtensionManifest,
  type MicxExtensionPlatform,
} from "./extensions";

export const MODEL_PREF_KEY = "micx.defaultModel";
export const SESSION_MODEL_PREF_KEY = "micx.sessionModels";
export const THINKING_PREF_KEY = "micx.showThinking";
export const VARIANT_PREF_KEY = "micx.modelVariant";
export { LANGUAGE_PREF_KEY } from "../i18n";
export const HIDE_TITLEBAR_PREF_KEY = "micx.hideTitlebar";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [];

export type ExtensionKind = "mcp" | "plugin" | "skill" | "ui-control" | "extension";

export type McpDirectoryInfo = {
  id?: string;
  /** Display name shown in the UI. */
  name: string;
  /** Safe server name for opencode.jsonc (alphanumeric, - and _ only). Auto-derived from name if omitted. */
  serverName?: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
  oauthConfig?: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  };
  /** Extension category for UI grouping. Defaults to "mcp". */
  kind?: ExtensionKind;
  /** Simple Icons slug for brand icon (e.g. "notion", "stripe", "figma"). */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
  /** Prompt inserted from the composer extension picker. */
  composerPrompt?: string;
  /** Whether Micx should show this extension as enabled before user setup. */
  defaultEnabled?: boolean;
  /** Whether Micx should hide this extension from the default catalog view. */
  defaultHidden?: boolean;
  /** Whether this extension is still in preview. */
  preview?: boolean;
  /** Normalized extension manifest backing this catalog entry. */
  extensionManifest?: MicxExtensionManifest;
};

function extensionManifestToDirectoryInfo(manifest: MicxExtensionManifest): McpDirectoryInfo {
  const mcpResource = extensionResource(manifest, "mcp");
  return {
    id: manifest.id,
    name: manifest.name,
    serverName: mcpResource?.mcpServerName ?? manifest.id,
    description: manifest.description,
    type: mcpResource?.command ? "local" : undefined,
    command: mcpResource?.command,
    oauth: false,
    kind: "extension",
    iconSlug: manifest.icon?.simpleIconSlug,
    iconSrc: manifest.icon?.src,
    composerPrompt: extensionContribution(manifest, "composer-prompt")?.prompt ?? manifest.composer?.prompt,
    defaultEnabled: manifest.defaultEnabled,
    defaultHidden: manifest.defaultHidden,
    preview: manifest.preview,
    extensionManifest: manifest,
  };
}

export function isBuiltInMicxExtension(entry: Pick<McpDirectoryInfo, "kind" | "extensionManifest">): boolean {
  return entry.kind === "extension" && isTrustedBuiltInExtension(entry.extensionManifest);
}

/** Derive a safe MCP server name from a display name or explicit serverName. */
export function getMcpServerName(entry: McpDirectoryInfo): string {
  if (entry.serverName) return entry.serverName;
  return entry.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "mcp";
}

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    get name() { return t("mcp.quick_connect_notion_title"); },
    serverName: "notion",
    get description() { return t("mcp.quick_connect_notion_desc"); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "notion",
    iconSrc: "/ext-notion.svg",
  },
  {
    get name() { return t("mcp.quick_connect_linear_title"); },
    serverName: "linear",
    get description() { return t("mcp.quick_connect_linear_desc"); },
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "linear",
    iconSrc: "/ext-linear.svg",
  },
  {
    get name() { return t("mcp.quick_connect_sentry_title"); },
    serverName: "sentry",
    get description() { return t("mcp.quick_connect_sentry_desc"); },
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "sentry",
    iconSrc: "/ext-sentry.svg",
  },
  {
    get name() { return t("mcp.quick_connect_stripe_title"); },
    serverName: "stripe",
    get description() { return t("mcp.quick_connect_stripe_desc"); },
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "stripe",
    iconSrc: "/ext-stripe.svg",
  },
  {
    get name() { return t("mcp.quick_connect_context7_title"); },
    serverName: "context7",
    get description() { return t("mcp.quick_connect_context7_desc"); },
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
    kind: "mcp",
    iconSlug: "semanticscholar",
    iconSrc: "/ext-context7.svg",
  },
  {
    get name() { return t("mcp.quick_connect_micx_cloud_title"); },
    serverName: "micx-cloud",
    get description() { return t("mcp.quick_connect_micx_cloud_desc"); },
    get url() {
      // The desktop app connects to the minimal, harness-facing surface
      // (/mcp/agent: search_capabilities + execute_capability only), not the
      // full catalog at bare /mcp. getDenMcpUrl heals stale web-app origins;
      // never at the web app's root (see
      // packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx).
      try {
        return `${getDenMcpUrl()}/agent`;
      } catch {
        return "https://app.micxlabs.com/api/den/mcp/agent";
      }
    },
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSrc: "/micx-mark.svg",
    // Auto-managed by the signed-in cloud reconciler (syncCloudControlMcp):
    // configured + enabled while signed in to Micx Cloud. Hidden from the
    // default catalog; "Show hidden" reveals it.
    defaultHidden: true,
  },
  {
    get name() { return t("mcp.quick_connect_micx_ui_title"); },
    serverName: "micx-ui",
    get description() { return t("mcp.quick_connect_micx_ui_desc"); },
    type: "local",
    // Dev builds replace this with the local checkout path before writing config.
    command: ["npx", "-y", "micx-ui-mcp"],
    oauth: false,
    kind: "ui-control",
    iconSrc: "/micx-mark.svg",
    // Internal UI-control surface for agents driving the desktop app. Hidden
    // from the default catalog; "Show hidden" reveals it.
    defaultHidden: true,
  },
  ...BUILT_IN_MICX_EXTENSION_MANIFESTS.map(extensionManifestToDirectoryInfo),
];

export const MICX_EXTENSION_CATALOG = MCP_QUICK_CONNECT.filter((entry) => entry.kind === "extension");

export function resolveMicxExtensionCatalogPlatform(
  platform: "web" | "desktop",
  os?: "macos" | "windows" | "linux",
): MicxExtensionPlatform {
  if (platform === "web") return "web";
  if (os === "macos") return "darwin";
  if (os === "windows") return "windows";
  return "linux";
}

export function filterMicxExtensionCatalogForPlatform<TEntry extends Pick<McpDirectoryInfo, "extensionManifest">>(
  entries: TEntry[],
  platform: MicxExtensionPlatform,
): TEntry[] {
  return entries.filter((entry) => {
    const platforms = entry.extensionManifest?.platform;
    return !platforms || platforms.includes(platform);
  });
}
