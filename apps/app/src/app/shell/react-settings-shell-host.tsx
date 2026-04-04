import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSettingsShell from "./react-settings-shell";
import type { SettingsShellProps } from "./settings-shell";

export default function ReactSettingsShellHost(props: SettingsShellProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSettingsShell, props));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-settings-shell="" />;
}
