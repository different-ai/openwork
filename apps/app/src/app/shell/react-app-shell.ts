import type { JSX } from "solid-js";
import { Fragment, createElement } from "react";

import { SolidSlot } from "./solid-slot";

export type ReactAppShellProps = {
  currentView: "session" | "settings";
  renderSession: () => JSX.Element;
  renderSettings: () => JSX.Element;
  renderOverlays?: () => JSX.Element;
};

export default function ReactAppShell(props: ReactAppShellProps) {
  return createElement(
    Fragment,
    null,
    props.currentView === "session"
      ? createElement(SolidSlot, {
          slotId: "session-surface",
          renderContent: props.renderSession,
        })
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
