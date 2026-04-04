import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactAppShell, { type ReactAppShellProps } from "./react-app-shell";

export default function ReactShellHost(props: ReactAppShellProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactAppShell, props));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-shell="" />;
}
