/**
 * Everything /coworker says, in one place. Open Coworker is marketed as the
 * coworker layer of OpenWork — a complement, not a second product — so the
 * page leans on the same platform, Cloud, and Enterprise the rest of the site
 * sells. Every product claim carries the place in the product where it is
 * true; `test/coworker-content.test.ts` refuses claims without a source, copy
 * the product cannot back, and roadmap statements that read as shipped.
 */

export type Claim = {
  text: string;
  /** Where in the product this is true: a file path, route, or contract name. */
  source: string;
  /** Roadmap statements say so in their own words. */
  planned?: true;
};

export const COWORKER = {
  name: "Open Coworker",
  eyebrow: "Open Coworker · the coworker layer of OpenWork",
  path: "/coworker",
  repository: "https://github.com/different-ai/openwork",
  app: "https://github.com/different-ai/openwork/tree/dev/apps/coworker",
  releases: "https://github.com/different-ai/openwork/releases",
  /** OpenWork Cloud sign-up, attributed so Cloud sign-ups from this page can be counted. */
  cloudSignUp: "https://app.openworklabs.com?mode=sign-up&utm_source=openworklabs&utm_medium=site&utm_campaign=coworker",
  contactEmail: "team@openworklabs.com",
} as const;

export const HERO = {
  title: ["Give recurring work", "a teammate."],
  lead:
    "OpenWork is where you do work with AI on your own files. Open Coworker is the same platform, shaped around people: a small team of coworkers who remember, own responsibilities, and tell you plainly what happened while you were away.",
  aside: "Local-first on your Mac. Built on OpenWork, so OpenWork Cloud, Connect, and your organization's models come along.",
  primary: { label: "Run from source", href: "#get-started" },
  secondary: { label: "How it fits with OpenWork", href: "#with-openwork" },
  /** Three short phrases, one line, no cards. */
  strip: ["Memory you can read", "Native OpenWork threads", "Free and open source"],
} as const;

/** How Open Coworker complements OpenWork, in one honest table. */
export const WITH_OPENWORK: {
  title: string;
  lead: string;
  rows: Array<{ ask: string; openwork: string; coworker: string; source: string }>;
} = {
  title: "Same platform. A different front door.",
  lead:
    "OpenWork Desktop is a workbench: sessions, workspaces, skills, and tools for people who want to see the work. Open Coworker is the same engine, server, threads, and Connect gateway behind a team you talk to. Pick by how you like to work; nothing is duplicated underneath.",
  rows: [
    {
      ask: "What you open",
      openwork: "A workspace of files and sessions.",
      coworker: "A coworker with a name, a role, and a mission.",
      source: "apps/coworker/src/ui/coworker-rail.tsx; apps/coworker/electron/coworkers.mjs",
    },
    {
      ask: "Where the work lives",
      openwork: "Native OpenWork sessions in a workspace.",
      coworker: "The same native sessions — a thread made here opens in OpenWork unchanged.",
      source: "packages/headless-threads; apps/coworker/src/lib/threads.ts",
    },
    {
      ask: "What it remembers",
      openwork: "What you keep in the workspace and its instructions.",
      coworker: "A soul, a working memory, and long-term notes it maintains itself — plain Markdown, loaded every turn.",
      source: "apps/coworker/electron/coworkers.mjs (AGENTS.md contract, opencode.json instructions); apps/coworker/electron/self-memory.mjs",
    },
    {
      ask: "Your tools and Connect",
      openwork: "Skills, MCP servers, and OpenWork Connect per workspace.",
      coworker: "The same engine configuration, plus Connect registered in every coworker after one sign-in.",
      source: "apps/coworker/README.md (Skills and MCP; Signing in also brings OpenWork Connect)",
    },
    {
      ask: "Always-on work",
      openwork: "OpenWork Automations in Cloud or on the desktop runner.",
      coworker: "A coworker's scheduled assignments are OpenWork Automations in Cloud, or local runs while the app is open.",
      source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations); apps/coworker/electron/local-responsibilities.mjs",
    },
  ],
};

export const STEPS: Array<Claim & { title: string }> = [
  {
    title: "Meet your team",
    text: "Say what you need help with and Open Coworker proposes two or three coworkers to meet, rename, and create in one step — or start with one.",
    source: "apps/coworker/src/ui/onboarding-intents.tsx; apps/coworker/src/ui/onboarding-team.tsx; apps/coworker/electron/team.mjs (recommendTeam)",
  },
  {
    title: "Talk it through",
    text: "A discussion reads like messages with a colleague: the point first, work folded into one small line between bubbles, and a document when the answer needs more room.",
    source: "apps/coworker/src/ui/threads.tsx (conversationBlocks, ActionLine); apps/coworker/src/lib/documents.ts",
  },
  {
    title: "Hand work over",
    text: "Turn a clear outcome into an assignment the coworker owns, put it on a schedule, or let it run a Worker for a longer goal — and read the receipt when you come back.",
    source: "apps/coworker/src/ui/assignments.tsx; apps/coworker/src/lib/local-schedule.ts; apps/coworker/electron/workers.mjs",
  },
];

