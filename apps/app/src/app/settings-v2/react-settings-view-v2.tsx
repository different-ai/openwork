import { createElement } from "react";

type ReactSettingsViewV2Props = {
  legacySurface: any;
};

const SETTINGS_TABS = [
  "general",
  "models",
  "providers",
  "workspace",
  "plugins",
  "extensions",
  "skills",
  "automations",
  "about",
];

export default function ReactSettingsViewV2(props: ReactSettingsViewV2Props) {
  const surface = props.legacySurface;
  const selectedTab = typeof surface.settingsTab === "string" ? surface.settingsTab : "general";
  const setTab =
    typeof surface.setSettingsTab === "function" ? surface.setSettingsTab : (_: string) => {};

  return createElement(
    "div",
    {
      className:
        "h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 md:p-4 text-gray-12 font-sans",
    },
    createElement(
      "div",
      {
        className:
          "mx-auto flex h-full w-full max-w-[1200px] flex-col gap-3 rounded-[24px] border border-dls-border bg-dls-surface p-4 shadow-[var(--dls-shell-shadow)]",
      },
      createElement(
        "div",
        { className: "flex items-center justify-between border-b border-dls-border pb-3" },
        createElement(
          "div",
          { className: "min-w-0" },
          createElement(
            "h1",
            { className: "truncate text-base font-semibold text-dls-text" },
            "Settings",
          ),
          createElement(
            "p",
            { className: "truncate text-xs text-dls-secondary" },
            `React Settings V2 · ${surface.selectedWorkspaceDisplay?.displayName || surface.selectedWorkspaceDisplay?.name || "Workspace"}`,
          ),
        ),
        createElement(
          "button",
          {
            type: "button",
            className:
              "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text",
            onClick: () => {
              if (typeof surface.setView === "function") {
                surface.setView("session");
              }
            },
          },
          "Back to session",
        ),
      ),
      createElement(
        "div",
        { className: "flex min-h-0 flex-1 gap-3" },
        createElement(
          "aside",
          {
            className:
              "w-[250px] shrink-0 overflow-auto rounded-xl border border-dls-border bg-dls-sidebar p-2.5",
          },
          SETTINGS_TABS.map((tab) =>
            createElement(
              "button",
              {
                key: tab,
                type: "button",
                className: `mb-1 w-full rounded-md px-2.5 py-2 text-left text-xs ${
                  selectedTab === tab
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                }`,
                onClick: () => setTab(tab),
              },
              tab,
            ),
          ),
        ),
        createElement(
          "section",
          {
            className:
              "min-h-0 flex-1 overflow-auto rounded-xl border border-dls-border bg-dls-surface p-4",
          },
          createElement(
            "div",
            { className: "space-y-3" },
            createElement(
              "div",
              {
                className:
                  "rounded-lg border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text",
              },
              `Current tab: ${selectedTab}`,
            ),
            createElement(
              "div",
              {
                className:
                  "rounded-lg border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text",
              },
              `Connection status: ${surface.clientConnected ? "connected" : "disconnected"}`,
            ),
            createElement(
              "div",
              {
                className:
                  "rounded-lg border border-dls-border bg-dls-hover/40 px-3 py-2 text-sm text-dls-text",
              },
              `OpenWork server: ${surface.openworkServerStatus || "unknown"}`,
            ),
            createElement(
              "div",
              { className: "flex flex-wrap gap-2" },
              createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary hover:bg-dls-hover hover:text-dls-text",
                  onClick: () => {
                    if (typeof surface.openProviderAuthModal === "function") {
                      void surface.openProviderAuthModal();
                    }
                  },
                },
                "Open providers",
              ),
              createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary hover:bg-dls-hover hover:text-dls-text",
                  onClick: () => {
                    if (typeof surface.openCreateWorkspace === "function") {
                      surface.openCreateWorkspace();
                    }
                  },
                },
                "Create workspace",
              ),
              createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary hover:bg-dls-hover hover:text-dls-text",
                  onClick: () => {
                    if (typeof surface.toggleDeveloperMode === "function") {
                      surface.toggleDeveloperMode();
                    }
                  },
                },
                `Developer mode: ${surface.developerMode ? "on" : "off"}`,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
