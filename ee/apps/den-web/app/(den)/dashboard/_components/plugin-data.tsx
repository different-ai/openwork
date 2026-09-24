"use client";

import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type ConnectedIntegration,
  integrationQueryKeys,
} from "./integration-data";
import { parsePluginAccessGrants, pluginAccessQueryKeys } from "./plugin-access-data";

/**
 * Plugin primitives — mirror OpenCode / Claude Code's plugin surface:
 *
 *  A plugin is a *bundle* of reusable pieces that extend an agent runtime:
 *   - skills      natural-language playbooks/instructions agents can load on demand
 *   - hooks       lifecycle callbacks (PreToolUse / PostToolUse / SessionStart, etc.)
 *   - mcps        Model Context Protocol servers that expose external tools/resources
 *   - agents      custom sub-agents with their own system prompt and tool set
 *   - commands    slash-commands that shortcut common workflows
 *
 * This file models the frontend shape only. Mock data is served through
 * React Query so we can swap the queryFn for a real API call later without
 * touching any consumers.
 *
 * Gating: the catalog is empty until the user has connected at least one
 * integration (GitHub or Bitbucket) on the Integrations page. The queryFn
 * reads the integrations cache and derives which plugins are visible from
 * the set of connected repositories. Integration mutations invalidate
 * `["plugins"]`, so connections and disconnections propagate automatically.
 */

// ── Primitive types ────────────────────────────────────────────────────────

export type PluginCategory =
  | "integrations"
  | "workflows"
  | "code-intelligence"
  | "output-styles"
  | "infrastructure";

export type PluginSkill = {
  id: string;
  name: string;
  description: string;
};

export type PluginHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop";

export type PluginHook = {
  id: string;
  event: PluginHookEvent;
  description: string;
  matcher?: string | null;
};

export type PluginMcpTransport = "stdio" | "http" | "sse";

export type PluginMcp = {
  configObjectId?: string;
  connectionId?: string | null;
  id: string;
  name: string;
  description: string;
  transport: PluginMcpTransport;
  toolCount: number;
  serverName?: string;
  url?: string | null;
};

export type PluginAgent = {
  id: string;
  name: string;
  description: string;
};

export type PluginCommand = {
  id: string;
  name: string;
  description: string;
};

export type PluginWorkflow = {
  id: string;
  name: string;
  description: string;
  versionId: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  requiredCapabilityCount: number;
};

export type PluginRemoteMcpApp = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  sourceUrl: string | null;
};

export type PluginSource =
  | { type: "marketplace"; marketplace: string }
  | { type: "github"; repo: string }
  | { type: "local"; path: string };

export type PluginMarketplaceRef = {
  id: string;
  name: string;
};

export type DenPlugin = {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string | null;
  author: string;
  category: PluginCategory;
  installed: boolean;
  source: PluginSource;
  status?: "active" | "archived";
  marketplaces?: PluginMarketplaceRef[];
  skills: PluginSkill[];
  hooks: PluginHook[];
  mcps: PluginMcp[];
  agents: PluginAgent[];
  commands: PluginCommand[];
  workflows: PluginWorkflow[];
  apps: PluginRemoteMcpApp[];
  createdAt: string;
  createdByOrgMembershipId: string | null;
  updatedAt: string;
  /**
   * Opt-in gating: which connected integration provider exposes this plugin.
   * - "any"      → visible once ANY integration is connected (e.g. marketplace output styles)
   * - "github"   → only visible after a GitHub account is connected
   * - "bitbucket"→ only visible after a Bitbucket account is connected
   */
  requiresProvider: "any" | "github" | "bitbucket";
};

// ── Display helpers ────────────────────────────────────────────────────────

