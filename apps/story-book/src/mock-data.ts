import type { Part } from "@opencode-ai/sdk/v2/client";

import type { MessageWithParts } from "../../app/src/app/types";
import type { WorkspaceInfo } from "../../app/src/app/lib/tauri";

export type StoryScreen = "session" | "settings" | "components" | "onboarding";

export type StoryStep = {
  label: string;
  detail: string;
  state: "done" | "active" | "queued";
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

const baseTime = Date.now() - 12 * 60 * 1000;

function messageInfo(
  id: string,
  role: "user" | "assistant",
  createdOffsetMs: number,
): MessageWithParts["info"] {
  return {
    id,
    sessionID: "story-shell-session",
    role,
    time: {
      created: baseTime + createdOffsetMs,
      ...(role === "assistant"
        ? { completed: baseTime + createdOffsetMs + 20_000 }
        : {}),
    },
  } as MessageWithParts["info"];
}

function toolPart(
  tool: string,
  status: "completed" | "running" | "pending" | "error",
  input: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Part {
  return {
    type: "tool",
    tool,
    state: {
      status,
      input,
      ...extras,
    },
  } as Part;
}

export const sessionMessages: MessageWithParts[] = [
  {
    info: messageInfo("sb-msg-1", "user", 0),
    parts: [
      {
        type: "text",
        text:
          "Build a faithful story-book for the OpenWork app so we can iterate on the shell, session timeline, settings cards, and onboarding without touching the live runtime. Also make the mocked transcript feel closer to a real OpenWork session, including tool activity.",
      } as Part,
    ],
  },
  {
    info: messageInfo("sb-msg-2", "assistant", 25_000),
    parts: [
      {
        type: "text",
        text:
          "I audited the live session surface first so the mock keeps the same shell proportions, transcript rhythm, and action rail behavior.",
      } as Part,
      toolPart(
        "read",
        "completed",
        {
          filePath: "apps/app/src/app/pages/session.tsx",
          offset: 4246,
          limit: 220,
        },
        {
          output: "Reviewed the live session header, command strip, and transcript layout bindings.",
        },
      ),
      toolPart(
        "grep",
        "completed",
        {
          pattern: "tool|Command\\+K|compactSessionHistory|MessageList",
          path: "apps/app/src/app",
        },
        {
          output: "Found the real message timeline and tool summary helpers in message-list.tsx and utils/index.ts.",
        },
      ),
      {
        type: "reasoning",
        text:
          "Thinking: the mock should not invent a separate timeline widget. The fastest way to reach parity is to feed richer fake parts into the exact same MessageList surface the app already uses.",
      } as Part,
      {
        type: "text",
        text:
          "That keeps the story-book useful for UI decisions while avoiding a parallel rendering path that could drift from the real app.",
      } as Part,
    ],
  },
  {
    info: messageInfo("sb-msg-3", "assistant", 70_000),
    parts: [
      {
        type: "text",
        text:
          "I then mocked a more realistic execution pass so the story transcript shows the same kinds of steps users see in production.",
      } as Part,
      toolPart(
        "apply_patch",
        "completed",
        {
          filePath: "apps/story-book/src/story-book.tsx",
        },
        {
          output: "Success. Updated the following files: M apps/story-book/src/story-book.tsx",
        },
      ),
      toolPart(
        "bash",
        "completed",
        {
          command: "pnpm --filter story-book build",
          description: "Build story-book app to verify compile",
        },
        {
          output:
            "vite v6.4.1 building for production...\n✓ 1966 modules transformed.\n✓ built in 2.95s",
        },
      ),
      toolPart(
        "task",
        "completed",
        {
          description: "Review session tool-call fidelity",
          subagent_type: "explore",
        },
        {
          metadata: {
            sessionId: "story-subagent-session",
          },
          output:
            "Subagent reviewed the session transcript surface and recommended using the live MessageList grouping semantics.",
        },
      ),
      {
        type: "text",
        text:
          "The result is still mocked data, but the transcript now exercises the real tool-call affordances: exploration summaries, individual action rows, and post-action assistant copy.",
      } as Part,
    ],
  },
  {
    info: messageInfo("sb-msg-4", "assistant", 105_000),
    parts: [
      {
        type: "text",
        text:
          "Next pass, we can add a few alternate transcript scenarios here too: running tools, failed commands, and a nested subagent thread with its own mini timeline.",
      } as Part,
    ],
  },
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
