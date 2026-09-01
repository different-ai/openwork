/**
 * All site copy lives here, and every product claim carries the place in the
 * product where it is true. The test in content.test.ts refuses claims without
 * a source, so the site can only say what the app does today.
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
    "Open Coworker is a macOS home for persistent AI coworkers. Each one has a name, a role, inspectable memory, and a native OpenWork workspace. Local-first, powered by OpenWork.",
  url: "https://opencoworker.app",
  repository: "https://github.com/different-ai/openwork",
  openwork: "https://openworklabs.com",
  openworkDocs: "https://openworklabs.com/docs",
  company: "Different AI",
  year: 2026,
} as const;

export const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#memory", label: "Memory" },
  { href: "#responsibilities", label: "Responsibilities" },
  { href: "#platform", label: "Powered by OpenWork" },
] as const;

export const HERO = {
  eyebrow: "Early access · macOS",
  title: "Give recurring work a teammate.",
  lead:
    "Open Coworker is a desktop home for persistent AI coworkers. Each one has a name, a role, memory you can read, and a native OpenWork workspace on your Mac.",
  primary: { label: "Run it from source", href: "#get-started" },
  secondary: { label: "See how it works", href: "#how" },
} as const;

export const TRUTHS: Claim[] = [
  {
    text: "Local-first. A coworker is a folder of plain files under ~/.config/openwork/coworkers — identity, memory, and workspace you can open in any editor.",
    source: "apps/coworker/electron/coworkers.mjs (createCoworker, coworker.md, soul.md, memory/*)",
  },
  {
    text: "Native OpenWork threads. Every assignment is an ordinary OpenWork session in the coworker's workspace, driven by @openwork/headless-threads.",
    source: "apps/coworker/src/lib/threads.ts (createHeadlessThreadClient against /workspace/:id/opencode)",
  },
  {
    text: "Honest about where work runs. Local responsibilities run while the app is open; Cloud responsibilities run in OpenWork Cloud even when your Mac is off.",
    source: "apps/coworker/electron/local-responsibilities.mjs; apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations)",
  },
];

export const STEPS: Array<Claim & { title: string; caption: string }> = [
  {
    title: "Create",
    caption: "A name and a look.",
    text: "Pick a name, a color, and glasses. Role and mission are optional — the first assignment teaches the job. The coworker's folder and OpenWork workspace are created on the spot.",
    source: "apps/coworker/src/ui/new-coworker.tsx; apps/coworker/electron/main.mjs (coworkers.create registers /workspaces/local)",
  },
  {
    title: "Assign",
    caption: "Outcomes in your own words.",
    text: "One assignment becomes a durable thread. Tool steps appear as calm milestones, and the result reads like a receipt: what was made, where it lives.",
    source: "apps/coworker/src/ui/threads.tsx (WorkOverview, ThreadView, MessageBubble)",
  },
  {
    title: "Return",
    caption: "Know what happened at a glance.",
    text: "The team rail shows who is working, who is ready, and who needs you. The context rail names the thread it refers to and when memory last changed.",
    source: "apps/coworker/src/ui/coworker-rail.tsx; apps/coworker/src/lib/activity-summary.ts",
  },
];

export const MEMORY: { title: string; lead: string; files: Array<{ path: string; note: string }>; claims: Claim[] } = {
  title: "Memory you can read, edit, and diff.",
  lead:
    "No vector store, no hidden prompt history. A coworker keeps a small working memory it maintains itself, an index of long-term notes, and a stable soul — all Markdown, loaded on every turn by the OpenWork engine.",
  files: [
    { path: "soul.md", note: "who it is — loaded every turn" },
    { path: "memory/working.md", note: "active memory it edits while working" },
    { path: "memory/index.md", note: "map of long-term notes, loaded every turn" },
    { path: "memory/long-term/*.md", note: "durable notes, read when relevant" },
    { path: "workspace/", note: "deliverables and working files" },
    { path: "coworker.md", note: "app-owned settings: model, workspace id, avatar" },
  ],
  claims: [
    {
      text: "The coworker maintains memory/working.md as part of doing the work, and promotes durable facts into memory/long-term/ with a line in the index.",
      source: "apps/coworker/electron/coworkers.mjs (AGENTS.md contract: working and long-term memory duties)",
    },
    {
      text: "You can edit any memory file in the app; live-follow never replaces text you have not saved.",
      source: "apps/coworker/src/ui/memory.tsx",
    },
  ],
};

export const NEEDS_YOU: { title: string; lead: string; claims: Claim[] } = {
  title: "Human intervention is a resumable step.",
  lead:
    "When a coworker needs a permission — running a command, working outside its folder — or asks a question, the request appears inside the thread as a bounded card. Nothing happens until you choose. Deny ends the step; the coworker explains and continues.",
  claims: [
    {
      text: "Both OpenCode permission protocols and the question tool are handled; replies go through the protocol that issued the request.",
      source: "apps/coworker/src/lib/threads.ts (listThreadInteractions, replyPermission, replyQuestion)",
    },
    {
      text: "The rail, header, and recent-work rows all say “Needs you” ahead of “Working” while a thread waits on you.",
      source: "apps/coworker/src/lib/threads.ts (readActivity) and apps/coworker/src/ui/threads.tsx",
    },
  ],
};

export const RESPONSIBILITIES: {
  title: string;
  lead: string;
  placements: Array<{ name: string; badge: string; points: string[]; source: string }>;
} = {
  title: "Recurring work, with the placement said out loud.",
  lead:
    "A responsibility is a schedule the coworker owns. There are two places it can run, and the app never blurs them.",
  placements: [
    {
      name: "This Mac",
      badge: "Local",
      points: [
        "Runs through the local OpenWork engine while Open Coworker is open.",
        "Schedules reuse OpenWork's own occurrence rules and time zones.",
        "If a run is missed while the app is closed, the latest one is recovered on launch — never a backlog.",
        "Runs have full access to the coworker's folder and memory.",
      ],
      source: "apps/coworker/electron/local-responsibilities.mjs (@openwork/automations nextAutomationOccurrence)",
    },
    {
      name: "OpenWork Cloud",
      badge: "Always-on",
      points: [
        "Runs in OpenWork Cloud even when this Mac is off.",
        "Uses models your organization authorizes; run history lives in OpenWork.",
        "Cannot read this coworker's local files or memory — the app tells you so.",
        "Requires signing in to OpenWork Cloud.",
      ],
      source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations, GET /v1/llm-providers)",
    },
  ],
};

export const RETIRE: Claim & { title: string } = {
  title: "Retire without regret.",
  text: "Retiring moves the whole coworker folder to a Retired area and takes it off the roster. Nothing is deleted. Restore puts it back at the same path, so its threads reattach; permanent deletion is a separate, deliberate step.",
  source: "apps/coworker/electron/coworkers.mjs (retireCoworker, restoreCoworker, deleteRetiredCoworker)",
};

export const PLATFORM: { title: string; lead: string; items: Array<Claim & { name: string }> } = {
  title: "A second client on the OpenWork platform — not a second platform.",
  lead:
    "Open Coworker adds the coworker layer and nothing else. Everything underneath is the same OpenWork you can run on its own.",
  items: [
    {
      name: "Embedded OpenWork server",
      text: "The same openwork-server bundle the OpenWork desktop ships, with its own registry so both apps run side by side.",
      source: "apps/coworker/electron/main.mjs (startEmbeddedServer)",
    },
    {
      name: "OpenCode engine",
      text: "Turns run on the managed OpenCode engine with workspace-scoped tools and the provider catalog you configured in OpenWork.",
      source: "apps/coworker/src/lib/threads.ts (provider.list, connectedModelCatalog)",
    },
    {
      name: "Native sessions",
      text: "Threads are OpenWork sessions created and driven through @openwork/headless-threads.",
      source: "packages/headless-threads",
    },
    {
      name: "OpenWork Automations",
      text: "Cloud responsibilities are Den Automations; schedules, state, and run history stay in OpenWork.",
      source: "@openwork/types/automations; ee/apps/den-api /v1/cloud-automations",
    },
    {
      name: "Instruction files",
      text: "Identity and memory ride the engine's ordinary instruction loading — AGENTS.md plus opencode.json instructions.",
      source: "apps/coworker/electron/coworkers.mjs (opencodeConfigTemplate)",
    },
    {
      name: "Apps & tools",
      text: "MCP apps and tools configured for the engine are available to every coworker.",
      source: "apps/coworker/src/ui/capabilities.tsx",
    },
  ],
};

export const GET_STARTED: {
  title: string;
  lead: string;
  status: string;
  commands: string[];
  notes: Claim[];
} = {
  title: "Run it from source today.",
  lead:
    "Open Coworker lives in the OpenWork monorepo. Signed macOS builds are being prepared; until then, the development launcher is the way in.",
  status: "Early access · no packaged download yet",
  commands: [
    "git clone https://github.com/different-ai/openwork",
    "cd openwork && pnpm install",
    "pnpm --filter openwork-server build",
    "pnpm --filter @openwork/coworker dev",
  ],
  notes: [
    {
      text: "Works without an account: choose “Start locally” on first launch. Connect OpenWork Cloud later for Cloud responsibilities.",
      source: "apps/coworker/src/ui/onboarding.tsx",
    },
    {
      text: "The engine binary resolves from OPENWORK_OPENCODE_BIN or opencode on your PATH during development.",
      source: "apps/coworker/README.md",
    },
  ],
};

export const FOOTER = {
  links: [
    { label: "GitHub", href: SITE.repository },
    { label: "OpenWork", href: SITE.openwork },
    { label: "OpenWork docs", href: SITE.openworkDocs },
  ],
  poweredBy: "Powered by OpenWork",
} as const;

/** Every claim on the page, for the honesty test. */
export function allClaims(): Claim[] {
  return [
    ...TRUTHS,
    ...STEPS,
    ...MEMORY.claims,
    ...NEEDS_YOU.claims,
    ...RESPONSIBILITIES.placements.map((placement) => ({ text: placement.points.join(" "), source: placement.source })),
    RETIRE,
    ...PLATFORM.items,
    ...GET_STARTED.notes,
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