export function getPluginCategoryLabel(category: PluginCategory): string {
  switch (category) {
    case "integrations":
      return "External Integrations";
    case "workflows":
      return "Workflows";
    case "code-intelligence":
      return "Code Intelligence";
    case "output-styles":
      return "Output Styles";
    case "infrastructure":
      return "Infrastructure";
  }
}
export function formatPluginTimestamp(value: string | null): string {
  if (!value) {
    return "Recently updated";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently updated";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function getPluginComponentCount(plugin: DenPlugin): number {
  return (
    plugin.apps.length +
    plugin.skills.length +
    plugin.hooks.length +
    plugin.mcps.length +
    plugin.agents.length +
    plugin.commands.length
    + plugin.workflows.length
  );
}

export function getPluginPartsSummary(plugin: DenPlugin): string {
  const parts: string[] = [];
  if (plugin.apps.length > 0) {
    parts.push(`${plugin.apps.length} ${plugin.apps.length === 1 ? "App" : "Apps"}`);
  }
  if (plugin.skills.length > 0) {
    parts.push(`${plugin.skills.length} ${plugin.skills.length === 1 ? "Skill" : "Skills"}`);
  }
  if (plugin.hooks.length > 0) {
    parts.push(`${plugin.hooks.length} ${plugin.hooks.length === 1 ? "Hook" : "Hooks"}`);
  }
  if (plugin.mcps.length > 0) {
    parts.push(`${plugin.mcps.length} ${plugin.mcps.length === 1 ? "MCP" : "MCPs"}`);
  }
  if (plugin.agents.length > 0) {
    parts.push(`${plugin.agents.length} ${plugin.agents.length === 1 ? "Agent" : "Agents"}`);
  }
  if (plugin.commands.length > 0) {
    parts.push(`${plugin.commands.length} ${plugin.commands.length === 1 ? "Command" : "Commands"}`);
  }
  if (plugin.workflows.length > 0) {
    parts.push(`${plugin.workflows.length} ${plugin.workflows.length === 1 ? "Workflow" : "Workflows"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Empty bundle";
}

// ── Mock data ──────────────────────────────────────────────────────────────
//
// These are shaped to mirror real marketplaces (Anthropic's official catalog,
// internal team bundles, etc.) so the UI exercises realistic content.

const MOCK_PLUGINS: DenPlugin[] = [
  {
    id: "plg_github",
    name: "GitHub",
    slug: "github",
    description:
      "Work with GitHub repositories, pull requests, issues, and Actions directly from chat. Bundles an MCP server and review workflows.",
    version: "1.4.2",
    author: "Anthropic",
    category: "integrations",
    installed: true,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [
      { id: "sk_gh_pr", name: "Open Pull Request", description: "Draft PR titles and bodies from a diff." },
      { id: "sk_gh_review", name: "Review Pull Request", description: "Summarize diffs and suggest blocking comments." },
    ],
    hooks: [
      {
        id: "hk_gh_pre",
        event: "PreToolUse",
        description: "Redact GitHub tokens from logs before tool execution.",
        matcher: "Bash",
      },
    ],
    mcps: [
      {
        id: "mcp_gh",
        name: "github-mcp",
        description: "Official GitHub MCP server — issues, PRs, releases, Actions.",
        transport: "http",
        toolCount: 42,
      },
    ],
    agents: [
      {
        id: "ag_gh_reviewer",
        name: "pr-reviewer",
        description: "Opinionated pull-request reviewer with context-aware suggestions.",
      },
    ],
    commands: [
      { id: "cmd_gh_pr", name: "/gh:pr", description: "Create a pull request from the current branch." },
    ],
    workflows: [],
    apps: [],
    createdAt: "2026-04-10T12:00:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-04-10T12:00:00Z",
    requiresProvider: "github",
  },
  {
    id: "plg_commit_commands",
    name: "Commit Commands",
    slug: "commit-commands",
    description:
      "Git commit, push, and PR-creation workflows. Uses conventional-commit heuristics and follows your repo's commit style.",
    version: "0.9.0",
    author: "Anthropic",
    category: "workflows",
    installed: true,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [
      { id: "sk_cc_commit", name: "Smart Commit", description: "Stage, group, and commit with a generated message." },
      { id: "sk_cc_push", name: "Push & Open PR", description: "Push current branch and open a PR with autogenerated body." },
    ],
    hooks: [],
    mcps: [],
    agents: [],
    commands: [
      { id: "cmd_cc_commit", name: "/commit", description: "Create a commit for staged changes." },
      { id: "cmd_cc_push", name: "/push", description: "Push current branch and track upstream." },
      { id: "cmd_cc_pr", name: "/pr", description: "Open a pull request." },
    ],
    workflows: [],
    apps: [],
    createdAt: "2026-04-07T09:00:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-04-07T09:00:00Z",
    requiresProvider: "any",
  },
  {
    id: "plg_typescript_lsp",
    name: "TypeScript LSP",
    slug: "typescript-lsp",
    description:
      "Connects Claude to the TypeScript language server so it can jump to definitions, find references, and surface type errors immediately after edits.",
    version: "1.1.0",
    author: "Anthropic",
    category: "code-intelligence",
    installed: false,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [],
    hooks: [
      {
        id: "hk_ts_diag",
        event: "PostToolUse",
        description: "Run LSP diagnostics after every file edit and report type errors.",
        matcher: "Edit|Write",
      },
    ],
    mcps: [
      {
        id: "mcp_ts",
        name: "typescript-language-server",
        description: "LSP bridge for .ts/.tsx diagnostics and navigation.",
        transport: "stdio",
        toolCount: 9,
      },
    ],
    agents: [],
    commands: [],
    workflows: [],
    apps: [],
    createdAt: "2026-03-28T16:45:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-03-28T16:45:00Z",
    requiresProvider: "any",
  },
  {
    id: "plg_linear",
    name: "Linear",
    slug: "linear",
    description:
      "Create, update, and triage Linear issues without leaving the session. Bundles a Linear MCP and an issue-grooming agent.",
    version: "0.6.3",
    author: "Anthropic",
    category: "integrations",
    installed: false,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [
      { id: "sk_lin_triage", name: "Triage Inbox", description: "Sweep the inbox and file issues to the right project." },
    ],
    hooks: [],
    mcps: [
      {
        id: "mcp_linear",
        name: "linear-mcp",
        description: "Linear MCP — issues, cycles, projects, comments.",
        transport: "http",
        toolCount: 24,
      },
    ],
    agents: [
      { id: "ag_lin_groomer", name: "linear-groomer", description: "Keeps the backlog tidy and flags stale issues." },
    ],
    commands: [
      { id: "cmd_lin_new", name: "/linear:new", description: "File a new issue from the current context." },
    ],
    workflows: [],
    apps: [],
    createdAt: "2026-04-02T18:12:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-04-02T18:12:00Z",
    requiresProvider: "any",
  },
  {
    id: "plg_openwork_release",
    name: "OpenWork Release Kit",
    slug: "openwork-release-kit",
    description:
      "Internal plugin that automates OpenWork release prep, server package checks, and changelog generation. Shipped by OpenWork infra.",
    version: "2.3.1",
    author: "OpenWork",
    category: "workflows",
    installed: true,
    source: { type: "github", repo: "different-ai/openwork-plugins" },
    skills: [
      { id: "sk_ow_release_prep", name: "Release Prep", description: "Bump versions across app, desktop, and openwork-server in lockstep." },
      { id: "sk_ow_changelog", name: "Changelog Drafter", description: "Generate markdown release notes from merged PRs." },
    ],
    hooks: [
      {
        id: "hk_ow_sessionstart",
        event: "SessionStart",
        description: "Load the release runbook into context at session start.",
        matcher: null,
      },
    ],
    mcps: [],
    agents: [
      { id: "ag_ow_release", name: "release-captain", description: "Drives the full release flow end-to-end." },
    ],
    commands: [
      { id: "cmd_ow_release", name: "/release", description: "Run the standardized release workflow." },
    ],
    workflows: [],
    apps: [],
    createdAt: "2026-04-14T08:30:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-04-14T08:30:00Z",
    requiresProvider: "github",
  },
  {
    id: "plg_sentry",
    name: "Sentry",
    slug: "sentry",
    description:
      "Connect to Sentry and ingest recent errors into a session. Includes an MCP server and a triage skill that clusters noisy issues.",
    version: "0.4.0",
    author: "Anthropic",
    category: "infrastructure",
    installed: false,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [
      { id: "sk_sentry_triage", name: "Triage Errors", description: "Cluster Sentry issues and recommend owners." },
    ],
    hooks: [],
    mcps: [
      {
        id: "mcp_sentry",
        name: "sentry-mcp",
        description: "Sentry MCP — projects, issues, releases, performance.",
        transport: "http",
        toolCount: 18,
      },
    ],
    agents: [],
    commands: [],
    workflows: [],
    apps: [],
    createdAt: "2026-03-20T11:00:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-03-20T11:00:00Z",
    requiresProvider: "any",
  },
  {
    id: "plg_explanatory_style",
    name: "Explanatory Output Style",
    slug: "explanatory-output-style",
    description:
      "Response style that adds educational context around implementation choices, trade-offs, and alternatives.",
    version: "1.0.0",
    author: "Anthropic",
    category: "output-styles",
    installed: false,
    source: { type: "marketplace", marketplace: "claude-plugins-official" },
    skills: [],
    hooks: [
      {
        id: "hk_explain_post",
        event: "Stop",
        description: "Append an 'Implementation notes' section before stopping.",
        matcher: null,
      },
    ],
    mcps: [],
    agents: [],
    commands: [],
    workflows: [],
    apps: [],
    createdAt: "2026-03-12T14:22:00Z",
    createdByOrgMembershipId: null,
    updatedAt: "2026-03-12T14:22:00Z",
    requiresProvider: "any",
  },
];

function readConnectedProviders(client: QueryClient): Set<"github" | "bitbucket"> {
  const connections = client.getQueryData<ConnectedIntegration[]>(integrationQueryKeys.list()) ?? [];
  return new Set(connections.map((connection) => connection.provider));
}

function filterByConnectedProviders(
  plugins: DenPlugin[],
  connectedProviders: Set<"github" | "bitbucket">,
): DenPlugin[] {
  if (connectedProviders.size === 0) {
    return [];
  }
  return plugins.filter((plugin) => {
    if (plugin.requiresProvider === "any") return true;
    return connectedProviders.has(plugin.requiresProvider);
  });
}

// ── Query hooks ────────────────────────────────────────────────────────────
//
// Keep the surface identical to what a real API-backed version would return,
// so swapping `queryFn` for `requestJson(...)` later is a one-line change.

export const pluginQueryKeys = {
  all: ["plugins"] as const,
  list: () => [...pluginQueryKeys.all, "list"] as const,
  summaries: () => [...pluginQueryKeys.list(), "summaries"] as const,
  detail: (id: string) => [...pluginQueryKeys.all, "detail", id] as const,
};

function slugifyPluginName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "plugin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pluginMcpTransport(config: Record<string, unknown>): PluginMcpTransport {
  const type = asString(config.type)?.toLowerCase();
  if (type === "sse") return "sse";
  return asString(config.url) ? "http" : "stdio";
}

export function pluginMcpEntries(item: {
  description: string;
  id: string;
  normalizedPayload: Record<string, unknown> | null;
  title: string;
}): PluginMcp[] {
  const payload = item.normalizedPayload ?? {};
  const entries = [payload.mcpServers, payload.mcp].flatMap((container) => (
    isRecord(container)
      ? Object.entries(container).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      : []
  ));
  const servers = entries.length > 0
    ? entries
    : [[item.title, payload] satisfies [string, Record<string, unknown>]];

  return servers.map(([serverName, config], index) => ({
    configObjectId: item.id,
    connectionId: asString(config.externalMcpConnectionId),
    description: item.description,
    id: servers.length === 1 ? item.id : `${item.id}:${index}`,
    name: servers.length === 1 ? item.title : serverName,
    serverName,
    toolCount: typeof config.toolCount === "number" ? config.toolCount : 0,
    transport: pluginMcpTransport(config),
    url: asString(config.url),
  }));
}

function parseMembershipConfigObject(entry: unknown) {
  if (!isRecord(entry) || !isRecord(entry.configObject)) {
    return null;
  }

  const configObject = entry.configObject;
  const id = asString(configObject.id);
  const title = asString(configObject.title);
  const description = asString(configObject.description) ?? "";
  const objectType = asString(configObject.objectType);
  const currentRelativePath = asString(configObject.currentRelativePath);
  const latestVersion = isRecord(configObject.latestVersion) ? configObject.latestVersion : null;
  const latestVersionId = latestVersion ? asString(latestVersion.id) : null;
  const normalizedPayload = latestVersion && isRecord(latestVersion.normalizedPayloadJson)
    ? latestVersion.normalizedPayloadJson
    : null;

  if (!id || !title || !objectType) {
    return null;
  }

  return {
    currentRelativePath,
    description,
    id,
    latestVersionId,
    normalizedPayload,
    objectType,
    title,
  };
}

function derivePluginCategory(input: { agents: PluginAgent[]; apps: PluginRemoteMcpApp[]; commands: PluginCommand[]; hooks: PluginHook[]; mcps: PluginMcp[]; skills: PluginSkill[]; workflows: PluginWorkflow[] }): PluginCategory {
  if (input.mcps.length > 0 || input.hooks.length > 0) {
    return "integrations";
  }
  if (input.agents.length > 0 || input.apps.length > 0 || input.commands.length > 0 || input.workflows.length > 0 || input.skills.length > 0) {
    return "workflows";
  }
  return "output-styles";
}

function parsePluginHookEvent(value: string | null): PluginHookEvent {
  switch (value) {
    case "PreToolUse":
    case "PostToolUse":
    case "SessionStart":
    case "SessionEnd":
    case "UserPromptSubmit":
    case "Notification":
    case "Stop":
      return value;
    default:
      return "Notification";
  }
}

function requestPluginContents(id: string) {
  return requestJson(`/v1/plugins/${encodeURIComponent(id)}/resolved`, { method: "GET" }, 15000);
}

function pluginContentsPayload({ response, payload }: Awaited<ReturnType<typeof requestPluginContents>>) {
  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Failed to load plugin contents (${response.status}).`));
  }
  return payload;
}

