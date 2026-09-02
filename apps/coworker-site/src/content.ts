/**
 * All site copy lives here, and every product claim carries the place in the
 * product where it is true. The test in content.test.ts refuses claims without
 * a source, so the site can only say what the app does today. Statements about
 * what comes next are a separate, labeled kind (`planned`) sourced to the
 * product plan, and must read as "next", never as shipped.
 */

export type Claim = {
  text: string;
  /** Where in the product this is true: a file path, route, or contract name. */
  source: string;
  /** Roadmap statements must say so in their own words. */
  planned?: true;
};

export const SITE = {
  name: "Open Coworker",
  tagline: "Give recurring work a teammate.",
  description:
    "Open Coworker is a quiet home for AI coworkers who remember. Give each one a name, a role, and real work — and know exactly what happened when you come back. Local-first on your Mac, built on OpenWork.",
  url: "https://opencoworker.app",
  repository: "https://github.com/different-ai/openwork",
  releases: "https://github.com/different-ai/openwork/releases",
  openwork: "https://openworklabs.com",
  pricing: "https://openworklabs.com/pricing",
  enterprise: "https://openworklabs.com/enterprise",
  /** OpenWork Cloud sign-up, attributed so Cloud signups from this site can be counted. */
  cloudSignUp: "https://app.openworklabs.com?mode=sign-up&utm_source=opencoworker&utm_medium=site&utm_campaign=cloud",
  contactEmail: "team@openworklabs.com",
  company: "Different AI",
  year: 2026,
} as const;

export const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#memory", label: "Memory" },
  { href: "#responsibilities", label: "Responsibilities" },
  { href: "#cloud", label: "Cloud" },
] as const;

export const HERO = {
  eyebrow: "Early access · macOS",
  title: "Give recurring work a teammate.",
  lead:
    "A quiet home for AI coworkers who remember. Give each one a name, a role, and real work — and know exactly what happened when you come back.",
  primary: { label: "Run from source", href: "#get-started" },
  secondary: { label: "How it works", href: "#how" },
  /** Three short phrases, one line, no cards. */
  strip: ["Memory you can read", "Native OpenWork threads", "Built on OpenWork, cloud included"],
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
      name: "OpenWork Cloud",
      badge: "Always-on",
      points: [
        "Runs in OpenWork Cloud even when your Mac is off.",
        "Uses models your organization authorizes; run history lives in OpenWork.",
        "Cannot read the coworker's local files or memory today — the app says so.",
      ],
      source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations, GET /v1/llm-providers)",
    },
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
  ],
  retire: {
    text: "Retiring moves the whole folder to a Retired area; nothing is deleted. Restore brings it back with its threads. Permanent deletion is a separate, deliberate step.",
    source: "apps/coworker/electron/coworkers.mjs (retireCoworker, restoreCoworker, deleteRetiredCoworker)",
  },
};

export const PLATFORM: { title: string; lead: string; items: Array<Claim & { name: string }> } = {
  title: "Built on OpenWork, not beside it.",
  lead: "Open Coworker adds the coworker layer and nothing else. Everything underneath is OpenWork, which is what lets it grow into OpenWork Cloud without becoming a different product.",
  items: [
    { name: "Server", text: "The same embedded openwork-server the OpenWork desktop ships.", source: "apps/coworker/electron/main.mjs (startEmbeddedServer)" },
    { name: "Engine", text: "Managed OpenCode with the providers you connected in OpenWork.", source: "apps/coworker/src/lib/threads.ts (provider.list, connectedModelCatalog)" },
    { name: "Threads", text: "Native sessions through @openwork/headless-threads.", source: "packages/headless-threads" },
    { name: "Automations", text: "Cloud responsibilities are OpenWork Automations.", source: "@openwork/types/automations; ee/apps/den-api /v1/cloud-automations" },
    { name: "Instructions", text: "Identity and memory ride the engine's own instruction loading.", source: "apps/coworker/electron/coworkers.mjs (opencodeConfigTemplate)" },
    { name: "Apps & tools", text: "MCP apps and tools configured for the engine, available to every coworker.", source: "apps/coworker/src/ui/capabilities.tsx" },
  ],
};

/**
 * The revenue path. Open Coworker is free and open source; OpenWork Cloud is
 * the paid platform underneath it. Everything here points at real OpenWork
 * destinations — nothing is sold from this page directly, and nothing
 * unshipped is sold at all.
 */
