/** Customer-facing copy. Claim sources remain in code for review. */
export type Claim = { text: string; source: string };
export const POWERED_BY = "Powered by OpenWork";

export const COWORKER = {
  name: "Open Coworker",
  path: "/coworker",
  download: "/coworker/download",
  repository: "https://github.com/different-ai/openwork",
  app: "https://github.com/different-ai/openwork/tree/feature/open-coworker/apps/coworker",
  releases: "https://github.com/different-ai/openwork/releases",
  // Den preserves the Models intent through authentication and onboarding.
  modelsSignUp: "https://app.openworklabs.com/?mode=sign-up&intent=models&utm_source=openworklabs&utm_medium=site&utm_campaign=coworker&utm_content=models",
  modelsSignIn: "https://app.openworklabs.com/?mode=sign-in&intent=models&utm_source=openworklabs&utm_medium=site&utm_campaign=coworker&utm_content=member",
  contactEmail: "team@openworklabs.com",
} as const;

const HERO_LINES = ["Your AI team.", "Built to work together."];

export const HERO = {
  eyebrow: "Introducing Open Coworker",
  title: HERO_LINES.join(" "),
  lines: HERO_LINES,
  lead: "Meet AI coworkers with their own roles, memory, and responsibilities. Start a conversation, build on their work, and bring your team together when you need another perspective.",
  source: "apps/coworker/electron/coworkers.mjs; apps/coworker/electron/collaboration.mjs; apps/coworker/src/ui/capabilities.tsx",
  primary: { label: "Download alpha", href: COWORKER.download },
  secondary: { label: "Try the demo", href: "#how" },
  strip: ["Free and open source", "Your choice of models", "Powered by OpenWork"],
} as const;

export const BENEFITS: Array<Claim & { title: string; name: string; role: string; example: string; preview: { label: string; title: string; detail: string } }> = [
  {
    title: "Keep the context. Not the repetition.",
    text: "Your coworker keeps working notes and long-term memories across discussions. Read what it remembers, change a detail, or undo a memory update.",
    name: "Scout", role: "Research",
    example: "Remember how we evaluate a good opportunity.",
    preview: { label: "Working memory", title: "Lead with the recommendation. Keep the sources.", detail: "Read · Edit · Review changes · Undo" },
    source: "apps/coworker/electron/self-memory.mjs; apps/coworker/src/ui/memory.tsx",
  },
  {
    title: "A document, not a wall of chat.",
    text: "Turn a conversation into a brief, a draft or a plan you can keep working on. Edit a section, compare revisions, and bring an earlier version back.",
    name: "Editor", role: "Writing",
    example: "Turn our discussion into a brief I can review.",
    preview: { label: "Launch brief", title: "A recommendation you can keep working on.", detail: "Edit a section · Compare versions · Restore" },
    source: "apps/coworker/electron/documents.mjs; apps/coworker/src/ui/documents.tsx",
  },
  {
    title: "Hand off the work. Keep talking.",
    text: "Let your coworker delegate a longer task to a background Worker while you stay in the conversation. Review its findings, steer the next step, and pick up the result.",
    name: "Ops", role: "Operations",
    example: "Research the alternatives while we work through the brief.",
    preview: { label: "Background Worker", title: "One goal: compare three alternatives.", detail: "Set a lifespan · Read findings · Steer · Pause" },
    source: "apps/coworker/electron/workers.mjs; apps/coworker/electron/collaboration.mjs; apps/coworker/src/ui/workers.tsx",
  },
];

export const STEPS: Array<Claim & { title: string }> = [
  { title: "Give it a role.", text: "Start with one coworker or shape a small team around your work. Choose what each one should help with.", source: "apps/coworker/src/ui/onboarding-team.tsx; apps/coworker/electron/team.mjs" },
  { title: "Bring the context.", text: "Share your notes, add the tools it needs, and hand over a concrete task. Keep the direction in your own words.", source: "apps/coworker/src/ui/threads.tsx; apps/coworker/src/ui/capabilities.tsx" },
  { title: "Build on the work.", text: "Review the result, keep what matters in memory, or make a useful task a recurring responsibility.", source: "apps/coworker/electron/documents.mjs; apps/coworker/electron/self-memory.mjs; apps/coworker/src/lib/local-schedule.ts" },
];

export const COLLABORATION: Claim = {
  text: "Ask Scout to investigate, Editor to challenge the draft, and Ops to turn it into next steps. Coworkers can consult each other and bring the answer back to the conversation where you asked.",
  source: "apps/coworker/electron/group-execution.mjs; apps/coworker/electron/collaboration.mjs; apps/coworker/src/ui/group-chat.tsx",
};

