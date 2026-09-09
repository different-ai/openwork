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
    description: "Read, send, and manage Gmail",
    icon: { simpleIconSlug: "gmail" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain how I can triage my Gmail inbox. If access is available, search and summarize unread threads and suggest reply priorities. Otherwise, help me plan a triage routine without accessing my inbox.",
  },
  {
    id: "github",
    displayName: "GitHub",
    description: "PRs, issues, code, and CI — OAuth app or personal access token",
    icon: { simpleIconSlug: "github", serviceUrl: "https://api.githubcopilot.com/mcp/" },
    target: { kind: "preset", presetId: "github" },
    chatPrompt: "Explain how I can review a GitHub repo's authentication. Ask which repo to use; if access is available, inspect its code and docs. Otherwise, outline a review checklist without accessing the repo.",
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    description: "Organize files, read Docs and Slides, and edit Sheets",
    icon: { simpleIconSlug: "googledrive" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain what changed in Google Drive this week. If access is available, list files modified in the last 7 days, follow pagination, and call out any incomplete search before summarizing the results. Otherwise, help me plan a file review without accessing Drive.",
  },
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    description: "Create, reschedule, and manage Google Calendar events",
    icon: { simpleIconSlug: "googlecalendar" },
    target: { kind: "google-workspace" },
    chatPrompt: "Explain how I can plan my week with Google Calendar. If access is available, list my meetings, point out conflicts, and suggest focus time without changing events. Otherwise, help me plan a weekly schedule without accessing my calendar.",
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Notion docs and workflows",
    icon: { serviceUrl: "https://mcp.notion.com/mcp" },
    target: { kind: "preset", presetId: "notion" },
    chatPrompt: "Explain how I can organize a Notion workspace. If access is available, ask which pages to review and summarize their structure. Otherwise, suggest a workspace outline without accessing Notion.",
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "Messages and search — requires an internal or Marketplace-published Slack app",
    icon: { simpleIconSlug: "slack", serviceUrl: "https://mcp.slack.com/mcp" },
    target: { kind: "preset", presetId: "slack" },
    chatPrompt: "Explain how I can catch up on Slack. If access is available, ask which channels or topics to search and summarize the messages found. Otherwise, help me plan a catch-up routine without accessing Slack.",
  },
];

export const MORE_CONNECTORS_TEASER = "See Outlook Email, Granola, and more";

/** Starter prompt for connectors without a curated one. */
export function connectorChatPrompt(displayName: string): string {
  const popular = POPULAR_CONNECTORS.find((connector) => connector.displayName === displayName);
  return popular?.chatPrompt
    ?? `Explain how I could use ${displayName}: suggest three useful tasks and distinguish general ideas from tools available here. If access is unavailable, help me plan without connecting.`;
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