export const CLOUD: {
  title: string;
  lead: string;
  local: { name: string; badge: string; points: Claim[]; cta: { label: string; href: string } };
  cloud: { name: string; badge: string; price: Claim; points: Claim[]; cta: { label: string; href: string }; secondary: { label: string; href: string } };
  direction: Claim;
  teams: { text: string; cta: { label: string; href: string } };
} = {
  title: "Free on your Mac. OpenWork Cloud when work must keep going.",
  lead:
    "Open Coworker is open source and costs nothing. Sign in to OpenWork Cloud and a coworker's responsibilities can run there even when your Mac is off — with the models your organization authorizes.",
  local: {
    name: "Open Coworker",
    badge: "Free · open source",
    points: [
      {
        text: "Coworkers, memory, and threads on your Mac, with the providers you configure. No account required.",
        source: "apps/coworker/src/ui/onboarding.tsx (Start locally); apps/coworker/README.md",
      },
      {
        text: "Local responsibilities while the app is open; one missed run recovered on launch.",
        source: "apps/coworker/electron/local-responsibilities.mjs",
      },
    ],
    cta: { label: "Run from source", href: "#get-started" },
  },
  cloud: {
    name: "With OpenWork Cloud",
    badge: "Recommended for recurring work",
    price: {
      text: "Free for up to 5 users · Team and Enterprise plans",
      source: "ee/apps/landing/app/pricing/page.tsx (metadata title: Free up to 5 users, $20 Team, $50 Enterprise)",
    },
    points: [
      {
        text: "Responsibilities that run in OpenWork Cloud even when your Mac is off.",
        source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations)",
      },
      {
        text: "Models your organization authorizes for those runs, with run history kept in OpenWork.",
        source: "apps/coworker/src/lib/cloud-responsibilities.ts (GET /v1/llm-providers); @openwork/types/automations (latestRun)",
      },
      {
        text: "Sign in from the app: open OpenWork sign-in, copy the link it shows, paste it back.",
        source: "apps/coworker/src/ui/sign-in.tsx",
      },
    ],
    cta: { label: "Create a free OpenWork Cloud account", href: SITE.cloudSignUp },
    secondary: { label: "See plans", href: SITE.pricing },
  },
  direction: {
    text: "Because everything underneath is OpenWork, the same coworkers can grow into OpenWork Cloud over time. That is the direction we are building toward; today the app is where they live.",
    source: "plans/open-coworker-persistent-workers-app.md (Phase 3: cloud execution)",
    planned: true,
  },
  teams: {
    text: "Rolling coworkers out to a team? OpenWork Enterprise covers provisioning, policies, and support.",
    cta: { label: "Talk to OpenWork", href: SITE.enterprise },
  },
};

/** Agents install software now. Give them a document, not a marketing page. */
export const AGENT = {
  title: "Or hand this page to your agent.",
  text:
    "Open Coworker ships a plain-text start guide written for agents: prerequisites, the exact commands, the first-run choices, and how to verify the coworker's files. Paste the prompt into the agent you already use.",
  promptTemplate: (startUrl: string) =>
    `Set up Open Coworker for me. Fetch ${startUrl} and follow it step by step. Ask me before installing anything, choose "Start locally" unless I say otherwise, and finish by showing me the coworker's folder.`,
  links: [
    { label: "start.md", href: "/start.md", note: "the agent start guide" },
    { label: "llms.txt", href: "/llms.txt", note: "product facts for language models" },
  ],
} as const;

export const GET_STARTED: { title: string; lead: Claim; status: string; commands: string[] } = {
  title: "Run it from source today.",
  lead: {
    text:
      "Open Coworker lives in the OpenWork monorepo. It works without an account — choose “Start locally” on first launch and connect OpenWork Cloud whenever you want always-on responsibilities. Packaged builds are in preparation; this page will link them the day they exist.",
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

/** No mailing list exists yet; these are the two real ways to hear about the cloud opening and signed builds. */
export const NOTIFY = {
  title: "Hear about signed builds and what comes next",
  releases: { label: "Watch releases on GitHub", href: SITE.releases },
  email: {
    label: "Email us for early access",
    href: `mailto:${SITE.contactEmail}?subject=${encodeURIComponent("Open Coworker early access")}`,
  },
} as const;

export const FOOTER = {
  links: [
    { label: "GitHub", href: SITE.repository },
    { label: "OpenWork", href: SITE.openwork },
    { label: "Pricing", href: SITE.pricing },
    { label: "start.md", href: "/start.md" },
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
    ...CLOUD.local.points,
    CLOUD.cloud.price,
    ...CLOUD.cloud.points,
    CLOUD.direction,
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
  "available in the cloud today",
  "coworkers run in the cloud today",
] as const;