export const MEMORY: { title: string; lead: Claim; files: Array<{ path: string; note: string }> } = {
  title: "Memory you can read.",
  lead: {
    text:
      "No vector store, no hidden prompt history. Each coworker keeps a stable soul, a small working memory it curates itself, and an index of long-term notes — all Markdown in one folder, loaded on every turn, editable by you, every change listed and undoable.",
    source: "apps/coworker/electron/coworkers.mjs; apps/coworker/electron/self-memory.mjs (memory/changes.jsonl, undo); apps/coworker/src/ui/memory.tsx",
  },
  files: [
    { path: "soul.md", note: "who it is" },
    { path: "memory/working.md", note: "what it is carrying right now" },
    { path: "memory/index.md", note: "what it knows it can look up" },
    { path: "memory/long-term/*.md", note: "durable notes, read when relevant" },
    { path: "documents/", note: "what it wrote for you" },
    { path: "team/roster.md", note: "who its teammates are" },
  ],
};

export const TEAM: { title: string; lead: Claim; points: Claim[] } = {
  title: "A team, not a tool.",
  lead: {
    text:
      "Coworkers know each other. One can offer to pass a request to a teammate who fits it better, or propose a new teammate — and your tap is the only thing that acts. Several can answer in one group chat, one after the other, each with its own memory and tools.",
    source: "apps/coworker/electron/team-tools.mjs (team_refer, team_suggest); apps/coworker/src/ui/group-chat.tsx; apps/coworker/src/lib/facilitator.ts",
  },
  points: [
    {
      text: "Group chats route the question to the right coworkers; a silent facilitator picks who speaks and in what order, with a deterministic fallback.",
      source: "apps/coworker/src/lib/facilitator.ts; apps/coworker/src/lib/groups.ts",
    },
    {
      text: "Workers are long-lived helpers a coworker runs for one goal, in bounded turns, reporting findings that wake the coworker in your discussion.",
      source: "apps/coworker/electron/workers.mjs; apps/coworker/README.md (Workers)",
    },
    {
      text: "When something needs you — a permission, a question, a reply that did not come — it is one small line or one lettered card in the conversation, never a wall of red.",
      source: "apps/coworker/src/ui/interactions.tsx; apps/coworker/src/lib/turn-outcome.ts",
    },
  ],
};

export const PLACEMENTS: {
  title: string;
  lead: string;
  items: Array<{ name: string; badge: string; points: string[]; source: string }>;
} = {
  title: "Recurring work, with the placement said out loud.",
  lead: "A scheduled assignment runs in one of two places, and the app never blurs which.",
  items: [
    {
      name: "OpenWork Cloud",
      badge: "Always-on",
      points: [
        "Runs in OpenWork Cloud even when your Mac is off, as a native OpenWork Automation.",
        "Uses models your organization authorizes; run history lives in OpenWork.",
        "Cannot read the coworker's local files or memory today — the app says so.",
      ],
      source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations, GET /v1/llm-providers)",
    },
    {
      name: "This Mac",
      badge: "Local",
      points: [
        "Runs through the local OpenWork engine while Open Coworker is open, with full access to the coworker's folder and memory.",
        "Daily, weekly, every few hours, or a custom timetable, with a minimum gap and a daily cap as guardrails.",
        "A run missed while the app was closed is recovered once on launch — never a backlog.",
      ],
      source: "apps/coworker/electron/local-responsibilities.mjs; apps/coworker/src/lib/local-schedule.ts",
    },
  ],
};

/**
 * The revenue path. Open Coworker is free and open source; OpenWork Cloud is
 * the paid platform underneath it, and Enterprise is the team rollout.
 * Nothing unshipped is sold.
 */
