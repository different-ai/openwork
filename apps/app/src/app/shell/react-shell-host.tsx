import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactAppShell, { type ReactAppShellProps } from "./react-app-shell";

export default function ReactShellHost(props: ReactAppShellProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const currentView = props.currentView;
    const renderSession = props.renderSession;
    const renderSessionReact = props.renderSessionReact;
    const preferReactSession = props.preferReactSession;
    const renderSettings = props.renderSettings;
    const renderSettingsReact = props.renderSettingsReact;
    const preferReactSettings = props.preferReactSettings;
    const renderOverlays = props.renderOverlays;

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(
      createElement(ReactAppShell, {
        currentView,
        renderSession,
        renderSessionReact,
        preferReactSession,
        renderSettings,
        renderSettingsReact,
        preferReactSettings,
        renderOverlays,
      }),
    );
  });

  onCleanup(() => {
    const currentRoot = root;
    root = undefined;
    if (!currentRoot) return;
    queueMicrotask(() => {
      currentRoot.unmount();
    });
  });

  return <div ref={container} data-openwork-react-shell="" />;
}
