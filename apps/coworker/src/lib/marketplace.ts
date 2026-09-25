/**
 * The Marketplace: connectors coworkers can use and coworkers ready to add.
 * Connectors follow OpenWork's Library (Den): Gmail, Drive and Calendar are
 * one Google Workspace connection, Outlook is Microsoft 365, and the rest are
 * Den's curated MCP presets. The list and the matching below are ported from
 * den-web's connector catalog (`dashboard/_components/connector-catalog.ts`),
 * so a connection set up in OpenWork shows as the same row here. Pure; the
 * views only render what these return.
 */
import { FEATURED_COWORKERS, featuredIdOf, type FeaturedCoworker } from "./featured-coworkers.ts";

export type ConnectorTarget =
  | { kind: "google-workspace" }
  | { kind: "microsoft-365" }
  | { kind: "preset"; presetId: string }
  /** Built into every coworker; nothing to connect. */
  | { kind: "built-in" };

/** Used for search: "email" finds Gmail and Outlook. */
export type ConnectorCategory = "Email & calendar" | "Docs & notes" | "Chat" | "Engineering" | "Payments";

export type MarketplaceConnector = {
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory | "Built in";
  /** A logo under `public/connectors/`. */
  icon: string;
  target: ConnectorTarget;
  /** A first message to try it with, as in OpenWork's Library. */
  prompt: string;
};

export const CONNECTORS: readonly MarketplaceConnector[] = [
  { id: "gmail", name: "Gmail", description: "Search, read, draft and manage email.", category: "Email & calendar", icon: "gmail", target: { kind: "google-workspace" }, prompt: "Help me triage my Gmail inbox: search unread threads, summarize them and suggest reply priorities. Don't change anything." },
  { id: "google-calendar", name: "Google Calendar", description: "Search events and schedule meetings.", category: "Email & calendar", icon: "google-calendar", target: { kind: "google-workspace" }, prompt: "Help me plan my week: list my meetings, point out conflicts and suggest focus time without changing any events." },
  { id: "google-drive", name: "Google Drive", description: "Search, read, create and share files.", category: "Docs & notes", icon: "google-drive", target: { kind: "google-workspace" }, prompt: "What changed in my Google Drive this week? List files modified in the last seven days and summarize them." },
  { id: "granola", name: "Granola", description: "Meeting notes and transcripts.", category: "Docs & notes", icon: "granola", target: { kind: "preset", presetId: "granola" }, prompt: "Summarize my most recent meeting notes from Granola: decisions, owners and next steps." },
  { id: "slack", name: "Slack", description: "Search and catch up on messages.", category: "Chat", icon: "slack", target: { kind: "preset", presetId: "slack" }, prompt: "Help me catch up on Slack: ask which channels or topics matter and summarize what I missed." },
  { id: "notion", name: "Notion", description: "Docs, wikis and projects.", category: "Docs & notes", icon: "notion", target: { kind: "preset", presetId: "notion" }, prompt: "Help me organize my Notion workspace: ask which pages to review and summarize their structure." },
  { id: "github", name: "GitHub", description: "Pull requests, issues, code and CI.", category: "Engineering", icon: "github", target: { kind: "preset", presetId: "github" }, prompt: "Summarize what changed in my main GitHub repository this week: merged pull requests and open issues." },
  { id: "linear", name: "Linear", description: "Issues, projects and cycles.", category: "Engineering", icon: "linear", target: { kind: "preset", presetId: "linear" }, prompt: "Give me a status of my team's Linear issues this week: done, in progress and blocked." },
  { id: "outlook", name: "Outlook", description: "Microsoft 365 mail, calendar and files.", category: "Email & calendar", icon: "outlook", target: { kind: "microsoft-365" }, prompt: "Help me triage my Outlook inbox and plan my week, without changing anything." },
  { id: "sentry", name: "Sentry", description: "Errors and performance issues.", category: "Engineering", icon: "sentry", target: { kind: "preset", presetId: "sentry" }, prompt: "What are the most frequent new errors in Sentry this week?" },
  { id: "stripe", name: "Stripe", description: "Payments and customers.", category: "Payments", icon: "stripe", target: { kind: "preset", presetId: "stripe" }, prompt: "Summarize this week's Stripe activity: new customers, failed payments and refunds." },
];

