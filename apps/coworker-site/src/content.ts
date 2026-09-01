/**
 * All site copy lives here, and every product claim carries the place in the
 * product where it is true. The test in content.test.ts refuses claims without
 * a source, so the site can only say what the app does today. Sources are not
 * printed beside the copy; they are listed once, quietly, at the end of the
 * page ("Where each claim is true").
 */

export type Claim = {
  text: string;
  /** Where in the product this is true: a file path, route, or contract name. */
  source: string;
};

export const SITE = {
  name: "Open Coworker",
  tagline: "Give recurring work a teammate.",
  description:
    "Open Coworker is a quiet macOS home for AI coworkers who remember. Give each one a name, a role, and real work — and know exactly what happened when you come back. Local-first, powered by OpenWork.",
  url: "https://opencoworker.app",
  repository: "https://github.com/different-ai/openwork",
  openwork: "https://openworklabs.com",
  company: "Different AI",
  year: 2026,
} as const;

export const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#memory", label: "Memory" },
  { href: "#responsibilities", label: "Responsibilities" },
] as const;

export const HERO = {
  eyebrow: "Early access · macOS",
  title: "Give recurring work a teammate.",
  lead:
    "A quiet desktop home for AI coworkers who remember. Give each one a name, a role, and real work — and know exactly what happened when you come back.",
  primary: { label: "Run from source", href: "#get-started" },
  secondary: { label: "How it works", href: "#how" },
  /** Three short phrases, one line, no cards. */
  strip: ["Plain files you can open", "Native OpenWork threads", "Honest about where work runs"],
} as const;

export const STEPS: Array<Claim & { title: string }> = [
  {
    title: "Create",
    text: "A name and a look. Role and mission can wait — the first assignment teaches the job.",
    source: "apps/coworker/src/ui/new-coworker.tsx; apps/coworker/electron/main.mjs (coworkers.create registers /workspaces/local)",
  },
  {
    title: "Assign",
    text: "Say the outcome in your own words. It becomes a durable thread; the result reads like a receipt.",
    source: "apps/coworker/src/ui/threads.tsx (WorkOverview, ThreadView, MessageBubble)",
  },
  {
    title: "Return",
    text: "The team rail says who is working, who is ready, and who needs you — before you open anything.",
    source: "apps/coworker/src/ui/coworker-rail.tsx; apps/coworker/src/lib/activity-summary.ts",
  },
];

export const MEMORY: { title: string; lead: Claim; files: Array<{ path: string; note: string }> } = {
  title: "Memory you can read.",
  lead: {
    text:
      "No vector store, no hidden prompt history. A coworker keeps a small working memory it maintains itself, an index of long-term notes, and a stable soul — all Markdown, loaded on every turn, editable by you.",
    source: "apps/coworker/electron/coworkers.mjs (AGENTS.md contract, opencode.json instructions); apps/coworker/src/ui/memory.tsx",
  },
  files: [
    { path: "soul.md", note: "who it is" },
    { path: "memory/working.md", note: "what it is carrying right now" },
    { path: "memory/index.md", note: "what it knows it can look up" },
    { path: "memory/long-term/*.md", note: "durable notes, read when relevant" },
    { path: "workspace/", note: "deliverables" },
  ],
};

export const NEEDS_YOU: { title: string; lead: Claim } = {
  title: "When it needs you, it asks — and waits.",
  lead: {
    text:
      "A permission to run a command or leave its folder, or a question it cannot answer alone, shows up inside the thread as one small card. Nothing happens until you choose. Deny ends the step; the coworker explains and carries on.",
    source: "apps/coworker/src/lib/threads.ts (listThreadInteractions, replyPermission, replyQuestion); apps/coworker/src/ui/interactions.tsx",
  },
};