async function fetchResolvedPlugin(id: string): Promise<DenPlugin | null> {
  const [pluginResult, membershipsResult] = await Promise.all([
    requestJson(`/v1/plugins/${encodeURIComponent(id)}`, { method: "GET" }, 15000),
    requestPluginContents(id),
  ]);

  if (!pluginResult.response.ok) {
    throw new Error(getErrorMessage(pluginResult.payload, `Failed to load plugin (${pluginResult.response.status}).`));
  }
  const contents = pluginContentsPayload(membershipsResult);

  const pluginItem = isRecord(pluginResult.payload) && isRecord(pluginResult.payload.item) ? pluginResult.payload.item : null;
  return pluginItem ? buildDenPlugin(pluginItem, contents) : null;
}

/** List items and plugin detail share one shape, so either can be combined with `/resolved`. */
function buildDenPlugin(pluginItem: Record<string, unknown>, contents: unknown): DenPlugin | null {
  const pluginId = asString(pluginItem.id);
  const name = asString(pluginItem.name);
  if (!pluginId || !name) {
    return null;
  }

  const membershipItems = isRecord(contents) && Array.isArray(contents.items)
    ? contents.items.map(parseMembershipConfigObject).filter((value): value is NonNullable<typeof value> => Boolean(value))
    : [];

  const skills = membershipItems
    .filter((item) => item.objectType === "skill")
    .map((item) => ({ id: item.id, name: item.title, description: item.description } satisfies PluginSkill));
  const agents = membershipItems
    .filter((item) => item.objectType === "agent")
    .map((item) => ({ id: item.id, name: item.title, description: item.description } satisfies PluginAgent));
  const commands = membershipItems
    .filter((item) => item.objectType === "command")
    .map((item) => ({ id: item.id, name: item.currentRelativePath?.split("/").pop()?.replace(/\.md$/i, "") ?? item.title, description: item.description } satisfies PluginCommand));
  const workflows = membershipItems
    .filter((item) => item.objectType === "workflow")
    .map((item) => ({
      id: item.id,
      name: item.title,
      description: item.description,
      versionId: item.latestVersionId,
      inputSchema: isRecord(item.normalizedPayload?.inputSchema) ? item.normalizedPayload.inputSchema : null,
      outputSchema: isRecord(item.normalizedPayload?.outputSchema) ? item.normalizedPayload.outputSchema : null,
      requiredCapabilityCount: Array.isArray(item.normalizedPayload?.requiredCapabilities)
        ? item.normalizedPayload.requiredCapabilities.length
        : 0,
    } satisfies PluginWorkflow));
  // Standalone URL-imported Apps are retained in storage for a future unit of
  // value, but intentionally stay out of the current Plugin and Library UI.
  const apps: PluginRemoteMcpApp[] = [];
  const hooks = membershipItems
    .filter((item) => item.objectType === "hook")
    .map((item) => ({
      description: item.description,
      event: parsePluginHookEvent(asString(item.normalizedPayload?.event) ?? item.title),
      id: item.id,
      matcher: asString(item.normalizedPayload?.matcher),
    } satisfies PluginHook));
  const mcps = membershipItems
    .filter((item) => item.objectType === "mcp")
    .flatMap(pluginMcpEntries);

  const marketplaces = Array.isArray(pluginItem.marketplaces)
    ? pluginItem.marketplaces.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = asString(entry.id);
        const marketplaceName = asString(entry.name);
        if (!id || !marketplaceName) return [];
        return [{ id, name: marketplaceName } satisfies PluginMarketplaceRef];
      })
    : [];

  return {
    agents,
    apps,
    author: "Connected repository",
    category: derivePluginCategory({ agents, apps, commands, hooks, mcps, skills, workflows }),
    commands,
    createdAt: asString(pluginItem.createdAt) ?? new Date().toISOString(),
    createdByOrgMembershipId: asString(pluginItem.createdByOrgMembershipId),
    description: asString(pluginItem.description) ?? "",
    hooks,
    id: pluginId,
    installed: true,
    marketplaces,
    mcps,
    name,
    requiresProvider: "github",
    workflows,
    skills,
    slug: slugifyPluginName(name),
    source: marketplaces[0]
      ? { type: "marketplace", marketplace: marketplaces[0].name }
      : { type: "github", repo: "Connected repository" },
    status: asString(pluginItem.status) === "archived" ? "archived" : "active",
    updatedAt: asString(pluginItem.updatedAt) ?? new Date().toISOString(),
    version: null,
  } satisfies DenPlugin;
}

