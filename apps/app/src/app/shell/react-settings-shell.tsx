import { createElement } from "react";

import type { SettingsShellProps } from "./settings-shell";

function settingsTitle(tab: SettingsShellProps["settingsTab"]) {
  switch (tab) {
    case "automations":
      return "Automations";
    case "skills":
      return "Skills";
    case "extensions":
      return "Extensions";
    case "messaging":
      return "Messaging";
    case "advanced":
      return "Advanced";
    case "appearance":
      return "Appearance";
    case "updates":
      return "Updates";
    case "recovery":
      return "Recovery";
    case "den":
      return "Cloud";
    case "debug":
      return "Debug";
    case "model":
      return "Model";
    default:
      return "General";
  }
}

function workspaceLabel(settings: SettingsShellProps) {
  const workspace = settings.selectedWorkspaceDisplay;
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Workspace"
  );
}

export default function ReactSettingsShell(settings: SettingsShellProps) {
  return createElement(
    "div",
    {
      className:
        "sticky top-0 z-10 flex h-12 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6",
    },
    createElement(
      "div",
      {
        className: "flex min-w-0 items-center gap-3",
      },
      createElement(
        "div",
        {
          className: "truncate text-[15px] font-semibold text-dls-text",
        },
        settingsTitle(settings.settingsTab),
      ),
      createElement(
        "div",
        {
          className: "hidden truncate text-[13px] text-dls-secondary lg:block",
        },
        workspaceLabel(settings),
      ),
      settings.developerMode
        ? createElement(
            "div",
            {
              className: "hidden truncate text-[12px] text-dls-secondary lg:block",
            },
            settings.headerStatus,
          )
        : null,
      settings.busyHint
        ? createElement(
            "div",
            {
              className: "hidden truncate text-[12px] text-dls-secondary lg:block",
            },
            settings.busyHint,
          )
        : null,
    ),
    createElement(
      "button",
      {
        type: "button",
        className:
          "flex h-9 items-center justify-center rounded-md px-3 text-sm text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text",
        onClick: settings.toggleSettings,
        title: "Close settings",
        "aria-label": "Close settings",
      },
      "Close",
    ),
  );
}
