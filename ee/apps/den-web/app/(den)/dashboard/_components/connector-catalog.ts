import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";

/** Native provider connections keep fixed ids in Den. */
export const GOOGLE_WORKSPACE_QUICK_ADD_ID = "google-workspace";
export const MICROSOFT_365_QUICK_ADD_ID = "microsoft-365";

/**
 * Where a popular connector row lands when someone adds it. Gmail, Drive, and
 * Calendar are one Google Workspace connection in Den; Outlook is Microsoft
 * 365; everything else is a curated MCP preset.
 */
export type PopularConnectorTarget =
  | { kind: "google-workspace" }
  | { kind: "microsoft-365" }
  | { kind: "preset"; presetId: string };

export type PopularConnector = {
  id: string;
  displayName: string;
  description: string;
  icon: { iconUrl?: string; simpleIconSlug?: string; serviceUrl?: string };
  target: PopularConnectorTarget;
  /** Starter prompt seeded after the connector chip when someone picks Chat. */
  chatPrompt: string;
};

export const POPULAR_CONNECTORS: PopularConnector[] = [
  {
    id: "gmail",
    displayName: "Gmail",
    description: "Read and manage Gmail",
    icon: { simpleIconSlug: "gmail" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain what's waiting in my inbox: summarize the unread threads, group them by topic, and flag anything that needs a reply today.",
  },
  {
    id: "github",
    displayName: "GitHub",
    description: "Triage PRs, issues, CI, and publish flows",
    icon: { simpleIconSlug: "github", serviceUrl: "https://api.githubcopilot.com/mcp/" },
    target: { kind: "preset", presetId: "github" },
    chatPrompt: "Explain this repo's authentication using code and docs: components, request flow, and how credentials and tokens are handled",
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    description: "Drive, Docs, Sheets or Slides",
    icon: { simpleIconSlug: "googledrive" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain what changed in my Drive this week: find the documents edited in the last 7 days and summarize what each one is about.",
  },
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    description: "Manage Google Calendar events",
    icon: { simpleIconSlug: "googlecalendar" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain my week ahead: list my meetings, point out conflicts, and suggest where I can block focus time.",
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Notion docs and workflows",
    icon: { serviceUrl: "https://mcp.notion.com/mcp" },
    target: { kind: "preset", presetId: "notion" },
    chatPrompt: "Explain how our Notion workspace is organized: map the top-level pages and databases and what each one is for.",
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "Read and manage Slack",
    icon: { simpleIconSlug: "slack", serviceUrl: "https://mcp.slack.com/mcp" },
    target: { kind: "preset", presetId: "slack" },
    chatPrompt: "Explain what I missed in Slack: summarize the busiest channels since yesterday and call out anything directed at me.",
  },
];

export const MORE_CONNECTORS_TEASER = "See Outlook Email, Granola, and more";

/** Starter prompt for connectors without a curated one. */
export function connectorChatPrompt(displayName: string): string {
  const popular = POPULAR_CONNECTORS.find((connector) => connector.displayName === displayName);
  return popular?.chatPrompt
    ?? `Explain what you can do with ${displayName}: list the tools it exposes and suggest three useful tasks to start with.`;
}

/**
 * Deep link that opens the desktop app on a new chat with the connector chip
 * and starter prompt already in the composer. The app parses this in
 * apps/app/src/app/lib/openwork-links.ts (parseChatDeepLink).
 */
export function connectorChatDeepLink(input: { connector: string; prompt: string }): string {
  const params = new URLSearchParams({ connector: input.connector, prompt: input.prompt });
  return `openwork://chat?${params.toString()}`;
}

function comparableMcpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

export function connectionForPresetUrl(
  connections: readonly ExternalMcpConnection[],
  presetUrl: string,
): ExternalMcpConnection | undefined {
  const target = comparableMcpUrl(presetUrl);
  if (!target) return undefined;
  return connections.find((connection) => comparableMcpUrl(connection.url) === target);
}

/** The configured connection a popular row represents, when one exists. */
export function configuredConnectionForPopular(
  connector: PopularConnector,
  connections: readonly ExternalMcpConnection[],
  presets: readonly ExternalMcpPreset[],
): ExternalMcpConnection | undefined {
  switch (connector.target.kind) {
    case "google-workspace":
      return connections.find((connection) => connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID || connection.nativeProviderKey === "google-workspace");
    case "microsoft-365":
      return connections.find((connection) => connection.id === MICROSOFT_365_QUICK_ADD_ID || connection.nativeProviderKey === "microsoft-365");
    case "preset": {
      const presetId = connector.target.presetId;
      const preset = presets.find((entry) => entry.presetId === presetId);
      return preset ? connectionForPresetUrl(connections, preset.url) : undefined;
    }
  }
}

/** Curated presets that are not already represented by a popular row. */
export function remainingPresets(presets: readonly ExternalMcpPreset[]): ExternalMcpPreset[] {
  const popularPresetIds = new Set(
    POPULAR_CONNECTORS.flatMap((connector) => connector.target.kind === "preset" ? [connector.target.presetId] : []),
  );
  return presets.filter((preset) => !popularPresetIds.has(preset.presetId));
}

export function connectorMatchesFilter(filter: string, ...haystack: string[]): boolean {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return true;
  return haystack.some((value) => value.toLowerCase().includes(normalized));
}
