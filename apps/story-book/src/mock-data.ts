import type { WorkspaceInfo } from "../../app/src/app/lib/tauri";

export type StoryScreen = "session" | "settings" | "components" | "onboarding";

export type StoryStep = {
  label: string;
  detail: string;
  state: "done" | "active" | "queued";
};

export type StoryMessage = {
  role: "user" | "assistant";
  title: string;
  detail: string;
  body: string[];
  steps?: StoryStep[];
  tags?: string[];
};

export const storyWorkspaces: WorkspaceInfo[] = [
  {
    id: "local-foundation",
    name: "Local Foundation",
    displayName: "OpenWork App",
    path: "~/OpenWork/app",
    preset: "starter",
    workspaceType: "local",
  },
  {
    id: "remote-worker",
    name: "Remote Worker",
    displayName: "Ops Worker",
    path: "remote://ops-worker",
    preset: "automation",
    workspaceType: "remote",
    remoteType: "openwork",
    baseUrl: "https://worker.openworklabs.com/opencode",
    openworkHostUrl: "https://worker.openworklabs.com",
    openworkWorkspaceName: "Ops Worker",
    sandboxBackend: "docker",
    sandboxContainerName: "openwork-ops-worker",
  },
];

export const sessionList = [
  { title: "Refresh den cloud worker states", meta: "6m ago", active: true },
  { title: "Polish mobile workspace connect flow", meta: "31m ago", active: false },
  { title: "Audit scheduler screenshots", meta: "Yesterday", active: false },
  { title: "Tighten status copy in settings", meta: "Yesterday", active: false },
];

export const progressItems = [
  { label: "Connect provider", done: true },
  { label: "Review shell layout", done: true },
  { label: "Mock key session states", done: false },
  { label: "Capture PR screenshots", done: false },
];

export const sessionMessages: StoryMessage[] = [
  {
    role: "user",
    title: "Prompt",
    detail: "Design review",
    body: [
      "Build a faithful story-book for the OpenWork app so we can iterate on the shell, session timeline, settings cards, and onboarding without touching the live runtime.",
    ],
    tags: ["/design-review", "@openwork", "3 surfaces"],
  },
  {
    role: "assistant",
    title: "OpenWork",
    detail: "Core shell recreation",
    body: [
      "The story-book should preserve the current app DNA: restrained chrome, pale shell surfaces, dense operational cards, and a strong bottom status rail.",
      "I recreated the main session surface with mock workspaces, timeline steps, artifacts, and a composer so design changes can happen in one isolated place.",
    ],
    steps: [
      {
        label: "Audit current shell",
        detail: "left rail widths, center reading column, right utility rail",
        state: "done",
      },
      {
        label: "Rebuild with mocked data",
        detail: "session transcript, queue state, artifacts, composer",
        state: "done",
      },
      {
        label: "Layer design states",
        detail: "settings, onboarding, component primitives",
        state: "active",
      },
    ],
    tags: ["Session", "Mocked data", "Operational UI"],
  },
  {
    role: "assistant",
    title: "Artifacts",
    detail: "Design deliverables",
    body: [
      "The gallery keeps the real tokens and primitive buttons from apps/app, but swaps runtime state for stable mocked snapshots.",
    ],
    steps: [
      {
        label: "Token fidelity",
        detail: "shared colors, typography, radii, shadows",
        state: "done",
      },
      {
        label: "Scenario coverage",
        detail: "session, settings, components, onboarding",
        state: "queued",
      },
    ],
    tags: ["Design system", "Reusable shell"],
  },
];

export const artifactItems = [
  { title: "Session shell", detail: "Primary flow with activity, tools, and composer" },
  { title: "Settings cards", detail: "Runtime, provider, and update states" },
  { title: "Onboarding canvas", detail: "First-run decisions and worker connect" },
  { title: "Primitive kit", detail: "Buttons, chips, inputs, and status rail" },
];

export const settingsTabs = ["General", "Cloud", "Model", "Advanced", "Debug"] as const;

export const settingsCards = [
  {
    title: "Runtime",
    eyebrow: "Core services",
    body: "Status for your local engine and OpenWork server with versioning, connection health, and repair actions.",
    points: [
      "OpenCode engine ready on localhost:4096",
      "OpenWork server proxied for remote workers",
      "Developer mode enabled for design QA",
    ],
    action: "Reconnect runtime",
  },
  {
    title: "Providers",
    eyebrow: "Models + auth",
    body: "Compact surface for provider connection state, default model choice, and reasoning depth defaults.",
    points: [
      "Anthropic connected",
      "OpenAI connected",
      "Default model: Claude Sonnet 4",
    ],
    action: "Manage providers",
  },
  {
    title: "Remote worker",
    eyebrow: "Cloud worker",
    body: "Connection card for hosted workspaces with URL, token state, and reconnect controls.",
    points: [
      "Worker URL copied into the shell",
      "Last heartbeat 18s ago",
      "Sandbox container detected",
    ],
    action: "Refresh worker",
  },
  {
    title: "Updates",
    eyebrow: "Desktop",
    body: "Patch notes and delivery state for the desktop app, orchestrator, and router sidecars.",
    points: [
      "Auto-check weekly",
      "Download on Wi-Fi only",
      "Restart banner prepared",
    ],
    action: "Check for updates",
  },
];

export const onboardingChoices = [
  {
    title: "Create local workspace",
    detail: "Spin up a local OpenWork folder with starter automations and project memory.",
  },
  {
    title: "Connect remote worker",
    detail: "Attach to a hosted worker using OpenWork URL + token for shared remote execution.",
  },
];

export const screenCopy: Record<StoryScreen, { title: string; detail: string }> = {
  session: {
    title: "Session shell",
    detail: "The full operational canvas: left rail, timeline, composer, utility rail, and status bar.",
  },
  settings: {
    title: "Settings stack",
    detail: "Dense control cards for runtime health, providers, remote workers, and update handling.",
  },
  components: {
    title: "Core components",
    detail: "Buttons, inputs, chips, cards, status rail, and other primitives pulled from the live app language.",
  },
  onboarding: {
    title: "Onboarding",
    detail: "First-run surfaces for theme choice, workspace creation, and remote worker connection.",
  },
};
