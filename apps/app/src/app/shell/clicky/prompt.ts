import type { OpenworkServerStatus } from "../../lib/openwork-server";
import type { SettingsTab, View, WorkspaceDisplay } from "../../types";

export type ClickyContext = {
  appVersion: string | null;
  currentView: View;
  developerMode: boolean;
  hasConnectedProvider: boolean;
  openworkServerStatus: OpenworkServerStatus;
  settingsTab: SettingsTab;
  workspace: WorkspaceDisplay;
};

export type ClickySuggestion = {
  id: string;
  label: string;
  question: string;
};

const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  den: "Cloud",
  automations: "Automations",
  skills: "Skills",
  extensions: "Extensions",
  messaging: "Messaging",
  advanced: "Advanced",
  appearance: "Appearance",
  updates: "Updates",
  recovery: "Recovery",
  debug: "Debug",
};

function workspaceLabel(workspace: WorkspaceDisplay) {
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.directory?.trim() ||
    workspace.path?.trim() ||
    "current workspace"
  );
}

export function clickySurfaceLabel(context: ClickyContext) {
  if (context.currentView === "session") {
    return "Session";
  }
  return `Settings > ${SETTINGS_TAB_LABELS[context.settingsTab]}`;
}

export function buildClickySuggestions(context: ClickyContext): ClickySuggestion[] {
  const suggestions: ClickySuggestion[] = [];

  if (!context.hasConnectedProvider) {
    suggestions.push({
      id: "connect-provider",
      label: "Connect a model",
      question: "How do I connect a model provider so I can start using OpenWork?",
    });
  }

  suggestions.push({
    id: "connect-remote-worker",
    label: "Connect a remote worker",
    question: "How do I connect a remote worker from the OpenWork app?",
  });

  if (context.currentView === "session") {
    suggestions.push({
      id: "session-tools",
      label: "Use files and tools",
      question: "How do I use files, skills, commands, and browser tools from a session in OpenWork?",
    });
    suggestions.push({
      id: "session-reuse",
      label: "Make this reusable",
      question: "How do I turn a repeated workflow in OpenWork into a reusable skill or command?",
    });
    return suggestions.slice(0, 4);
  }

  if (context.settingsTab === "skills") {
    suggestions.push({
      id: "skills",
      label: "Install a skill",
      question: "How do I install or share a skill from this OpenWork workspace?",
    });
  } else if (context.settingsTab === "extensions") {
    suggestions.push({
      id: "extensions",
      label: "Add MCP or plugin",
      question: "How do I add an MCP server or plugin from the OpenWork app?",
    });
  } else if (context.settingsTab === "advanced") {
    suggestions.push({
      id: "advanced",
      label: "Connect OpenWork server",
      question: "How do I connect this app to an OpenWork server and know whether it is writable?",
    });
  } else {
    suggestions.push({
      id: "screen-help",
      label: "Use this screen",
      question: `What can I do from ${clickySurfaceLabel(context)} in OpenWork?`,
    });
  }

  return suggestions.slice(0, 4);
}

export function buildClickyPrompt(question: string, context: ClickyContext) {
  const workspaceType = context.workspace.workspaceType === "remote" ? "remote worker" : "local worker";
  const providerState = context.hasConnectedProvider ? "at least one provider is connected" : "no providers are connected";
  const versionLine = context.appVersion?.trim() ? `- App version: ${context.appVersion.trim()}` : null;

  return [
    "You are Clicky, an experimental in-app OpenWork guide.",
    "Your job is to help the user accomplish tasks inside the OpenWork app using the exact UI names and product vocabulary when possible.",
    "Be concise and practical. Prefer the fastest path that matches the current surface.",
    "If the user is on the wrong screen, say that first and name the correct screen or settings tab.",
    "If a prerequisite is missing, call it out before the steps.",
    "Use OpenWork terms consistently: OpenWork app, OpenWork server, worker, session, skill, command, plugin, MCP.",
    "Known product facts:",
    "- Main app surfaces are Session and Settings.",
    "- Settings tabs include General, Cloud, Automations, Skills, Extensions, Messaging, Advanced, Appearance, Updates, Recovery, and Debug.",
    "- Connecting a hosted or remote worker follows Add a worker -> Connect remote.",
    "- Local filesystem and config changes should generally go through OpenWork server surfaces when available.",
    "Current app context:",
    `- Surface: ${clickySurfaceLabel(context)}`,
    `- Workspace: ${workspaceLabel(context.workspace)} (${workspaceType})`,
    `- OpenWork server status: ${context.openworkServerStatus}`,
    `- Provider state: ${providerState}`,
    `- Developer mode: ${context.developerMode ? "on" : "off"}`,
    ...(versionLine ? [versionLine] : []),
    "",
    `User question: ${question.trim()}`,
    "",
    "Reply format:",
    "1. Best next step",
    "2. Exact clicks, buttons, or settings tabs to use",
    "3. One short caveat or prerequisite if needed",
  ].join("\n");
}
