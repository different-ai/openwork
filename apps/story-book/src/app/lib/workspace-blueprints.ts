import type { WorkspaceBlueprint, WorkspaceBlueprintStarter, WorkspaceOpenworkConfig } from "../types";
import { parseTemplateFrontmatter } from "../utils";

import browserSetupTemplate from "../data/commands/browser-setup.md?raw";

const BROWSER_AUTOMATION_QUICKSTART_PROMPT = (() => {
  const parsed = parseTemplateFrontmatter(browserSetupTemplate);
  return (parsed?.body ?? browserSetupTemplate).trim();
})();

export const DEFAULT_EMPTY_STATE_COPY = {
  title: "What do you want to do?",
  body: "Pick a starting point or just type below.",
};

export function defaultBlueprintStartersForPreset(preset: string): WorkspaceBlueprintStarter[] {
  switch (preset.trim().toLowerCase()) {
    case "automation":
      return [
        {
          id: "automation-command",
          kind: "prompt",
          title: "Create a reusable command",
          description: "Turn a repeated workflow into a slash command for this workspace.",
          prompt:
            "Help me create a reusable /command for this workspace. Ask what workflow I want to automate, then draft the command.",
        },
        {
          id: "automation-blueprint",
          kind: "session",
          title: "Plan an automation blueprint",
          description: "Design a repeatable workflow with skills, commands, and handoff steps.",
          prompt:
            "Help me design a reusable automation blueprint for this workspace. Ask what should be standardized, then propose the workflow.",
        },
      ];
    case "minimal":
      return [
        {
          id: "minimal-explore",
          kind: "prompt",
          title: "Explore this workspace",
          description: "Summarize the files and suggest the best first task to tackle.",
          prompt: "Summarize this workspace, point out the most important files, and suggest the best first task.",
        },
      ];
    default:
      return [
        {
          id: "starter-connect-anthropic",
          kind: "action",
          title: "Connect Claude",
          description: "Add your Anthropic provider so Claude models are ready in new sessions.",
          action: "connect-anthropic",
        },
        {
          id: "starter-browser",
          kind: "session",
          title: "Automate your browser",
          description: "Set up browser actions and run reliable web tasks from OpenWork.",
          prompt: BROWSER_AUTOMATION_QUICKSTART_PROMPT,
        },
      ];
  }
}

export function defaultBlueprintCopyForPreset(preset: string) {
  switch (preset.trim().toLowerCase()) {
    case "automation":
      return {
        title: "What do you want to automate?",
        body: "Start from a reusable workflow or type your own task below.",
      };
    case "minimal":
      return {
        title: "Start with a task",
        body: "Ask a question about this workspace or use a starter prompt.",
      };
    default:
      return DEFAULT_EMPTY_STATE_COPY;
  }
}

export function buildDefaultWorkspaceBlueprint(preset: string): WorkspaceBlueprint {
  const copy = defaultBlueprintCopyForPreset(preset);
  return {
    emptyState: {
      title: copy.title,
      body: copy.body,
      starters: defaultBlueprintStartersForPreset(preset),
    },
  };
}

export function normalizeWorkspaceOpenworkConfig(
  value: unknown,
  preset?: string | null,
): WorkspaceOpenworkConfig {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<WorkspaceOpenworkConfig>)
      : {};

  const normalizedPreset =
    candidate.workspace?.preset?.trim() || preset?.trim() || null;

  return {
    version: typeof candidate.version === "number" ? candidate.version : 1,
    workspace:
      candidate.workspace || normalizedPreset
        ? {
            ...(candidate.workspace ?? {}),
            preset: normalizedPreset,
          }
        : null,
    authorizedRoots: Array.isArray(candidate.authorizedRoots)
      ? candidate.authorizedRoots.filter((item): item is string => typeof item === "string")
      : [],
    blueprint: candidate.blueprint ?? null,
    reload: candidate.reload ?? null,
  };
}
