"use client";

import { useQuery } from "@tanstack/react-query";

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
  id: string;
  name: string;
  description: string;
  transport: PluginMcpTransport;
  toolCount: number;
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

export type PluginSource =
  | { type: "marketplace"; marketplace: string }
  | { type: "github"; repo: string }
  | { type: "local"; path: string };

export type DenPlugin = {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  author: string;
  category: PluginCategory;
  installed: boolean;
  source: PluginSource;
  skills: PluginSkill[];
  hooks: PluginHook[];
  mcps: PluginMcp[];
  agents: PluginAgent[];
  commands: PluginCommand[];
  updatedAt: string;
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

export function getPluginPartsSummary(plugin: DenPlugin): string {
  const parts: string[] = [];
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
    updatedAt: "2026-04-10T12:00:00Z",
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
    updatedAt: "2026-04-07T09:00:00Z",
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
    updatedAt: "2026-03-28T16:45:00Z",
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
    updatedAt: "2026-04-02T18:12:00Z",
  },
  {
    id: "plg_openwork_release",
    name: "OpenWork Release Kit",
    slug: "openwork-release-kit",
    description:
      "Internal plugin that automates OpenWork release prep, orchestrator sidecar builds, and changelog generation. Shipped by OpenWork infra.",
    version: "2.3.1",
    author: "OpenWork",
    category: "workflows",
    installed: true,
    source: { type: "github", repo: "different-ai/openwork-plugins" },
    skills: [
      { id: "sk_ow_release_prep", name: "Release Prep", description: "Bump versions across app/desktop/orchestrator in lockstep." },
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
    updatedAt: "2026-04-14T08:30:00Z",
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
    updatedAt: "2026-03-20T11:00:00Z",
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
    updatedAt: "2026-03-12T14:22:00Z",
  },
];

async function fetchMockPlugins(): Promise<DenPlugin[]> {
  // Simulate network latency so loading states render during development.
  await new Promise((resolve) => setTimeout(resolve, 180));
  return MOCK_PLUGINS;
}

async function fetchMockPlugin(id: string): Promise<DenPlugin | null> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  return MOCK_PLUGINS.find((plugin) => plugin.id === id) ?? null;
}

// ── Query hooks ────────────────────────────────────────────────────────────
//
// Keep the surface identical to what a real API-backed version would return,
// so swapping `queryFn` for `requestJson(...)` later is a one-line change.

export const pluginQueryKeys = {
  all: ["plugins"] as const,
  list: () => [...pluginQueryKeys.all, "list"] as const,
  detail: (id: string) => [...pluginQueryKeys.all, "detail", id] as const,
};

export function usePlugins() {
  return useQuery({
    queryKey: pluginQueryKeys.list(),
    queryFn: fetchMockPlugins,
  });
}

export function usePlugin(id: string) {
  return useQuery({
    queryKey: pluginQueryKeys.detail(id),
    queryFn: () => fetchMockPlugin(id),
    enabled: Boolean(id),
  });
}
