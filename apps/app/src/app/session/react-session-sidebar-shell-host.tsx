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
    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionSidebarShell, props));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-session-sidebar="" />;
}