export const OPENWORK = {
  title: "Connect your tools. Put your team to work.",
  lead: {
    text: "OpenWork Connect brings your apps and shared skills into the conversation. Your coworkers can use the access you already have, follow your team’s methods, and turn useful tasks into recurring responsibilities.",
    source: "apps/coworker/src/App.tsx; apps/coworker/src/ui/capabilities.tsx; apps/coworker/src/lib/cloud-responsibilities.ts",
  },
  items: [
    {
      title: "Use the access you already have.",
      text: "Choose your own provider or the models available through your OpenWork account. No separate Coworker model subscription is required.",
      source: "apps/coworker/electron/local-providers.mjs; apps/coworker/src/ui/models-membership.tsx",
    },
    {
      title: "Bring your tools and know-how.",
      text: "Use the skills and connected apps available to your account. Open supported interactive app results beside the conversation.",
      source: "apps/coworker/src/ui/capabilities.tsx; apps/coworker/src/ui/mcp-app-frame.tsx",
    },
    {
      title: "Give your team a useful starting point.",
      text: "Prepare coworkers with reusable instructions and assign them through OpenWork. People receive their own working copies; updates preserve their personal memory.",
      source: "apps/coworker/electron/templates.mjs; ee/apps/den-api/src/routes/org/plugin-system/store.ts",
    },
  ],
  note: "Prepared-team delivery is an opt-in organization preview. Available models, skills and apps follow your account’s access.",
  cta: { label: "Explore OpenWork Connect", href: "/connect" },
};

type WorkExample = Claim & {
  id: string;
  label: string;
  inputs: string[];
  request: string;
  steps: Array<{ title: string; detail: string }>;
  result: string;
  scope: string;
};

export const WORK_EXAMPLES: WorkExample[] = [
  {
    id: "briefing",
    label: "Weekly briefing",
    text: "Bring email and calendar context into a regular briefing, using a shared skill for how your team likes to review the week.",
    inputs: ["Gmail", "Calendar", "Briefing skill"],
    request: "Every Monday, brief me on unread email and the week’s meetings. Link to the sources. Don’t send or change anything.",
    steps: [
      { title: "Connect the sources", detail: "Authorize the apps in OpenWork Connect. Your coworker uses the access available to your account." },
      { title: "Keep your way of working", detail: "Use a shared skill for the briefing format, what to prioritize, and what needs your attention." },
      { title: "Make it a responsibility", detail: "Choose a schedule and where it runs, then come back to the result and its run history." },
    ],
    result: "A weekly brief, ready to review.",
    scope: "Local schedules need the app open. Cloud schedules can run with your computer off, but cannot read your coworker’s local files or memory.",
    source: "apps/coworker/src/ui/capabilities.tsx; apps/coworker/src/lib/cloud-responsibilities.ts; apps/coworker/electron/local-responsibilities.mjs",
  },
  {
    id: "research",
    label: "Research & writing",
    text: "Bring a researcher and an editor around the same brief. Keep their perspectives distinct and the result in one place.",
    inputs: ["Drive", "Writing skill", "Scout + Editor"],
    request: "Compare these options against our brief. Ask Editor to challenge the recommendation, then bring me a draft here. Don’t publish it.",
    steps: [
      { title: "Start from your material", detail: "Use connected documents and your shared writing instructions instead of pasting the same context into every chat." },
      { title: "Bring in another perspective", detail: "Coworkers can consult each other visibly. Longer research can go to a Worker while you keep talking." },
      { title: "Return to the original discussion", detail: "Review the findings in context, open the document, and refine a section without losing earlier versions." },
    ],
    result: "One source-backed recommendation.",
    scope: "Local coworkers and Workers run while Open Coworker is open. This example asks for a draft to review, not an automatic send.",
    source: "apps/coworker/electron/group-execution.mjs; apps/coworker/electron/collaboration.mjs; apps/coworker/electron/workers.mjs; apps/coworker/electron/documents.mjs",
  },
  {
    id: "team",
    label: "Team starting setup",
    text: "Give people a useful starting AI team through the same OpenWork system that distributes shared skills and access.",
    inputs: ["Coworker profiles", "Shared skills", "Approved apps"],
    request: "Give our team a researcher and a writing partner, with our reusable instructions and the tools each person can access.",
    steps: [
      { title: "Prepare the starting team", detail: "Package coworker roles and reusable instructions alongside skills and connections in an OpenWork plugin." },
      { title: "Assign it to the right people", detail: "Use existing person, team and marketplace access. Coworkers can be added automatically or offered as an option." },
      { title: "Let each person make it their own", detail: "Each teammate receives a personal working copy. Later template updates preserve its memory and working instructions." },
    ],
    result: "A useful starting team for each teammate.",
    scope: "Prepared teams are an opt-in organization preview. Assignment does not start work, create schedules or copy personal memory.",
    source: "apps/coworker/electron/templates.mjs; packages/types/src/coworker-template.ts; ee/apps/den-api/src/routes/org/plugin-system/store.ts",
  },
];

