/** Customer-facing copy. Claim sources remain in code for review. */
export type Claim = { text: string; source: string };
export const POWERED_BY = "Powered by OpenWork";

export const COWORKER = {
  name: "Open Coworker",
  path: "/coworker",
  repository: "https://github.com/different-ai/openwork",
  app: "https://github.com/different-ai/openwork/tree/feature/open-coworker/apps/coworker",
  releases: "https://github.com/different-ai/openwork/releases",
  // Den preserves the Models intent through authentication and onboarding.
  modelsSignUp: "https://app.openworklabs.com/?mode=sign-up&intent=models&utm_source=openworklabs&utm_medium=site&utm_campaign=coworker&utm_content=models",
  modelsSignIn: "https://app.openworklabs.com/?mode=sign-in&intent=models&utm_source=openworklabs&utm_medium=site&utm_campaign=coworker&utm_content=member",
  contactEmail: "team@openworklabs.com",
} as const;

export const HERO = {
  eyebrow: "Introducing Open Coworker",
  title: "Your work. Better together.",
  lead: "Meet your AI coworkers. A little help with the research, the first draft, and whatever comes next.",
  primary: { label: "Get early access", href: "#get-started" },
  secondary: { label: "Try the demo", href: "#how" },
  strip: ["Free and open source", "Your choice of models", "Powered by OpenWork"],
} as const;

export const BENEFITS: Array<Claim & { title: string; name: string; role: string; example: string }> = [
  {
    title: "Think it through together.",
    text: "Explore an idea, compare your options, and get another perspective when you need one.",
    name: "Scout", role: "Research",
    example: "Compare these three options and recommend one.",
    source: "apps/coworker/src/ui/threads.tsx; apps/coworker/src/lib/documents.ts",
  },
  {
    title: "Start from something.",
    text: "Hand over your notes. Get a first draft back. Find the right words together.",
    name: "Editor", role: "Writing",
    example: "Turn these notes into a clear first draft.",
    source: "apps/coworker/src/ui/assignments.tsx; apps/coworker/src/lib/documents.ts; apps/coworker/src/lib/local-schedule.ts",
  },
  {
    title: "Make room for what’s next.",
    text: "Give a recurring task to your coworker, connect the tools it needs, and review the work as it takes shape.",
    name: "Ops", role: "Operations",
    example: "Help me turn this weekly task into a routine.",
    source: "apps/coworker/src/lib/connect.ts; apps/coworker/src/ui/assignments.tsx; apps/coworker/src/lib/local-schedule.ts",
  },
];

export const STEPS: Array<Claim & { title: string }> = [
  { title: "Meet your team.", text: "Start with one coworker. Give it a name, a role, and a place in your day.", source: "apps/coworker/src/ui/onboarding-team.tsx; apps/coworker/electron/team.mjs" },
  { title: "Give it a starting point.", text: "An idea, a few notes, or a task you want help with. Start the conversation.", source: "apps/coworker/src/ui/threads.tsx; apps/coworker/src/ui/assignments.tsx" },
  { title: "Keep things moving.", text: "Review a draft, add a thought, or set the next task. You shape what happens next.", source: "apps/coworker/src/ui/threads.tsx; apps/coworker/electron/documents.mjs" },
];

export const MODELS = {
  title: "Choose the models behind your coworker.",
  lead: { text: "OpenWork Models brings managed AI models into the same place as your coworkers and your work.", source: "apps/server/src/cloud-provider-sync.ts; ee/apps/den-api/src/routes/org/inference.ts" },
  detail: "Explore the current models, included usage, and monthly membership.",
  cta: { label: "Explore OpenWork Models", href: COWORKER.modelsSignUp },
  member: { label: "Already a member? Sign in", href: COWORKER.modelsSignIn },
  note: "Models membership is optional. It does not grant early access to Open Coworker.",
} as const;

export const FAQ: Array<Claim & { question: string }> = [
  { question: "Is Open Coworker free?", text: "Open Coworker is free and open source. Start locally without an account, using an available free model or your own provider. OpenWork Models is an optional paid membership with its own usage allowances.", source: "apps/coworker/src/ui/onboarding.tsx; ee/apps/den-api/src/routes/org/inference.ts" },
  { question: "Does it work while my computer is off?", text: "Local conversations and workers run while Open Coworker is open. Scheduled responsibilities assigned to OpenWork Cloud can run while your computer is off. Those Cloud runs cannot read your coworker's local files or memory today.", source: "apps/coworker/src/lib/cloud-responsibilities.ts; apps/coworker/electron/local-responsibilities.mjs" },
  { question: "Can I choose what it remembers?", text: "Yes. You can read and edit your coworker's memory, review changes, and undo them. Its notes and documents live in files you can open.", source: "apps/coworker/src/ui/memory.tsx; apps/coworker/electron/self-memory.mjs" },
  { question: "How does it fit with OpenWork?", text: "Open Coworker is a new way to work with the OpenWork platform. OpenWork Desktop, Connect, and your organization's available models remain part of the same platform.", source: "apps/coworker/README.md; packages/headless-threads" },
];

export const GET_STARTED = {
  title: "Meet your next coworker.",
  status: "Early access · macOS",
  lead: "Ask us about early access. If you prefer to build it yourself, Open Coworker is available from source.",
} as const;

export const NOTIFY = {
  email: { label: "Email for early access", href: "mailto:team@openworklabs.com?subject=Open%20Coworker%20early%20access" },
  releases: { label: "Follow releases", href: COWORKER.releases },
} as const;

export function allClaims(): Claim[] {
  return [...BENEFITS, ...STEPS, MODELS.lead, ...FAQ];
}

export const FORBIDDEN_PHRASES = [
  "download for mac", "never fails", "fully autonomous", "unlimited",
  "$100", "first 50", "24 hours", "funded by openai",
] as const;