function listItems(payload: unknown) {
  return (isRecord(payload) && Array.isArray(payload.items) ? payload.items : []).filter(isRecord);
}

/** Every plugin with its contents: one list request plus `/resolved` per plugin. */
export function usePlugins({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: pluginQueryKeys.list(),
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/plugins?status=active&limit=100", { method: "GET" }, 20000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load plugins (${response.status}).`));
      }

      const plugins = await Promise.all(listItems(payload).map(async (item) => {
        const id = asString(item.id);
        return id ? buildDenPlugin(item, pluginContentsPayload(await requestPluginContents(id))) : null;
      }));
      return plugins.filter((plugin): plugin is DenPlugin => Boolean(plugin));
    },
  });
}

/** What a plugin list row shows, straight from the list response. */
export type DenPluginSummary = Pick<DenPlugin, "id" | "name" | "slug" | "description" | "status" | "createdByOrgMembershipId"> & {
  /** False when the server did not include access, so callers load it per plugin. */
  accessIncluded: boolean;
  updatedAt?: string;
};

function parsePluginSummary(item: Record<string, unknown>): DenPluginSummary | null {
  const id = asString(item.id);
  const name = asString(item.name);
  if (!id || !name) return null;
  return {
    accessIncluded: Array.isArray(item.access),
    updatedAt: asString(item.updatedAt) ?? undefined,
    createdByOrgMembershipId: asString(item.createdByOrgMembershipId),
    description: asString(item.description) ?? "",
    id,
    name,
    slug: slugifyPluginName(name),
    status: asString(item.status) === "archived" ? "archived" : "active",
  };
}

