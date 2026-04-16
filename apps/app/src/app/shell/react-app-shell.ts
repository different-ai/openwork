import type { JSX } from "solid-js";
import { Fragment, createElement } from "react";

import { SolidSlot } from "./solid-slot";

export type ReactAppShellProps = {
  currentView: "session" | "settings";
  renderSession: () => JSX.Element;
  renderSessionReact?: (surface?: any) => any;
  sessionReactSurface?: any;
  preferReactSession?: boolean;
  renderSettings: () => JSX.Element;
  renderSettingsReact?: (surface?: any) => any;
  settingsReactSurface?: any;
  preferReactSettings?: boolean;
  renderOverlays?: () => JSX.Element;
};

export default function ReactAppShell(props: ReactAppShellProps) {
  return createElement(
    Fragment,
    null,
    props.currentView === "session"
      ? props.preferReactSession && props.renderSessionReact
        ? props.renderSessionReact(props.sessionReactSurface)
        : createElement(SolidSlot, {
            slotId: "session-surface",
            renderContent: props.renderSession,
          })
      : props.preferReactSettings && props.renderSettingsReact
        ? props.renderSettingsReact(props.settingsReactSurface)
        : createElement(SolidSlot, {
            slotId: "settings-surface",
            renderContent: props.renderSettings,
          }),
    props.renderOverlays
      ? createElement(SolidSlot, {
          slotId: "shell-overlays",
          renderContent: props.renderOverlays,
        })
      : null,
  );
}