export const RESPONSIBILITIES: {
  title: string;
  lead: string;
  placements: Array<{ name: string; badge: string; points: string[]; source: string }>;
  retire: Claim;
} = {
  title: "Recurring work, with the placement said out loud.",
  lead: "A responsibility is a schedule a coworker owns. It can run in two places, and the app never blurs which.",
  placements: [
    {
      name: "This Mac",
      badge: "Local",
      points: [
        "Runs through the local OpenWork engine while Open Coworker is open.",
        "Has full access to the coworker's folder and memory.",
        "If a run is missed while the app is closed, the latest one is recovered on launch — never a backlog.",
      ],
      source: "apps/coworker/electron/local-responsibilities.mjs (@openwork/automations nextAutomationOccurrence)",
    },
    {
      name: "OpenWork Cloud",
      badge: "Always-on",
      points: [
        "Runs in OpenWork Cloud even when this Mac is off.",
        "Uses models your organization authorizes; run history lives in OpenWork.",
        "Cannot read this coworker's local files or memory — the app says so.",
      ],
      source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations, GET /v1/llm-providers)",
    },
  ],
  retire: {
    text: "Retiring moves the whole folder to a Retired area; nothing is deleted. Restore brings it back with its threads. Permanent deletion is a separate, deliberate step.",
    source: "apps/coworker/electron/coworkers.mjs (retireCoworker, restoreCoworker, deleteRetiredCoworker)",
  },
};

export const PLATFORM: { title: string; lead: string; items: Array<Claim & { name: string }> } = {
  title: "Built on OpenWork, not beside it.",
  lead: "Open Coworker adds the coworker layer and nothing else. Everything underneath is OpenWork you can run on its own.",
  items: [
    { name: "Server", text: "The same embedded openwork-server the OpenWork desktop ships.", source: "apps/coworker/electron/main.mjs (startEmbeddedServer)" },
    { name: "Engine", text: "Managed OpenCode with the providers you connected in OpenWork.", source: "apps/coworker/src/lib/threads.ts (provider.list, connectedModelCatalog)" },
    { name: "Threads", text: "Native sessions through @openwork/headless-threads.", source: "packages/headless-threads" },
    { name: "Automations", text: "Cloud responsibilities are OpenWork Automations.", source: "@openwork/types/automations; ee/apps/den-api /v1/cloud-automations" },
    { name: "Instructions", text: "Identity and memory ride the engine's own instruction loading.", source: "apps/coworker/electron/coworkers.mjs (opencodeConfigTemplate)" },
    { name: "Apps & tools", text: "MCP apps and tools configured for the engine, available to every coworker.", source: "apps/coworker/src/ui/capabilities.tsx" },
  ],
};

export const GET_STARTED: { title: string; lead: Claim; status: string; commands: string[] } = {
  title: "Run it from source today.",
  lead: {
    text:
      "Open Coworker lives in the OpenWork monorepo. It works without an account — choose “Start locally” on first launch and connect OpenWork Cloud later if you want always-on responsibilities. Signed macOS builds are in preparation; this page will link them the day they exist.",
    source: "apps/coworker/src/ui/onboarding.tsx; apps/coworker/README.md",
  },
  status: "Early access · no packaged download yet",
  commands: [
    "git clone https://github.com/different-ai/openwork",
    "cd openwork && pnpm install",
    "pnpm --filter openwork-server build",
    "pnpm --filter @openwork/coworker dev",
  ],
};

export const FOOTER = {
  links: [
    { label: "GitHub", href: SITE.repository },
    { label: "OpenWork", href: SITE.openwork },
  ],
  poweredBy: "Powered by OpenWork",
  claimsTitle: "Where each claim on this page is true",
} as const;

/** Every claim on the page, for the honesty test and the footer disclosure. */
export function allClaims(): Claim[] {
  return [
    ...STEPS,
    MEMORY.lead,
    NEEDS_YOU.lead,
    ...RESPONSIBILITIES.placements.map((placement) => ({ text: placement.points.join(" "), source: placement.source })),
    RESPONSIBILITIES.retire,
    ...PLATFORM.items,
    GET_STARTED.lead,
  ];
}

/** Phrases the product cannot back today; the test forbids them anywhere in the copy. */
export const FORBIDDEN_PHRASES = [
  "always on your local files",
  "runs while closed on this mac",
  "download for mac",
  "app store",
  "never fails",
  "fully autonomous",
] as const;