/**
 * Plugins without their contents, in one request. Access for plugins the
 * caller manages is written to each plugin's access query.
 */
export function pluginSummariesQueryOptions() {
  return queryOptions({
    queryKey: pluginQueryKeys.summaries(),
    queryFn: async ({ client }): Promise<DenPluginSummary[]> => {
      const { response, payload } = await requestJson("/v1/plugins?status=active&limit=100&includeAccess=true", { method: "GET" }, 20000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load plugins (${response.status}).`));
      }

      return listItems(payload).flatMap((item) => {
        const summary = parsePluginSummary(item);
        if (!summary) return [];
        if (summary.accessIncluded) {
          client.setQueryData(pluginAccessQueryKeys.detail(summary.id), parsePluginAccessGrants(item.access));
        }
        return [summary];
      });
    },
  });
}

export function usePluginSummaries({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...pluginSummariesQueryOptions(), enabled });
}

export function pluginDirectoryParams(filters: { q: string; teamId: string | null; memberId: string | null; ownerId?: string | null }, cursor: string) {
  const params = new URLSearchParams({ status: "active", limit: "50", includeAccess: "true" });
  if (!cursor) { params.set("includeTotal", "true"); params.set("includeFacets", "true"); }
  if (filters.q) params.set("name", filters.q);
  if (filters.teamId) params.set("teamId", filters.teamId);
  if (filters.memberId) params.set("memberId", filters.memberId);
  if (filters.ownerId) params.set("ownerId", filters.ownerId);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export function pluginDirectoryQueryKey(orgId: string | null, viewerId: string | null, filters: { q: string; teamId: string | null; memberId: string | null; ownerId?: string | null }) {
  return [...pluginQueryKeys.summaries(), "directory", orgId, viewerId, filters.q, filters.teamId, filters.memberId, filters.ownerId ?? null];
}

function parseDirectoryCounts(value: unknown): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.fromEntries(value.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.count === "number" ? [[entry.id, entry.count]] : []));
}

export function usePluginDirectory(filters: { q: string; teamId: string | null; memberId: string | null; ownerId?: string | null }) {
  const client = useQueryClient();
  const { orgId, orgContext } = useOrgDashboard();
  return useInfiniteQuery({
    queryKey: pluginDirectoryQueryKey(orgId, orgContext?.currentMember.id ?? null, filters),
    enabled: Boolean(orgId && orgContext?.organization.id === orgId),
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = pluginDirectoryParams(filters, pageParam);
      const { response, payload } = await requestJson(`/v1/plugins?${params}`, { method: "GET" }, 20000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to load plugins (${response.status}).`));
      const items = listItems(payload).flatMap((item) => {
        const summary = parsePluginSummary(item);
        if (!summary) return [];
        if (summary.accessIncluded) client.setQueryData(pluginAccessQueryKeys.detail(summary.id), parsePluginAccessGrants(item.access));
        return [summary];
      });
      return {
        items,
        nextCursor: isRecord(payload) ? asString(payload.nextCursor) : null,
        total: isRecord(payload) && typeof payload.total === "number" ? payload.total : null,
        teamCounts: parseDirectoryCounts(isRecord(payload) ? payload.teamCounts : null),
        ownerCounts: parseDirectoryCounts(isRecord(payload) ? payload.ownerCounts : null),
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function pluginDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: pluginQueryKeys.detail(id),
    queryFn: async () => fetchResolvedPlugin(id),
    enabled: Boolean(id),
  });
}

export function usePlugin(id: string) {
  return useQuery(pluginDetailQueryOptions(id));
}

export function useUpdatePlugin() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { pluginId: string; name: string; description: string | null }) => {
      await runReauthableAction("update-plugin", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name: input.name, description: input.description }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update plugin (${response.status}).`);
        }
      });
      return input.pluginId;
    },
    onSuccess: (pluginId) => {
      queryClient.invalidateQueries({ queryKey: pluginQueryKeys.detail(pluginId) });
      queryClient.invalidateQueries({ queryKey: pluginQueryKeys.list() });
    },
  });
}

export function useArchivePlugin() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (pluginId: string) => {
      await runReauthableAction("archive-plugin", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(pluginId)}/archive`,
          { method: "POST" },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to archive plugin (${response.status}).`);
        }
      });
      return pluginId;
    },
    onSuccess: (pluginId) => {
      queryClient.removeQueries({ queryKey: pluginQueryKeys.detail(pluginId) });
      queryClient.invalidateQueries({ queryKey: pluginQueryKeys.list() });
    },
  });
}

export function useAttachWorkflowToPlugin(pluginId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (workflowId: string) => {
      await runReauthableAction("attach-workflow-to-plugin", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(pluginId)}/config-objects`,
          {
            method: "POST",
            body: JSON.stringify({ configObjectId: workflowId, membershipSource: "manual" }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to add Workflow (${response.status}).`);
        }
      });
      return workflowId;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pluginQueryKeys.detail(pluginId) }),
        queryClient.invalidateQueries({ queryKey: pluginQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: ["me", "library"] }),
      ]);
    },
  });
}
