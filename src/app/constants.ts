import type { CuratedPackage, ModelRef, SuggestedPlugin } from "./types";

export const MODEL_PREF_KEY = "openwork.defaultModel";
export const THINKING_PREF_KEY = "openwork.showThinking";
export const VARIANT_PREF_KEY = "openwork.modelVariant";
export const DEMO_MODE_PREF_KEY = "openwork.demoMode";
export const DEMO_SEQUENCE_PREF_KEY = "openwork.demoSequence";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "gpt-5-nano",
};

export const CURATED_PACKAGES: CuratedPackage[] = [
  {
    name: "OpenPackage Essentials",
    source: "essentials",
    description: "Starter rules, commands, and skills from the OpenPackage registry.",
    tags: ["registry", "starter"],
    installable: true,
  },
  {
    name: "Claude Code Plugins",
    source: "github:anthropics/claude-code",
    description: "Official Claude Code plugin pack from GitHub.",
    tags: ["github", "claude"],
    installable: true,
  },
  {
    name: "Claude Code Commit Commands",
    source: "github:anthropics/claude-code#subdirectory=plugins/commit-commands",
    description: "Commit message helper commands (Claude Code plugin).",
    tags: ["github", "workflow"],
    installable: true,
  },
  {
    name: "Awesome OpenPackage",
    source: "git:https://github.com/enulus/awesome-openpackage.git",
    description: "Community collection of OpenPackage examples and templates.",
    tags: ["community"],
    installable: true,
  },
  {
    name: "Notion CRM Skill",
    source: "github:different-ai/openwork-skills#subdirectory=manage-crm-notion",
    description: "Set up a Notion CRM with pipelines, contacts, and follow-ups.",
    tags: ["notion", "crm", "demo"],
    installable: true,
  },
  {
    name: "Awesome Claude Skills",
    source: "https://github.com/ComposioHQ/awesome-claude-skills",
    description: "Curated list of Claude skills and prompts (not an OpenPackage yet).",
    tags: ["community", "list"],
    installable: false,
  },
];

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "Run scheduled jobs with the OpenCode scheduler plugin.",
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
  {
    name: "opencode-browser",
    packageName: "@different-ai/opencode-browser",
    description: "Browser automation with a local extension + native host.",
    tags: ["browser", "extension"],
    aliases: ["opencode-browser"],
    installMode: "guided",
    steps: [
      {
        title: "Run the installer",
        description: "Installs the extension + native host and prepares the local broker.",
        command: "bunx @different-ai/opencode-browser@latest install",
        note: "Use npx @different-ai/opencode-browser@latest install if you do not have bunx.",
      },
      {
        title: "Load the extension",
        description:
          "Open chrome://extensions, enable Developer mode, click Load unpacked, and select the extension folder.",
        url: "chrome://extensions",
        path: "~/.opencode-browser/extension",
      },
      {
        title: "Pin the extension",
        description: "Pin OpenCode Browser Automation in your browser toolbar.",
      },
      {
        title: "Add plugin to config",
        description: "Click Add to write @different-ai/opencode-browser into opencode.json.",
      },
    ],
  },
];

export type McpDirectoryInfo = {
  name: string;
  description: string;
  url: string;
  oauth: boolean;
};

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    name: "Notion",
    description: "Pages, databases, and project docs in sync.",
    url: "https://mcp.notion.com/mcp",
    oauth: true,
  },
  {
    name: "Linear",
    description: "Plan sprints and ship tickets faster.",
    url: "https://mcp.linear.app/mcp",
    oauth: true,
  },
  {
    name: "Sentry",
    description: "Track releases and resolve production errors.",
    url: "https://mcp.sentry.dev/mcp",
    oauth: true,
  },
  {
    name: "Figma",
    description: "Pull specs and assets from design files.",
    url: "https://mcp.figma.com/mcp",
    oauth: true,
  },
  {
    name: "Stripe",
    description: "Inspect payments, invoices, and subscriptions.",
    url: "https://mcp.stripe.com",
    oauth: true,
  },
  {
    name: "HubSpot",
    description: "CRM notes, companies, and pipeline status.",
    url: "https://mcp.hubspot.com/anthropic",
    oauth: true,
  },
  {
    name: "Context7",
    description: "Search product docs with richer context.",
    url: "https://mcp.context7.com/mcp",
    oauth: false,
  },
];