/** Built in and always on: listed on a coworker's Integrations, never in the connector list. */
export const BUILT_IN_INTEGRATIONS: readonly MarketplaceConnector[] = [
  { id: "web", name: "Web search", description: "Searches the web and reads pages.", category: "Built in", icon: "", target: { kind: "built-in" }, prompt: "" },
];

export function connector(id: string): MarketplaceConnector | undefined {
  return CONNECTORS.find((entry) => entry.id === id) ?? BUILT_IN_INTEGRATIONS.find((entry) => entry.id === id);
}

/** A connection usable by the signed-in member, as Den lists it (`GET /v1/mcp-connections?scope=usable`). */
export type UsableConnection = {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  connectedForMe: boolean;
  nativeProviderKey?: string | null;
};

/** One of Den's curated MCP presets (`GET /v1/mcp-connections/presets`). */
export type ConnectionPreset = { presetId: string; displayName: string; url: string };

function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

/** The configured connection a connector row represents, when one exists (den-web's `configuredConnectionForPopular`). */
export function connectionFor(entry: MarketplaceConnector, connections: readonly UsableConnection[], presets: readonly ConnectionPreset[]): UsableConnection | undefined {
  switch (entry.target.kind) {
    case "google-workspace":
      return connections.find((connection) => connection.id === "google-workspace" || connection.nativeProviderKey === "google-workspace");
    case "microsoft-365":
      return connections.find((connection) => connection.id === "microsoft-365" || connection.nativeProviderKey === "microsoft-365");
    case "preset": {
      const presetId = entry.target.presetId;
      const preset = presets.find((candidate) => candidate.presetId === presetId);
      const target = preset ? comparableUrl(preset.url) : null;
      return target ? connections.find((connection) => comparableUrl(connection.url) === target) : undefined;
    }
    case "built-in":
      return undefined;
  }
}

/**
 * What a connector row offers. `connected`: ready for every coworker.
 * `connect`: set up in the organization, waiting on this person's sign-in.
 * `setup`: not set up yet; OpenWork's connector setup takes it from there.
 * `signin`: connectors come with an OpenWork account.
 */
export type ConnectorState =
  | { state: "built-in" }
  | { state: "signin" }
  | { state: "connected"; connectionId: string }
  | { state: "connect"; connectionId: string }
  | { state: "setup" };

export type ConnectorCatalog = { signedIn: boolean; connections: readonly UsableConnection[]; presets: readonly ConnectionPreset[] };

export function connectorState(entry: MarketplaceConnector, catalog: ConnectorCatalog): ConnectorState {
  if (entry.target.kind === "built-in") return { state: "built-in" };
  if (!catalog.signedIn) return { state: "signin" };
  const connection = connectionFor(entry, catalog.connections, catalog.presets);
  if (!connection) return { state: "setup" };
  return connection.connectedForMe ? { state: "connected", connectionId: connection.id } : { state: "connect", connectionId: connection.id };
}

/** Where OpenWork sets a connector up: a preset's own page, or the connector list for Google and Microsoft. */
export function setupPath(entry: MarketplaceConnector): string {
  return entry.target.kind === "preset" ? `/dashboard/library/connectors/new/${encodeURIComponent(entry.target.presetId)}` : "/dashboard/library/connectors/new";
}

export function matchesQuery(query: string, ...fields: string[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Coworkers that work with a connector: team members added from the Marketplace, then featured ones not on the team yet. */
export function coworkersUsing<Member extends { slug: string; name: string; templateOrigin?: string }>(connectorId: string, team: readonly Member[], featured: readonly FeaturedCoworker[] = FEATURED_COWORKERS): { onTeam: Member[]; suggested: FeaturedCoworker[] } {
  const onTeam = team.filter((member) => featured.find((coworker) => coworker.id === featuredIdOf(member.templateOrigin))?.integrations.includes(connectorId));
  const taken = new Set(onTeam.map((member) => featuredIdOf(member.templateOrigin)));
  return { onTeam, suggested: featured.filter((coworker) => coworker.integrations.includes(connectorId) && !taken.has(coworker.id)) };
}
