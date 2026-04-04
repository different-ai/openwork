import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionSidebarShell, {
  type ReactSessionSidebarShellProps,
} from "./react-session-sidebar-shell";

export default function ReactSessionSidebarShellHost(
  props: ReactSessionSidebarShellProps,
) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const snapshot: ReactSessionSidebarShellProps = {
      leftSidebarWidth: props.leftSidebarWidth,
      showUpdatePill: props.showUpdatePill,
      updatePillLabel: props.updatePillLabel,
      updatePillTitle: props.updatePillTitle,
      updateVersion: props.updateVersion,
      onUpdatePillClick: props.onUpdatePillClick,
      onStartResize: props.onStartResize,
      renderSidebar: props.renderSidebar,
    };

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionSidebarShell, snapshot));
  });

  onCleanup(() => {
    const currentRoot = root;
    root = undefined;
    if (!currentRoot) return;
    queueMicrotask(() => {
      currentRoot.unmount();
    });
  });

  return <div ref={container} data-openwork-react-session-sidebar="" />;
}