export const CLOUD: {
  title: string;
  lead: string;
  free: { name: string; badge: string; points: Claim[]; cta: { label: string; href: string } };
  cloud: { name: string; badge: string; price: Claim; points: Claim[]; cta: { label: string; href: string }; secondary: { label: string; href: string } };
  direction: Claim;
  teams: { text: string; cta: { label: string; href: string } };
} = {
  title: "Free on your Mac. OpenWork Cloud when work must keep going.",
  lead:
    "Open Coworker costs nothing and needs no account. Sign in to OpenWork Cloud and a coworker's scheduled assignments can run there even when your Mac is off, on the models your organization authorizes — the same Cloud the rest of OpenWork uses.",
  free: {
    name: "Open Coworker",
    badge: "Free · open source",
    points: [
      {
        text: "Coworkers, memory, discussions, documents, and Workers on your Mac, with what this Mac already has: a Codex or Claude Code sign-in, Copilot, keys in your environment, Ollama or LM Studio — or the free model, ready at once.",
        source: "apps/coworker/src/ui/local-providers.tsx; apps/coworker/electron/local-providers.mjs; apps/coworker/README.md (Local mode)",
      },
      {
        text: "Local scheduled assignments while the app is open; one missed run recovered on launch.",
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
      source: "ee/apps/landing/app/pricing/page.tsx",
    },
    points: [
      {
        text: "Scheduled assignments that run in OpenWork Cloud even when your Mac is off.",
        source: "apps/coworker/src/lib/cloud-responsibilities.ts (POST /v1/cloud-automations)",
      },
      {
        text: "OpenWork Connect in every coworker: your organization's apps, skills, and connections, from one sign-in.",
        source: "apps/coworker/README.md (Signing in also brings OpenWork Connect); ee/apps/den-api /v1/mcp/token",
      },
      {
        text: "Sign in from the app: open OpenWork sign-in, copy the link it shows, paste it back.",
        source: "apps/coworker/src/ui/sign-in.tsx",
      },
    ],
    cta: { label: "Create a free OpenWork Cloud account", href: COWORKER.cloudSignUp },
    secondary: { label: "See plans", href: "/pricing" },
  },
  direction: {
    text: "Because everything underneath is OpenWork, the same coworkers can grow into OpenWork Cloud over time — hosted coworkers with their memory beside them. That is the direction we are building toward; today a coworker lives on your Mac.",
    source: "plans/open-coworker-persistent-workers-app.md (Phase 3: cloud execution)",
    planned: true,
  },
  teams: {
    text: "Rolling coworkers out to a team? OpenWork Enterprise covers provisioning, desktop policies, and support.",
    cta: { label: "Talk to us", href: "/enterprise" },
  },
};

/** Agents install software now. Give them a document, not a marketing page. */
export const AGENT = {
  title: "Or hand this page to your agent.",
  text:
    "Open Coworker ships a plain-text start guide written for agents: prerequisites, the exact commands, the first-run choices, and how to verify the coworker's files. Paste the prompt into the agent you already use.",
  promptTemplate: (startUrl: string) =>
    `Set up Open Coworker for me. Fetch ${startUrl} and follow it step by step. Ask me before installing anything, choose "Use this Mac" unless I say otherwise, and finish by showing me the coworker's folder.`,
  links: [
    { label: "start.md", href: "/coworker/start.md", note: "the agent start guide" },
    { label: "llms.txt", href: "/llms.txt", note: "product facts for language models" },
  ],
} as const;

export const GET_STARTED: { title: string; lead: Claim; status: string; commands: string[] } = {
  title: "Run it from source today.",
  lead: {
    text:
      "Open Coworker lives in the OpenWork monorepo. It works without an account — choose “Use this Mac” on first launch and connect OpenWork Cloud whenever you want always-on assignments. Signed builds are in preparation; this page will link them the day they exist.",
    source: "apps/coworker/src/ui/onboarding.tsx; apps/coworker/README.md (Review / develop)",
  },
  status: "Early access · macOS · no signed download yet",
  commands: [
    "git clone https://github.com/different-ai/openwork",
    "cd openwork && pnpm install",
    "pnpm --filter openwork-server build",
    "pnpm --filter @openwork/coworker dev",
  ],
};

/** No mailing list exists; these are the two real ways to hear about signed builds. */
export const NOTIFY = {
  releases: { label: "Watch releases on GitHub", href: COWORKER.releases },
  email: {
    label: "Email us for early access",
    href: `mailto:${COWORKER.contactEmail}?subject=${encodeURIComponent("Open Coworker early access")}`,
  },
} as const;

/** Every claim on the page, for the honesty test and the footnote. */
export function allClaims(): Claim[] {
  return [
    ...WITH_OPENWORK.rows.map((row) => ({ text: `${row.openwork} ${row.coworker}`, source: row.source })),
    ...STEPS,
    MEMORY.lead,
    TEAM.lead,
    ...TEAM.points,
    ...PLACEMENTS.items.map((item) => ({ text: item.points.join(" "), source: item.source })),
    ...CLOUD.free.points,
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
  "replaces openwork",
  "instead of openwork",
] as const;
