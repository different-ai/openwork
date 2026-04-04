import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionHeader, {
  type ReactSessionHeaderProps,
} from "./react-session-header";

export default function ReactSessionHeaderHost(props: ReactSessionHeaderProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const snapshot: ReactSessionHeaderProps = {
      title: props.title,
      workspaceLabel: props.workspaceLabel,
      developerMode: props.developerMode,
      headerStatus: props.headerStatus,
      busyHint: props.busyHint,
      showUpdatePill: props.showUpdatePill,
      updatePillLabel: props.updatePillLabel,
      updatePillTitle: props.updatePillTitle,
      updateVersion: props.updateVersion,
      onUpdatePillClick: props.onUpdatePillClick,
      onOpenSettings: props.onOpenSettings,
      renderActions: props.renderActions,
    };

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionHeader, snapshot));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-session-header="" />;
}