export const MODELS = {
  title: "Your team. Your choice of models.",
  lead: { text: "Use your own provider, run a local model, or choose managed models through OpenWork. Give each coworker the model that fits its work.", source: "apps/coworker/electron/local-providers.mjs; apps/coworker/src/ui/new-coworker.tsx; apps/server/src/cloud-provider-sync.ts" },
  detail: "Explore the current models, included usage, and monthly membership.",
  cta: { label: "Explore OpenWork Models", href: COWORKER.modelsSignUp },
  member: { label: "Already a member? Sign in", href: COWORKER.modelsSignIn },
  note: "Models membership is optional. It does not grant early access to Open Coworker.",
} as const;

export const FAQ: Array<Claim & { question: string }> = [
  { question: "Is Open Coworker free?", text: "Open Coworker is free and open source. Start locally without an account, using an available free model or your own provider. OpenWork Models is an optional paid membership with its own usage allowances.", source: "apps/coworker/src/ui/onboarding.tsx; ee/apps/den-api/src/routes/org/inference.ts" },
  { question: "Does it work while my computer is off?", text: "Local conversations and workers run while Open Coworker is open. Scheduled responsibilities assigned to OpenWork Cloud can run while your computer is off. Those Cloud runs cannot read your coworker's local files or memory today.", source: "apps/coworker/src/lib/cloud-responsibilities.ts; apps/coworker/electron/local-responsibilities.mjs" },
  { question: "Can I choose what it remembers?", text: "Yes. You can read and edit your coworker's memory, review changes, and undo them. Its notes and documents live in files you can open.", source: "apps/coworker/src/ui/memory.tsx; apps/coworker/electron/self-memory.mjs" },
  { question: "How does it fit with OpenWork?", text: "Open Coworker is the coworker-focused app on the OpenWork platform. Sign in with your existing account to use the models, shared skills and connected apps available to you. Your coworkers use native OpenWork workspaces and conversations, not a separate platform.", source: "apps/coworker/src/App.tsx; apps/coworker/src/ui/capabilities.tsx; packages/headless-threads" },
  { question: "Can I share a coworker with my team?", text: "Share a template containing a starting profile and reusable instructions. Each person gets their own coworker, without your conversations, documents, credentials or personal memory. Organization-wide prepared-team delivery is an opt-in preview.", source: "apps/coworker/electron/templates.mjs; packages/types/src/coworker-template.ts" },
  { question: "Is computer use available in the download?", text: "Computer use remains experimental and native verification is incomplete. This walkthrough is an illustration for macOS 14+: opt in for a private discussion, then approve one app window. Take over, continue or revoke access yourself. Remote computers, groups, Workers and schedules do not get this access.", source: "apps/coworker/COMPUTER-CONTROL.md (computer-control development candidate)" },
];

export const GET_STARTED = {
  title: "Give your next task a coworker.",
  status: "Public alpha · Apple Silicon Mac · Signed and notarized",
  lead: "Start with a researcher, a writing partner or someone to keep recurring work moving. Try the macOS alpha, or build Open Coworker from source.",
} as const;

export const NOTIFY = {
  email: { label: "Email for early access", href: "mailto:team@openworklabs.com?subject=Open%20Coworker%20early%20access" },
  releases: { label: "Follow releases", href: COWORKER.releases },
} as const;

export function allClaims(): Claim[] {
  return [{ text: HERO.lead, source: HERO.source }, ...BENEFITS, ...STEPS, COLLABORATION, OPENWORK.lead, ...OPENWORK.items, ...WORK_EXAMPLES, MODELS.lead, ...FAQ];
}

export const FORBIDDEN_PHRASES = [
  "download for mac", "never fails", "fully autonomous", "unlimited",
  "$100", "first 50", "24 hours", "funded by openai",
] as const;
